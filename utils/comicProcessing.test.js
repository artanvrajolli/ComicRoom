const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { ComicProcessing } = require('./comicProcessing');

const workerPath = path.join(__dirname, 'fixtures', 'blockingComicWorker.cjs');

test('HTTP requests stay responsive during blocking comic work, and progress saves finish before completion', async () => {
    const processor = new ComicProcessing({ workerPath });
    const server = http.createServer((_req, res) => res.end('responsive'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let started;
    const blockingStarted = new Promise(resolve => { started = resolve; });
    const progress = [];
    const work = processor.run({}, async value => {
        if (value === 30) started();
        await new Promise(resolve => setTimeout(resolve, 30));
        progress.push(value);
    });
    try {
        await blockingStarted;
        await assert.rejects(processor.run({}), /already running/);
        const start = performance.now();
        const replies = await Promise.all(Array.from({ length: 5 }, async () => {
            const response = await fetch('http://127.0.0.1:' + server.address().port);
            return response.text();
        }));
        assert.deepEqual(replies, Array(5).fill('responsive'));
        assert(performance.now() - start < 600, 'HTTP should reply before the 800ms synchronous task finishes');
        const result = await work;
        assert.notEqual(result.pid, process.pid);
        assert.deepEqual(progress, [30, 60]);
    } finally { processor.stop(); server.closeAllConnections(); server.close(); }
});

test('archive errors and worker crashes reject the job and allow later jobs to run', async () => {
    const processor = new ComicProcessing({ workerPath });
    try {
        await assert.rejects(processor.run({ kind: 'error' }), /Corrupt archive fixture/);
        const first = await processor.run({});
        await assert.rejects(processor.run({ kind: 'crash' }), /worker exited/);
        const second = await processor.run({});
        assert.notEqual(second.pid, first.pid);
        await assert.rejects(processor.run({}, async () => { throw new Error('Progress database unavailable'); }), /database unavailable/);
        assert(await processor.run({}));
    } finally { processor.stop(); }
});

test('the real worker prepares normal and nested CBZ uploads without database or AI calls', async () => {
    const AdmZip = require('adm-zip');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'comicroom-processing-'));
    const processor = new ComicProcessing({ cwd: root, env: {
        ...process.env, AI_SETTINGS_FILE: path.join(root, 'no-ai-settings.json'),
        COMMANDCODE_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: ''
    } });
    try {
        const archive = new AdmZip();
        // Bundle planning needs image file names, not pixel decoding, when AI is off.
        for (let i = 1; i <= 4; i++) archive.addFile(String(i).padStart(3, '0') + '.jpg', Buffer.from('fixture image'));
        const archivePath = path.join(root, 'Story 01.cbz');
        await fs.writeFile(archivePath, archive.toBuffer());
        const progress = [];
        const single = await processor.run({ jobId: 'fixture', tempFilePath: archivePath,
            comicFolderId: 'comic_100', fileName: 'Story 01.cbz', extension: 'cbz', knownTitles: []
        }, async value => progress.push(value));
        assert.equal(single.comics.length, 1);
        assert.equal(single.comics[0].totalPages, 4);
        assert.equal(single.comics[0].coverImage, '001.jpg');
        assert.equal((await fs.readdir(path.join(root, 'public/uploads/comic_100'))).length, 4);
        assert(progress.every((value, i) => i === 0 || value >= progress[i - 1]));
        const bundle = new AdmZip();
        bundle.addFile('Story 01.cbz', archive.toBuffer());
        bundle.addFile('Story 02.cbz', archive.toBuffer());
        const bundlePath = path.join(root, 'bundle.zip');
        await fs.writeFile(bundlePath, bundle.toBuffer());
        const result = await processor.run({ jobId: 'bundle', tempFilePath: bundlePath,
            comicFolderId: 'comic_200', fileName: 'bundle.zip', extension: 'zip', knownTitles: []
        });
        assert.equal(result.comics.length, 2);
        assert(result.comics.every(comic => comic.totalPages === 4));
        const invalid = path.join(root, 'bad.cbz');
        await fs.writeFile(invalid, 'not an archive');
        await assert.rejects(processor.run({ tempFilePath: invalid, comicFolderId: 'comic_300', fileName: 'bad.cbz', extension: 'cbz' }), /valid ZIP/);
    } finally { processor.stop(); await fs.rm(root, { recursive: true, force: true }); }
});
