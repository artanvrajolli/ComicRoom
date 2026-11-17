const { test } = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns').promises;
const https = require('https');
const { EventEmitter } = require('events');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const importer = require('./urlImport');

test('keeps DOM page order and reads generic serialized reader state', () => {
    assert.deepEqual(importer.orderedImages({ images: ['https://images.example/2.jpg', 'https://images.example/1.jpg'], rawHtml: '<img src="https://images.example/1.jpg"><img src="https://images.example/2.jpg">' }, 'https://source.example', ''), ['https://images.example/1.jpg', 'https://images.example/2.jpg']);
    const pages = ['https://images.example/1.jpg', 'https://images.example/2.jpg', 'https://images.example/3.jpg'];
    const data = { images: [pages[0]], rawHtml: '<script>window.readerState=' + JSON.stringify({ images: [...pages, 'https://images.example/extra.jpg'], pages: 3 }) + ';</script>' };
    assert.deepEqual(importer.orderedImages(data, 'https://source.example/chapter', ''), pages);
    assert.deepEqual(importer.orderedImages(data, 'https://source.example/chapter', '.other'), [pages[0]]);
    const unrelated = { ...data, rawHtml: '<script type="application/json">{"images":["https://other.example/1.jpg"],"pages":1}</script>' };
    assert.deepEqual(importer.orderedImages(unrelated, 'https://source.example/chapter', ''), [pages[0]]);
});

test('rejects unsafe protocols, credentials, ports and non-public networks', async () => {
    for (const url of ['file:///etc/passwd', 'https://user:pass@source.example', 'http://source.example:8082']) {
        assert.throws(() => importer.parsePublicUrl(url));
    }
    for (const host of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '[::1]', '[::ffff:127.0.0.1]', '[fc00::1]', '[2002:7f00:1::]']) {
        await assert.rejects(importer.resolvePublicUrl('http://' + host), /public internet/);
    }
});

test('discovery upgrades gallery thumbnails to originals before returning import choices', async () => {
    const originalFetch = global.fetch, originalLookup = dns.lookup;
    dns.lookup = async () => [{ address: '203.0.113.10', family: 4 }];
    global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: {
        images: ['https://source.example/thumbs/001.jpg'],
        rawHtml: '<a href="/originals/001.jpg?sig=abc&amp;size=full"><img src="/thumbs/001.jpg"></a>'
    } }) });
    try {
        const result = await importer.discoverImages('https://source.example/chapter');
        assert.deepEqual(result.images, ['https://source.example/originals/001.jpg?sig=abc&size=full']);
    } finally { global.fetch = originalFetch; dns.lookup = originalLookup; }
});

test('old thumbnail selections are refused before an import creates any pages', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'comicroom-no-thumbs-'));
    try {
        const manifest = path.join(directory, 'manifest.json');
        await fs.writeFile(manifest, JSON.stringify({ source: 'https://source.example/chapter', images: ['https://source.example/thumbs/001.jpg'] }));
        await assert.rejects(importer.importImages(manifest, path.join(directory, 'pages'), async () => {}), /Thumbnail previews cannot be imported/);
        assert.deepEqual(await fs.readdir(directory), ['manifest.json']);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('discovers deduplicated public images and reports Firecrawl failures', async () => {
    const originalFetch = global.fetch;
    const originalLookup = dns.lookup;
    dns.lookup = async () => [{ address: '203.0.113.10', family: 4 }];
    try {
        global.fetch = async (_url, options) => {
            const body = JSON.parse(options.body);
            assert.deepEqual(body.formats, ['images', 'rawHtml']);
            assert.deepEqual(body.includeTags, ['.reader img']);
            return { ok: true, json: async () => ({ success: true, data: { metadata: { title: 'Chapter one', statusCode: 200 }, images: ['/1.png', '/1.png', 'http://127.0.0.1/private.png', '/2.png', 'data:image/png;base64,abc'] } }) };
        };
        const result = await importer.discoverImages('https://source.example/chapter', '.reader img');
        assert.deepEqual(result.images, ['https://source.example/1.png', 'https://source.example/2.png']);
        global.fetch = async () => ({ ok: false, status: 402 });
        await assert.rejects(importer.discoverImages('https://source.example'), /API key/);
        global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: { images: [], metadata: { statusCode: 403 } } }) });
        await assert.rejects(importer.discoverImages('https://source.example'), /could not load/);
    } finally { global.fetch = originalFetch; dns.lookup = originalLookup; }
});

test('uses the custom server first and keeps hosted credentials on the hosted endpoint', async () => {
    const originalFetch = global.fetch;
    const originalLookup = dns.lookup;
    const oldKey = process.env.FIRECRAWL_API_KEY;
    const oldCustom = process.env.FIRECRAWL_CUSTOM_API_KEY;
    const oldUrl = process.env.FIRECRAWL_API_URL;
    process.env.FIRECRAWL_API_URL = 'https://firecrawl.example/v2/scrape';
    process.env.FIRECRAWL_API_KEY = 'hosted-test-key';
    delete process.env.FIRECRAWL_CUSTOM_API_KEY;
    dns.lookup = async () => [{ address: '203.0.113.10', family: 4 }];
    const calls = [];
    global.fetch = async (url, options) => {
        calls.push(url);
        if (new URL(url).hostname !== 'api.firecrawl.dev') {
            assert.equal(options.headers.Authorization, undefined);
            return { ok: true, json: async () => ({ success: true, data: { metadata: { statusCode: 404 } } }) };
        }
        assert.equal(options.headers.Authorization, 'Bearer hosted-test-key');
        return { ok: true, json: async () => ({ success: true, data: { images: ['https://source.example/1.png'] } }) };
    };
    try {
        await importer.discoverImages('https://source.example/chapter');
        assert.equal(calls.length, 2);
        assert.equal(new URL(calls[0]).hostname, 'firecrawl.example');
    } finally {
        global.fetch = originalFetch; dns.lookup = originalLookup;
        if (oldKey === undefined) delete process.env.FIRECRAWL_API_KEY; else process.env.FIRECRAWL_API_KEY = oldKey;
        if (oldCustom === undefined) delete process.env.FIRECRAWL_CUSTOM_API_KEY; else process.env.FIRECRAWL_CUSTOM_API_KEY = oldCustom;
        if (oldUrl === undefined) delete process.env.FIRECRAWL_API_URL; else process.env.FIRECRAWL_API_URL = oldUrl;
    }
});

test('browser fallback enables media, preserves order and rejects blank placeholders', async () => {
    const originalFetch = global.fetch;
    const originalLookup = dns.lookup;
    dns.lookup = async () => [{ address: '203.0.113.10', family: 4 }];
    const { createCanvas } = require('@napi-rs/canvas');
    const canvas = createCanvas(10, 20);
    const urls = ['https://source.example/1.png', 'https://source.example/2.png'];
    const fullImage = canvas.toDataURL();
    let placeholder = false;
    global.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.deepEqual(body.formats, [{ type: 'screenshot', fullPage: false }]);
        assert.match(body.actions[1].script, /redirect: 'error'/);
        return { ok: true, json: async () => ({ success: true, data: {
            actions: { javascriptReturns: [{ value: urls.map(url => ({ url, data: placeholder ? createCanvas(1, 1).toDataURL() : fullImage })) }] }
        } }) };
    };
    try {
        const result = await importer.downloadBrowserBatch(urls, 'https://source.example/chapter');
        assert.equal(result.buffers.length, 2);
        assert.equal(importer.imageExtension(result.buffers[0]), 'png');
        placeholder = true;
        await assert.rejects(importer.downloadBrowserBatch(urls, 'https://source.example/chapter'), /placeholder/);
    } finally { global.fetch = originalFetch; dns.lookup = originalLookup; }
});

test('pins DNS, blocks redirect to local services, stages ordered images and cleans failed imports', async () => {
    const originalGet = https.get;
    const originalFetch = global.fetch;
    const originalLookup = dns.lookup;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'comicroom-url-test-'));
    dns.lookup = async () => [{ address: '203.0.113.10', family: 4 }];
    let mode = 'image';
    https.get = (url, options, callback) => {
        options.lookup(url.hostname, {}, (_err, address) => assert.equal(address, '203.0.113.10'));
        const request = new EventEmitter();
        request.destroy = error => request.emit('error', error);
        process.nextTick(() => {
            const response = new EventEmitter();
            response.resume = () => {};
            response.statusCode = mode === 'redirect' ? 302 : mode === 'blocked' ? 403 : 200;
            response.headers = mode === 'redirect' ? { location: 'http://127.0.0.1/admin' } : {};
            callback(response);
            response.emit('data', mode === 'html' ? Buffer.from('<html>blocked</html>') : require('@napi-rs/canvas').createCanvas(20, 30).toBuffer('image/png'));
            response.emit('end');
            request.emit('close');
        });
        return request;
    };
    try {
        mode = 'redirect';
        await assert.rejects(importer.downloadImage('https://source.example/page', 'https://source.example'), /public internet/);
        const manifest = path.join(directory, 'manifest.json');
        await fs.writeFile(manifest, JSON.stringify({ source: 'https://source.example/chapter', images: ['https://source.example/2', 'https://source.example/1'] }));
        mode = 'image';
        const progress = [];
        await importer.importImages(manifest, path.join(directory, 'pages'), async value => progress.push(value));
        assert.deepEqual(await fs.readdir(path.join(directory, 'pages')), ['0001.png', '0002.png']);
        assert.deepEqual(progress, [30, 50]);
        mode = 'html';
        await assert.rejects(importer.importImages(manifest, path.join(directory, 'failed'), async () => {}), /supported image/);
        assert.deepEqual((await fs.readdir(directory)).sort(), ['manifest.json', 'pages']);
        mode = 'blocked';
        const realImage = require('@napi-rs/canvas').createCanvas(20, 30).toDataURL();
        global.fetch = async () => ({ ok: true, json: async () => ({ success: true, data: {
            actions: { javascriptReturns: [{ value: ['https://source.example/2', 'https://source.example/1'].map(url => ({ url, data: realImage })) }] }
        } }) });
        await importer.importImages(manifest, path.join(directory, 'fallback'), async () => {});
        assert.deepEqual(await fs.readdir(path.join(directory, 'fallback')), ['0001.png', '0002.png']);
    } finally {
        dns.lookup = originalLookup; https.get = originalGet; global.fetch = originalFetch;
        await fs.rm(directory, { recursive: true, force: true });
    }
});
