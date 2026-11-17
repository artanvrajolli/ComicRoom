const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/script/readingList.js'), 'utf8');

function page(online = true) {
    const events = {};
    let reloads = 0;
    const document = { visibilityState: 'hidden', addEventListener(name, fn) { events[name] = fn; } };
    vm.runInNewContext(source, {
        navigator: { onLine: online }, document,
        window: { location: { reload() { reloads++; } }, addEventListener(name, fn) { events[name] = fn; } }
    });
    return { events, document, reloads: () => reloads };
}

test('normal navigation keeps the fresh server response', () => {
    const state = page();
    state.events.pageshow({ persisted: false });
    assert.equal(state.reloads(), 0);
});

test('Back restoration refreshes the reading order once, even with a visibility event', () => {
    const state = page();
    state.events.pageshow({ persisted: true });
    state.document.visibilityState = 'visible';
    state.events.visibilitychange();
    assert.equal(state.reloads(), 1);
});

test('returning to a background reading-list tab refreshes it', () => {
    const state = page();
    state.events.visibilitychange();
    assert.equal(state.reloads(), 0);
    state.document.visibilityState = 'visible';
    state.events.visibilitychange();
    assert.equal(state.reloads(), 1);
});

test('offline Back navigation retains the saved reading list', () => {
    const state = page(false);
    state.events.pageshow({ persisted: true });
    state.document.visibilityState = 'visible';
    state.events.visibilitychange();
    assert.equal(state.reloads(), 0);
});
