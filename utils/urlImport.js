const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const fs = require('fs').promises;
const path = require('path');
const { loadImage } = require('@napi-rs/canvas');
const { fullSizeImages, isThumbnailUrl } = require('./imageCandidates');
const { agentEndpoint, discoverAgentImages } = require('./agentDiscovery');

const MAX_IMAGES = 300;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const BROWSER_BATCH_SIZE = 4;

function firecrawlEndpoints() {
    const primary = String(process.env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev/v2/scrape').trim();
    const fallback = String(process.env.FIRECRAWL_FALLBACK_URL ?? 'https://api.firecrawl.dev/v2/scrape').trim();
    return [...new Set([primary, fallback].filter(Boolean))];
}

async function scrapeWithFirecrawl(options, endpoint) {
    const headers = { 'Content-Type': 'application/json' };
    // Credentials for the hosted service must never be forwarded to a custom server.
    const key = new URL(endpoint).hostname === 'api.firecrawl.dev'
        ? process.env.FIRECRAWL_API_KEY : process.env.FIRECRAWL_CUSTOM_API_KEY;
    if (key) headers.Authorization = 'Bearer ' + key;
    const response = await fetch(endpoint, {
        method: 'POST', headers, signal: AbortSignal.timeout(90000),
        body: JSON.stringify({ ...options, timeout: 60000 })
    });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 402
        ? 'Firecrawl needs a valid API key with available credits.'
        : 'Firecrawl could not complete this request (HTTP ' + response.status + ').');
    const result = await response.json();
    if (!result.success || !result.data || Number(result.data.metadata?.statusCode) >= 400) {
        throw new Error('Firecrawl could not load this page from ' + new URL(endpoint).hostname + '.');
    }
    return result.data;
}

async function tryFirecrawl(options, endpoints = firecrawlEndpoints()) {
    let lastError;
    for (const endpoint of endpoints) {
        try { return { data: await scrapeWithFirecrawl(options, endpoint), endpoint }; }
        catch (error) { lastError = error; }
    }
    throw lastError || new Error('No Firecrawl server is configured.');
}
const blocked = new net.BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(ip, bits);
// Only global unicast IPv6; also exclude mapped IPv4, local and transition ranges.
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');

function parsePublicUrl(value) {
    let url;
    try { url = new URL(String(value || '').trim()); } catch { throw new Error('Enter a valid public HTTP or HTTPS URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        (url.port && !['80', '443'].includes(url.port)) || url.href.length > 4096) {
        throw new Error('Use a public HTTP or HTTPS URL without credentials or a custom port.');
    }
    url.hash = '';
    return url;
}

async function resolvePublicUrl(value) {
    const url = parsePublicUrl(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await dns.lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(({ address, family }) => family === 4
        ? blocked.check(address, 'ipv4')
        : !/^2[0-9a-f]{3}:/i.test(address) || blocked.check(address, 'ipv6'))) {
        throw new Error('Only public internet addresses can be imported.');
    }
    return { url, address: addresses[0] };
}

function orderedImages(data, source, selector) {
    const html = String(data.rawHtml || '');
    // Lazy readers may expose the complete ordered image list as serialized
    // state. Accept only JSON with an image list and page count that overlaps
    // the discovered/visible images. Never execute page JavaScript.
    if (!selector) {
        const visible = Array.isArray(data.images) && data.images.length ? data.images : fullSizeImages([], html, source);
        const normalize = value => { try { return new URL(value, source).href; } catch { return ''; } };
        const known = new Set(visible.filter(value => typeof value === 'string').map(normalize));
        for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
            const text = script[1].trim();
            const assignment = text.match(/(?:^|[;\s])(?:window\.)?[\w$]+\s*=\s*(\{[\s\S]*?\});/);
            const json = text.startsWith('{') ? text : assignment?.[1];
            if (!json) continue;
            try {
                const reader = JSON.parse(json);
                if (Array.isArray(reader.images) && Number.isInteger(reader.pages) && reader.pages > 0 && reader.pages <= MAX_IMAGES) {
                    const pages = reader.images.slice(0, reader.pages);
                    if (pages.length === reader.pages && pages.every(value => typeof value === 'string') && pages.some(value => known.has(normalize(value)))) return pages;
                }
            } catch { /* Fall back to the normal Firecrawl image result. */ }
        }
    }
    return fullSizeImages(data.images, html, source, !!selector);
}

async function discoverImages(source, selector = '', method = 'scrape') {
    if (!['scrape', 'agent'].includes(method)) throw new Error('Choose Scrape or Agent for image discovery.');
    const { url } = await resolvePublicUrl(source);
    if (typeof selector !== 'string' || selector.length > 300) throw new Error('The image selector is too long.');
    let data, candidates;
    if (method === 'agent') {
        data = await discoverAgentImages(url.href, selector.trim(), agentEndpoint(firecrawlEndpoints()[0]));
        candidates = data.images;
    } else {
        ({ data } = await tryFirecrawl({
            url: url.href, formats: ['images', 'rawHtml'], onlyMainContent: true,
            ...(selector.trim() ? { includeTags: [selector.trim()] } : {}), waitFor: 2000
        }));
        candidates = orderedImages(data, url.href, selector.trim());
    }
    const images = [...new Set(candidates.map(value => {
        try { return parsePublicUrl(new URL(value, url).href).href; }
        catch { if (method === 'agent') throw new Error('Agent returned invalid image URLs. Try Scrape.'); return ''; }
    }).filter(Boolean))];
    if (method === 'agent' && images.some(isThumbnailUrl)) throw new Error('Agent returned thumbnail previews. Try Scrape or a different reader URL.');
    if (!images.length) throw new Error('No full-size images were found. Open the reader or original-image page instead of a thumbnail gallery, or try an image selector.');
    if (images.length > MAX_IMAGES) throw new Error('More than 300 images were found. Use a chapter URL or narrow the image selector.');
    const publicImages = [];
    for (const image of images) {
        try { publicImages.push((await resolvePublicUrl(image)).url.href); }
        catch { if (method === 'agent') throw new Error('Agent returned an inaccessible or private image host. Try Scrape.'); }
    }
    if (!publicImages.length) throw new Error('No publicly accessible image URLs were found.');
    return { source: url.href, title: String((method === 'agent' ? data.title : data.metadata?.title) || url.hostname).slice(0, 200), images: publicImages, method };
}

// Pin the validated DNS result to the request; validate every redirect as well.
async function downloadImage(value, source, redirects = 0) {
    const { url, address } = await resolvePublicUrl(value);
    return new Promise((resolve, reject) => {
        const request = (url.protocol === 'https:' ? https : http).get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ComicRoom/1.0)', Referer: source, Accept: 'image/*' },
            lookup: (_host, options, cb) => cb(null, options?.all ? [address] : address.address, address.family)
        }, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                response.resume();
                if (redirects >= 5 || !response.headers.location) return reject(new Error('Too many image redirects.'));
                return downloadImage(new URL(response.headers.location, url).href, source, redirects + 1).then(resolve, reject);
            }
            if (response.statusCode !== 200) {
                response.resume();
                const error = new Error('The website blocked an image download (HTTP ' + response.statusCode + ').');
                error.statusCode = response.statusCode;
                return reject(error);
            }
            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
                size += chunk.length;
                if (size > MAX_IMAGE_BYTES) request.destroy(new Error('An image exceeds the 25 MB limit.'));
                else chunks.push(chunk);
            });
            response.on('error', reject);
            response.on('end', () => resolve(Buffer.concat(chunks)));
        });
        const timer = setTimeout(() => request.destroy(new Error('Image download timed out.')), 30000);
        request.on('close', () => clearTimeout(timer));
        request.on('error', reject);
    });
}

function imageExtension(bytes) {
    if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'jpg';
    if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
    if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return 'gif';
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    if (bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(bytes.toString('ascii', 8, 32))) return 'avif';
    throw new Error('A selected URL did not return a supported image (JPG, PNG, GIF, WebP or AVIF).');
}

async function validateImage(bytes) {
    imageExtension(bytes);
    const decoded = await loadImage(bytes);
    if (decoded.width <= 1 || decoded.height <= 1) {
        const error = new Error('The website returned a placeholder image.');
        error.code = 'PLACEHOLDER_IMAGE';
        throw error;
    }
}

async function downloadBrowserBatch(images, source, preferredEndpoint) {
    await resolvePublicUrl(source);
    for (const url of images) await resolvePublicUrl(url);
    // A visual format makes Firecrawl load real media. Without it the browser
    // engine can return a synthetic 1x1 JPEG with HTTP 200 for every image.
    const script = `(async () => {
        const output = [];
        for (const url of ${JSON.stringify(images)}) {
            const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
            if (!response.ok) throw new Error('Image download failed: ' + response.status);
            const reader = response.body.getReader();
            const chunks = []; let size = 0;
            while (true) {
                const part = await reader.read(); if (part.done) break;
                size += part.value.length;
                if (size > ${MAX_IMAGE_BYTES}) { await reader.cancel(); throw new Error('Image exceeds 25 MB.'); }
                chunks.push(part.value);
            }
            const blob = new Blob(chunks, { type: response.headers.get('content-type') || '' });
            const image = await createImageBitmap(blob);
            const width = image.width, height = image.height; image.close();
            if (width <= 1 || height <= 1) throw new Error('Website returned a placeholder image.');
            const data = await new Promise((resolve, reject) => {
                const file = new FileReader(); file.onload = () => resolve(file.result);
                file.onerror = reject; file.readAsDataURL(blob);
            });
            output.push({ url, data });
        }
        return output;
    })()`;
    const endpoints = preferredEndpoint ? [preferredEndpoint] : firecrawlEndpoints();
    let lastError;
    for (const endpoint of endpoints) {
        try {
            const data = await scrapeWithFirecrawl({ url: source,
                formats: [{ type: 'screenshot', fullPage: false }],
                actions: [{ type: 'wait', milliseconds: 2000 }, { type: 'executeJavascript', script }]
            }, endpoint);
            const values = data.actions?.javascriptReturns?.[0]?.value;
            if (!Array.isArray(values) || values.length !== images.length) throw new Error('Firecrawl did not return all requested images.');
            const buffers = [];
            for (let i = 0; i < values.length; i++) {
                const value = values[i];
                if (value.url !== images[i] || typeof value.data !== 'string' || value.data.length > MAX_IMAGE_BYTES * 4 / 3 + 1024) throw new Error('Firecrawl returned an invalid image.');
                const match = value.data.match(/^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=]+)$/i);
                if (!match) throw new Error('Firecrawl did not return image bytes.');
                const bytes = Buffer.from(match[1], 'base64');
                if (bytes.length > MAX_IMAGE_BYTES) throw new Error('An image exceeds the 25 MB limit.');
                await validateImage(bytes);
                buffers.push(bytes);
            }
            return { buffers, endpoint };
        } catch (error) { lastError = error; }
    }
    throw new Error('Could not download the images through Firecrawl: ' + (lastError?.message || 'No browser engine is available.'));
}

async function importImages(manifestPath, folder, onProgress) {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    parsePublicUrl(manifest.source);
    if (!Array.isArray(manifest.images) || !manifest.images.length || manifest.images.length > MAX_IMAGES) throw new Error('Select between 1 and 300 images.');
    if (manifest.images.some(isThumbnailUrl)) throw new Error('Thumbnail previews cannot be imported. Find images again to select full-size originals.');
    // Stage outside public/uploads; a failed import never exposes partial pages.
    const staging = await fs.mkdtemp(path.join(path.dirname(manifestPath), 'url-pages-'));
    let total = 0;
    let browserEndpoint;
    let browserMode = false;
    try {
        for (let i = 0; i < manifest.images.length;) {
            let buffers;
            if (!browserMode) {
                try {
                    const bytes = await downloadImage(manifest.images[i], manifest.source);
                    await validateImage(bytes);
                    buffers = [bytes];
                }
                catch (error) {
                    if (![401, 403, 429, 503].includes(error.statusCode) && error.code !== 'PLACEHOLDER_IMAGE') throw error;
                    browserMode = true;
                }
            }
            if (browserMode) {
                const result = await downloadBrowserBatch(manifest.images.slice(i, i + BROWSER_BATCH_SIZE), manifest.source, browserEndpoint);
                buffers = result.buffers;
                browserEndpoint = result.endpoint;
            }
            for (const bytes of buffers) {
                total += bytes.length;
                if (total > MAX_TOTAL_BYTES) throw new Error('The selected images exceed the 500 MB import limit.');
                await fs.writeFile(path.join(staging, String(i + 1).padStart(4, '0') + '.' + imageExtension(bytes)), bytes);
                i++;
                await onProgress(10 + Math.round(i / manifest.images.length * 40));
            }
        }
        await fs.mkdir(folder, { recursive: true });
        for (const name of await fs.readdir(staging)) await fs.rename(path.join(staging, name), path.join(folder, name));
    } finally {
        await fs.rm(staging, { recursive: true, force: true });
    }
}

module.exports = { MAX_IMAGES, firecrawlEndpoints, parsePublicUrl, resolvePublicUrl, orderedImages, discoverImages, downloadImage, downloadBrowserBatch, imageExtension, importImages };
