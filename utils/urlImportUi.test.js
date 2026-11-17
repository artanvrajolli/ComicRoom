const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/script/urlImport.js'), 'utf8');

function page(method = 'scrape') {
    function element() { return { events: {}, style: {}, children: [], hidden: false,
        addEventListener(type, handler) { this.events[type] = handler; },
        replaceChildren() { this.children = []; }, append(...children) { this.children.push(...children); }, setAttribute() {}
    }; }
    const nodes = Object.fromEntries(['urlDiscoverForm', 'urlImagesForm', 'urlImageList', 'urlImportMessage', 'findUrlImages', 'startUrlImport', 'importMethod', 'importUrl', 'importSelector', 'urlComicTitle', 'urlSelectAll', 'urlSelectNone'].map(id => [id, element()]));
    nodes.importMethod.value = method;
    if (method === null) delete nodes.importMethod;
    nodes.importUrl.value = 'https://source.example/chapter';
    nodes.importSelector.value = '';
    nodes.urlImagesForm.hidden = true;
    const calls = [];
    vm.runInNewContext(source, {
        document: { getElementById: id => nodes[id], createElement: element },
        fetch: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return {
            ok: true, json: async () => ({ source: 'https://source.example/chapter', title: 'Comic', images: ['https://source.example/1.png'] })
        }; }, location: { assign() {} }
    });
    return { nodes, calls, find: () => nodes.urlDiscoverForm.events.submit({ preventDefault() {} }) };
}

test('Scrape is sent for the default and legacy upload form', async () => {
    for (const method of ['scrape', null]) {
        const state = page(method);
        await state.find();
        assert.equal(state.calls[0].body.method, 'scrape');
        assert.equal(state.nodes.urlImagesForm.hidden, false);
    }
});

test('choosing Agent sends Agent to the server and switching methods clears the old preview', async () => {
    const state = page('agent');
    const pending = state.find();
    assert.equal(state.nodes.importMethod.disabled, true);
    assert.match(state.nodes.urlImportMessage.textContent, /Agent/);
    await pending;
    assert.equal(state.calls[0].body.method, 'agent');
    assert.equal(state.nodes.importMethod.disabled, false);
    assert.equal(state.nodes.urlImagesForm.hidden, false);
    state.nodes.importMethod.value = 'scrape';
    state.nodes.importMethod.events.change();
    assert.equal(state.nodes.urlImagesForm.hidden, true);
    await state.find();
    assert.equal(state.calls[1].body.method, 'scrape');
});
