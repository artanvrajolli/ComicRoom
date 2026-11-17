// Resolve image variants from markup, without guessing CDN paths or changing
// signed query strings. The displayed <img> can be a thumbnail of its <a> target.
function decodeAttribute(value) {
    return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (match, code) => {
        if (code[0] === '#') {
            const number = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : match;
        }
        return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[code.toLowerCase()];
    });
}

function attributes(text) {
    const values = {};
    for (const match of text.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        values[match[1].toLowerCase()] = decodeAttribute(match[2] ?? match[3] ?? match[4] ?? '');
    }
    return values;
}

function absolute(value, source) {
    if (!value || !value.trim()) return '';
    try {
        const url = new URL(value, source);
        if (!['http:', 'https:'].includes(url.protocol)) return '';
        url.hash = '';
        return url.href;
    } catch { return ''; }
}

function isThumbnailUrl(value) {
    let url;
    try { url = new URL(value); } catch { return false; }
    if (/(?:^|[\/_.-])thumb(?:nail)?s?(?:[\/_.-]|$)|\/previews?\//i.test(url.pathname)) return true;
    const width = Number(url.searchParams.get('w') || url.searchParams.get('width'));
    const height = Number(url.searchParams.get('h') || url.searchParams.get('height'));
    return width > 0 && width <= 320 && height <= 640;
}

function srcset(value, source, displayWidth) {
    const variants = [];
    // Width/density descriptors let us compare variants without downloading
    // them. A URL can contain commas (e.g. an image CDN transformation path).
    for (const match of String(value || '').matchAll(/(?:^|,\s*)(\S+)\s+(\d+(?:\.\d+)?)(w|x)(?=\s*(?:,|$))/g)) {
        const url = absolute(match[1], source);
        if (url) variants.push({ url, size: Number(match[2]) * (match[3] === 'x' ? displayWidth || 1000 : 1) });
    }
    if (!variants.length && value && !/\s/.test(value.trim())) {
        const url = absolute(value.trim(), source);
        if (url) variants.push({ url, size: displayWidth || 1000 });
    }
    return variants;
}

function fullSizeImages(images, rawHtml, source, restrictToKnown = false) {
    const known = [...new Set((Array.isArray(images) ? images : []).map(value => absolute(value, source)).filter(Boolean))];
    const knownSet = new Set(known);
    const used = new Set();
    const output = [];
    const add = url => { if (url && !isThumbnailUrl(url) && !output.includes(url)) output.push(url); };
    if (restrictToKnown && !known.length) return [];
    const html = String(rawHtml || '').replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    let anchor = null;
    let picture = [];
    for (const token of html.matchAll(/<(\/?)([a-z][\w:-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)) {
        const closing = !!token[1], tag = token[2].toLowerCase();
        if (tag === 'a') { anchor = closing ? null : attributes(token[3]); continue; }
        if (tag === 'picture') { picture = []; continue; }
        if (closing) continue;
        const attrs = attributes(token[3]);
        if (tag === 'source') { picture.push(attrs); continue; }
        if (tag !== 'img') continue;
        const width = Number(attrs.width) || 0;
        const originals = ['data-full', 'data-full-url', 'data-original', 'data-original-src', 'data-large', 'data-large-image', 'data-orig-file', 'data-zoom-image', 'data-hires']
            .map(key => absolute(attrs[key], source)).filter(Boolean);
        const href = absolute(anchor?.href, source);
        const linked = href && (/\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(href) || anchor?.['data-type'] === 'image') ? href : '';
        const variants = [attrs, ...picture].flatMap(item => [item.srcset, item['data-srcset']].flatMap(value => srcset(value, source, width)))
            .sort((a, b) => b.size - a.size);
        const lazy = ['data-src', 'data-lazy-src', 'data-lazy', 'data-url'].map(key => absolute(attrs[key], source)).filter(Boolean);
        const src = absolute(attrs.src, source);
        const aliases = [...originals, linked, ...variants.map(item => item.url), ...lazy, src].filter(Boolean);
        if (known.length && !aliases.some(url => knownSet.has(url))) continue;
        for (const url of aliases) used.add(url);
        // Do not downgrade an explicitly full-size src to a smaller srcset.
        if (src && !isThumbnailUrl(src) && width > (variants[0]?.size || Infinity)) variants.unshift({ url: src, size: width });
        add([...originals, linked, ...variants.map(item => item.url), ...lazy, src].find(url => url && !isThumbnailUrl(url)));
    }
    for (const url of known) if (!used.has(url)) add(url);
    return output;
}

module.exports = { fullSizeImages, isThumbnailUrl };
