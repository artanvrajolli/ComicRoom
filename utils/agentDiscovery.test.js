const { test } = require('node:test');
const assert = require('node:assert/strict');
const { discoverAgentImages } = require('./agentDiscovery');
const { discoverImages } = require('./urlImport');
const dns = require('node:dns').promises;

const result = { title: 'Comic', complete: true, reason: '', images: ['https://source.example/pages/1.png', 'https://source.example/pages/2.png'] };
const response = value => ({ ok: true, json: async () => value });

test('Agent discovery starts the selected job, polls completion and preserves image order', async () => {
    const original = global.fetch;
    const calls = [];
    let polls = 0;
    global.fetch = async (url, options) => {
        calls.push([String(url), options]);
        if (options.method === 'POST') {
            const body = JSON.parse(options.body);
            assert.deepEqual(body.urls, ['https://source.example/chapter']);
            assert.equal(body.strictConstrainToURLs, true);
            assert.equal(body.maxCredits, 5);
            assert.match(body.prompt, /\.reader img/);
            return response({ success: true, id: 'fixture-job' });
        }
        return response(++polls === 1 ? { success: true, status: 'processing' } : { success: true, status: 'completed', data: result });
    };
    try {
        const found = await discoverAgentImages('https://source.example/chapter', '.reader img', 'https://agent.example/v2/agent', { pollIntervalMs: 0 });
        assert.deepEqual(found.images, result.images);
        assert.equal(calls.length, 3);
        assert.equal(calls[1][0], 'https://agent.example/v2/agent/fixture-job');
    } finally { global.fetch = original; }
});

test('failed or incomplete Agent runs never become partial comic imports', async () => {
    const original = global.fetch;
    try {
        global.fetch = async (_url, options) => response(options.method === 'POST'
            ? { success: true, id: 'fixture-job' } : { success: true, status: 'failed' });
        await assert.rejects(discoverAgentImages('https://source.example', '', 'https://agent.example/v2/agent'), /could not finish/);
        global.fetch = async () => response({ success: true, status: 'completed', data: { ...result, complete: false } });
        await assert.rejects(discoverAgentImages('https://source.example', '', 'https://agent.example/v2/agent'), /complete chapter/);
        global.fetch = async () => response({ success: true, status: 'completed', data: { ...result, images: 'not an array' } });
        await assert.rejects(discoverAgentImages('https://source.example', '', 'https://agent.example/v2/agent'), /invalid image list/);
    } finally { global.fetch = original; }
});

test('timed-out Agent jobs are cancelled', async () => {
    const original = global.fetch;
    let cancelled = false;
    global.fetch = async (_url, options) => {
        if (options.method === 'DELETE') { cancelled = true; return response({ success: true }); }
        if (options.method === 'POST') return response({ success: true, id: 'fixture-job' });
        return response({ success: true, status: 'processing' });
    };
    try {
        await assert.rejects(discoverAgentImages('https://source.example', '', 'https://agent.example/v2/agent', { timeoutMs: 20, pollIntervalMs: 100 }), /took too long/);
        assert(cancelled);
    } finally { global.fetch = original; }
});

test('the selected Agent uses the custom endpoint, keeps hosted credentials private and validates returned URLs', async () => {
    const originalFetch = global.fetch, originalLookup = dns.lookup;
    const previousKey = process.env.FIRECRAWL_API_KEY, previousCustom = process.env.FIRECRAWL_CUSTOM_API_KEY;
    const previousUrl = process.env.FIRECRAWL_API_URL, previousAgent = process.env.FIRECRAWL_AGENT_URL;
    process.env.FIRECRAWL_API_URL = 'https://firecrawl.example/v2/scrape';
    delete process.env.FIRECRAWL_AGENT_URL;
    process.env.FIRECRAWL_API_KEY = 'hosted-only'; delete process.env.FIRECRAWL_CUSTOM_API_KEY;
    dns.lookup = async () => [{ address: '203.0.113.10', family: 4 }];
    let data = { ...result, images: ['/pages/1.png', 'https://source.example/pages/1.png', '/pages/2.png'] };
    global.fetch = async (url, options) => {
        assert.equal(String(url), 'https://firecrawl.example/v2/agent');
        assert.equal(options.headers.Authorization, undefined);
        return response({ success: true, status: 'completed', data });
    };
    try {
        const found = await discoverImages('https://source.example/chapter', '', 'agent');
        assert.equal(found.method, 'agent');
        assert.deepEqual(found.images, result.images);
        data = { ...result, images: ['http://127.0.0.1/private.png'] };
        await assert.rejects(discoverImages('https://source.example/chapter', '', 'agent'), /private image host/);
        data = { ...result, images: ['/thumbs/page.png'] };
        await assert.rejects(discoverImages('https://source.example/chapter', '', 'agent'), /thumbnail previews/);
        data = { ...result, images: ['file:///private.png'] };
        await assert.rejects(discoverImages('https://source.example/chapter', '', 'agent'), /invalid image URLs/);
        await assert.rejects(discoverImages('https://source.example/chapter', '', 'unexpected'), /Choose Scrape or Agent/);
    } finally {
        global.fetch = originalFetch; dns.lookup = originalLookup;
        if (previousKey === undefined) delete process.env.FIRECRAWL_API_KEY; else process.env.FIRECRAWL_API_KEY = previousKey;
        if (previousCustom === undefined) delete process.env.FIRECRAWL_CUSTOM_API_KEY; else process.env.FIRECRAWL_CUSTOM_API_KEY = previousCustom;
        if (previousUrl === undefined) delete process.env.FIRECRAWL_API_URL; else process.env.FIRECRAWL_API_URL = previousUrl;
        if (previousAgent === undefined) delete process.env.FIRECRAWL_AGENT_URL; else process.env.FIRECRAWL_AGENT_URL = previousAgent;
    }
});
