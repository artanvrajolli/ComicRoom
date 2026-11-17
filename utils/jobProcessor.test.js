const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function fixture(failWorker = false) {
    const updates = [], comics = [], removed = [], warmed = [];
    let privacyRefreshed = false;
    const job = { jobId: 'fixture', userId: 7, comicFolderId: 'comic_fixture',
        tempFilePath: path.join(process.cwd(), 'public/tmp/fixture.cbz'), fileName: 'fixture.cbz', extension: 'cbz',
        makePrivate: true, status: 'pending', async update(values) {
            if (values.status === 'completed') assert(privacyRefreshed, 'Privacy must be refreshed before publishing completion');
            updates.push(values); Object.assign(this, values);
        }
    };
    const mocks = {
        fs: {
            existsSync() { throw new Error('Synchronous I/O reached the web process'); },
            mkdirSync() { throw new Error('Synchronous I/O reached the web process'); },
            renameSync() { throw new Error('Synchronous I/O reached the web process'); },
            unlinkSync() { throw new Error('Synchronous I/O reached the web process'); },
            promises: { async lstat() { return { isFile: () => true }; }, async unlink(file) { removed.push(file); } }
        },
        path,
        './comicProcessing': { stop() {}, async run(data, progress) {
            assert.deepEqual(data.knownTitles, ['Known title']);
            if (failWorker) throw new Error('Comic processing worker exited');
            for (const value of [30, 60, 90]) await progress(value);
            return { comics: [1, 2].map(i => ({ savedFolder: 'comic_fixture/part' + i,
                title: 'Issue ' + i, author: 'Writer', description: '', coverImage: '001.jpg', totalPages: 4 })) };
        } },
        '../model/m_comic': { async findAll() { return [{ title: 'Known title' }]; },
            async create(data) { const row = { id: 500 + comics.length, ...data }; comics.push(row); return row; } },
        '../model/m_uploadJob': { async findOne() { return job; } },
        './comicStorage': { invalidateComicAssets() {} },
        './thumbnails': { warmThumbnail(comic) { warmed.push(comic.id); } },
        './comicAccess': { async refreshPrivateFolders() { privacyRefreshed = true; } },
        sequelize: { Op: { ne: Symbol('ne') } }
    };
    const module = { exports: {} };
    new Function('require', 'module', 'exports', '__dirname', fs.readFileSync(path.join(__dirname, 'jobProcessor.js'), 'utf8'))(
        name => { if (!(name in mocks)) throw new Error('Unexpected dependency in HTTP job coordinator: ' + name); return mocks[name]; },
        module, module.exports, __dirname);
    return { processor: module.exports, job, updates, comics, removed, warmed };
}

test('background preparation publishes every bundle part with privacy and ordered progress, without synchronous disk I/O', async () => {
    const state = fixture();
    await state.processor.processNextJob();
    assert.equal(state.job.status, 'completed');
    assert.equal(state.job.resultComicIds, '500,501');
    assert.equal(state.job.comicId, 500);
    assert.equal(state.comics.length, 2);
    assert(state.comics.every(comic => comic.isPrivate && comic.uid === 7));
    const progress = state.updates.filter(update => 'progress' in update).map(update => update.progress);
    assert(progress.every((value, i) => !i || value >= progress[i - 1]));
    assert.equal(progress.at(-1), 100);
    assert.deepEqual(state.removed, [state.job.tempFilePath]);
    assert.deepEqual(state.warmed, [500, 501]);
    assert.equal(state.processor.isProcessing, false);
});

test('a worker crash marks the upload failed, preserves the source file, and releases the queue', async () => {
    const state = fixture(true);
    await state.processor.processNextJob();
    assert.equal(state.job.status, 'failed');
    assert.match(state.job.errorMessage, /worker exited/);
    assert.deepEqual(state.comics, []);
    assert.deepEqual(state.removed, []);
    assert.equal(state.processor.isProcessing, false);
});
