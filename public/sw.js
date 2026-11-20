const CACHE_PREFIX = 'comicroom-';
// Bump SHELL_CACHE when shell assets change. Do NOT bump PAGES/IMAGE/META:
// that would wipe comics users saved for offline reading.
const SHELL_CACHE = 'comicroom-shell-v10';
const PAGES_CACHE = 'comicroom-pages-v1';
const IMAGE_CACHE = 'comicroom-images-v1';
const META_CACHE = 'comicroom-meta-v1';
const COVER_CACHE = 'comicroom-covers-v1';
const THUMB_CACHE = 'comicroom-thumbs-v1';
const ACTIVE_CACHES = [SHELL_CACHE, PAGES_CACHE, IMAGE_CACHE, META_CACHE, COVER_CACHE, THUMB_CACHE];
const MAX_COVER_ENTRIES = 300;
const MAX_THUMB_ENTRIES = 400;
const COVER_PATH_REGEX = /^\/(?:comic\/)?cover\/\d+\/?$/;
// Small WebP page thumbnails: /comic/page-thumb/<id>?file=... (the query picks the page).
const PAGE_THUMB_PATH_REGEX = /^\/comic\/page-thumb\/\d+\/?$/;
// Upload flow and job status are live data: never answered from or written to a cache.
const NEVER_CACHE_REGEXES = [
    /^\/comic\/uploads?(?:\/|$)/,
    /^\/comic\/upload-chunk(?:\/|$)/,
    /^\/comic\/status\//,
    /^\/comic\/share-target(?:\/|$)/
];
// Only these HTML pages are cached for offline use. Admin, upload, login,
// register, edit and status pages always go to the network and are never stored.
const CACHEABLE_PAGE_REGEXES = [
    /^\/$/,
    /^\/comic\/?$/,
    /^\/(?:comic\/)?show\/\d+\/?$/,
    /^\/onread\/?$/
];
const OFFLINE_URL = '/public/offline.html';
const META_KEY = '/__offline__/comics.json';
const MAX_OFFLINE_COMICS = 5;
const CACHE_CONCURRENCY = 4;
// Keep these URLs identical to what the pages request (views/head_tags.ejs,
// views/comicView.ejs, views/pdfView.ejs), including the ?v= query strings,
// so the precached copies are hits. Offline, any cached version of an asset
// is used as a fallback (see handleAsset).
const SHELL_ASSETS = [
    OFFLINE_URL,
    '/public/manifest.webmanifest',
    '/public/css/bootstrap/css/bootstrap.min.css',
    '/public/css/bootstrap/js/bootstrap.bundle.min.js',
    '/public/css/comic.css?v=5',
    '/public/css/reader.css?v=20261116m1',
    '/public/script/viewComic.js?v=20261117m1',
    '/public/script/readingList.js?v=1',
    '/public/css/css/all.min.css',
    '/public/css/webfonts/fa-solid-900.woff2',
    '/public/css/webfonts/fa-regular-400.woff2',
    '/public/css/webfonts/fa-brands-400.woff2',
    '/public/script/header.js?v=4',
    '/public/script/uploadManager.js?v=4',
    '/public/script/jQuery.js',
    '/public/icons/icon-192.png',
    '/public/icons/icon-512.png',
    '/public/icons/icon-maskable-512.png',
    '/public/icons/apple-touch-icon.png',
    '/public/images/favicon.png'
];

self.addEventListener('install', function (event) {
    event.waitUntil((async function () {
        const shellCache = await caches.open(SHELL_CACHE);
        await Promise.all(SHELL_ASSETS.map(async function (asset) {
            try {
                await shellCache.add(new Request(asset, { cache: 'reload' }));
            } catch (error) {}
        }));

        try {
            const pagesCache = await caches.open(PAGES_CACHE);
            await pagesCache.add(new Request('/comic', { cache: 'reload' }));
        } catch (error) {}

        await self.skipWaiting();
    })());
});

self.addEventListener('activate', function (event) {
    event.waitUntil((async function () {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames
            .filter(function (cacheName) {
                return cacheName.indexOf(CACHE_PREFIX) === 0 && ACTIVE_CACHES.indexOf(cacheName) === -1;
            })
            .map(function (cacheName) {
                return caches.delete(cacheName);
            }));
        await self.clients.claim();
    })());
});

function normalizeUrls(urls) {
    if (!Array.isArray(urls)) {
        return [];
    }

    const seen = new Set();
    const normalized = [];
    urls.forEach(function (value) {
        if (typeof value !== 'string' || value === '' || seen.has(value)) {
            return;
        }
        seen.add(value);
        normalized.push(value);
    });
    return normalized;
}

async function readOfflineMeta() {
    const cache = await caches.open(META_CACHE);
    const response = await cache.match(META_KEY);
    if (!response) {
        return [];
    }

    try {
        const data = await response.json();
        return Array.isArray(data) ? data : [];
    } catch (error) {
        return [];
    }
}

async function writeOfflineMeta(entries) {
    const cache = await caches.open(META_CACHE);
    await cache.put(META_KEY, new Response(JSON.stringify(entries), {
        headers: { 'Content-Type': 'application/json' }
    }));
}

async function deleteComicCache(entry) {
    if (!entry || !entry.folder) {
        return;
    }

    const imageCache = await caches.open(IMAGE_CACHE);
    const imageRequests = await imageCache.keys();
    const imagePrefix = '/public/uploads/' + entry.folder + '/';
    await Promise.all(imageRequests
        .filter(function (request) {
            return new URL(request.url).pathname.indexOf(imagePrefix) === 0;
        })
        .map(function (request) {
            return imageCache.delete(request);
        }));

    if (entry.pageUrl) {
        const pageCache = await caches.open(PAGES_CACHE);
        await pageCache.delete(entry.pageUrl);
    }
}

// Called when a comic is deleted: drop its offline copy, cover and page thumbnails.
async function removeComic(data) {
    const folder = String(data.comicFolder || '');
    const comicId = String(data.comicId || '');
    if (folder) {
        const meta = await readOfflineMeta();
        const removed = meta.filter(function (entry) { return entry.folder === folder; });
        if (removed.length) {
            await writeOfflineMeta(meta.filter(function (entry) { return entry.folder !== folder; }));
        }
        await deleteComicCache(removed[0] || { folder: folder });
    }
    if (/^[0-9]+$/.test(comicId)) {
        const prefixes = ['/comic/cover/' + comicId, '/comic/page-thumb/' + comicId, '/comic/show/' + comicId];
        for (const cacheName of [COVER_CACHE, THUMB_CACHE, PAGES_CACHE]) {
            const cache = await caches.open(cacheName);
            const requests = await cache.keys();
            await Promise.all(requests
                .filter(function (request) {
                    const pathname = new URL(request.url).pathname;
                    return prefixes.some(function (prefix) { return pathname === prefix || pathname.indexOf(prefix + '/') === 0; });
                })
                .map(function (request) { return cache.delete(request); }));
        }
    }
}

async function cacheComic(data, port) {
    const folder = String(data.comicFolder || '');
    const pageUrls = normalizeUrls(data.pageUrls);
    const total = pageUrls.length;

    if (!folder || total === 0) {
        if (port) {
            try {
                port.postMessage({ type: 'CACHE_DONE', ok: false, cachedCount: 0, failureCount: 0, total: 0, error: 'Nothing to cache' });
            } catch (error) {}
        }
        return;
    }

    const meta = await readOfflineMeta();
    const kept = meta.filter(function (entry) {
        return entry.folder !== folder;
    });
    const evicted = [];
    while (kept.length >= MAX_OFFLINE_COMICS) {
        evicted.push(kept.shift());
    }
    for (const entry of evicted) {
        await deleteComicCache(entry);
    }

    const imageCache = await caches.open(IMAGE_CACHE);
    const pageCache = await caches.open(PAGES_CACHE);
    let cachedCount = 0;
    let failureCount = 0;
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < total) {
            const url = pageUrls[nextIndex];
            nextIndex += 1;
            try {
                const existing = await imageCache.match(url);
                if (!existing) {
                    const response = await fetch(url);
                    if (!isCacheableResponse(response)) {
                        throw new Error('HTTP ' + (response ? response.status : 'error'));
                    }
                    await imageCache.put(url, response.clone());
                }
                cachedCount += 1;
            } catch (error) {
                failureCount += 1;
            }

            if (port && (cachedCount + failureCount) % 5 === 0) {
                try {
                    port.postMessage({ type: 'CACHE_PROGRESS', cachedCount: cachedCount, failureCount: failureCount, total: total });
                } catch (error) {}
            }
        }
    }

    const workers = [];
    for (let index = 0; index < Math.min(CACHE_CONCURRENCY, total); index += 1) {
        workers.push(worker());
    }
    await Promise.all(workers);

    if (data.pageUrl) {
        try {
            const pageResponse = await fetch(data.pageUrl);
            const pageType = pageResponse ? (pageResponse.headers.get('content-type') || '') : '';
            // A redirect here means the session expired (login page): never store it as the comic.
            if (isCacheableResponse(pageResponse) && pageType.indexOf('text/html') !== -1) {
                await pageCache.put(data.pageUrl, pageResponse.clone());
            }
        } catch (error) {}
    }

    const assetUrls = normalizeUrls(data.assetUrls);
    if (assetUrls.length > 0) {
        const shellCache = await caches.open(SHELL_CACHE);
        for (const assetUrl of assetUrls) {
            try {
                const existingAsset = await shellCache.match(assetUrl);
                if (!existingAsset) {
                    const assetResponse = await fetch(assetUrl);
                    if (isCacheableResponse(assetResponse)) {
                        await shellCache.put(assetUrl, assetResponse.clone());
                    }
                }
            } catch (error) {}
        }
    }

    if (cachedCount > 0) {
        kept.push({
            folder: folder,
            pageUrl: data.pageUrl || '',
            title: data.title || '',
            pageUrls: pageUrls,
            cachedAt: Date.now()
        });
        await writeOfflineMeta(kept);
    }

    if (port) {
        try {
            port.postMessage({
                type: 'CACHE_DONE',
                ok: cachedCount > 0,
                cachedCount: cachedCount,
                failureCount: failureCount,
                total: total,
                evicted: evicted.map(function (entry) {
                    return entry.folder;
                })
            });
        } catch (error) {}
    }
}

async function reportOfflineStatus(data, port) {
    const pageUrls = normalizeUrls(data.pageUrls);
    const imageCache = await caches.open(IMAGE_CACHE);
    let missing = 0;

    for (const url of pageUrls) {
        const cached = await imageCache.match(url);
        if (!cached) {
            missing += 1;
        }
    }

    if (port) {
        try {
            port.postMessage({ type: 'OFFLINE_STATUS', total: pageUrls.length, missing: missing });
        } catch (error) {}
    }
}

async function cacheFirstImage(request) {
    const cache = await caches.open(IMAGE_CACHE);
    const cached = await cache.match(request);
    if (cached) {
        return cached;
    }

    const response = await fetch(request);
    if (isCacheableResponse(response)) {
        await safePut(cache, request, response.clone());
    }
    return response;
}

async function safePut(cache, request, response) {
    try {
        await cache.put(request, response);
        return true;
    } catch (error) {
        return false;
    }
}

async function trimCache(cache, maxEntries) {
    const keys = await cache.keys();
    const excess = keys.length - maxEntries;
    for (let index = 0; index < excess; index += 1) {
        await cache.delete(keys[index]);
    }
}

// Only plain 200-range, same-origin, non-partial, non-redirected responses are stored.
function isCacheableResponse(response) {
    return !!response && response.ok && !response.redirected && response.status !== 206 &&
        (response.type === 'basic' || response.type === 'default');
}

// Versioned (?v=...) assets and fonts/icons never change under the same URL:
// cache-first. Unversioned CSS/JS: stale-while-revalidate so edits still
// reach clients. Offline, fall back to any cached copy regardless of ?v=.
async function handleAsset(event, request) {
    const cache = await caches.open(SHELL_CACHE);
    const url = new URL(request.url);
    const immutable = url.search !== '' || /\.(?:woff2?|ttf|eot|png|jpe?g|gif|svg|ico|webp|webmanifest)$/i.test(url.pathname);
    const cached = await cache.match(request);
    if (cached && immutable) {
        return cached;
    }

    const network = fetch(request).then(async function (response) {
        if (isCacheableResponse(response)) {
            await safePut(cache, request, response.clone());
        }
        return response;
    });

    if (cached) {
        event.waitUntil(network.catch(function () {}));
        return cached;
    }

    try {
        return await network;
    } catch (error) {
        const fallback = await cache.match(request, { ignoreSearch: true });
        if (fallback) {
            return fallback;
        }
        throw error;
    }
}

// Gallery covers (/comic/cover/<id>) and page thumbnails (/comic/page-thumb/<id>?file=...):
// stale-while-revalidate with a capped number of entries so images seen online
// still show offline.
async function staleWhileRevalidateImage(event, request, cacheName, maxEntries, ignoreSearchFallback) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);

    const network = fetch(request).then(async function (response) {
        if (isCacheableResponse(response)) {
            if (await safePut(cache, request, response.clone())) {
                await trimCache(cache, maxEntries);
            }
        }
        return response;
    });

    if (cached) {
        event.waitUntil(network.catch(function () {}));
        return cached;
    }

    try {
        return await network;
    } catch (error) {
        const fallback = ignoreSearchFallback ? await cache.match(request, { ignoreSearch: true }) : null;
        if (fallback) {
            return fallback;
        }
        return new Response('', { status: 504, statusText: 'Offline' });
    }
}

function handleCover(event, request) {
    return staleWhileRevalidateImage(event, request, COVER_CACHE, MAX_COVER_ENTRIES, true);
}

// The ?file= query selects the page, so never fall back to another page's thumbnail.
function handlePageThumb(event, request) {
    return staleWhileRevalidateImage(event, request, THUMB_CACHE, MAX_THUMB_ENTRIES, false);
}

function isCacheablePage(url) {
    return CACHEABLE_PAGE_REGEXES.some(function (regex) {
        return regex.test(url.pathname);
    });
}

async function networkFirstPage(request) {
    const cache = await caches.open(PAGES_CACHE);
    const cacheable = isCacheablePage(new URL(request.url));

    try {
        const response = await fetch(request);
        const contentType = response.headers.get('content-type') || '';
        if (cacheable && response && response.ok && !response.redirected && contentType.indexOf('text/html') !== -1) {
            await safePut(cache, request, response.clone());
        }
        return response;
    } catch (error) {
        const cached = cacheable ? await cache.match(request, { ignoreSearch: true }) : null;
        if (cached) {
            return cached;
        }
        return offlineFallback();
    }
}

async function offlineFallback() {
    const offlinePage = await caches.match(OFFLINE_URL);
    if (offlinePage) {
        return offlinePage;
    }
    return new Response('Offline', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' }
    });
}

self.addEventListener('fetch', function (event) {
    const request = event.request;
    if (request.method !== 'GET') {
        return;
    }

    const url = new URL(request.url);
    if (url.origin !== self.location.origin || url.pathname === '/sw.js') {
        return;
    }

    if (NEVER_CACHE_REGEXES.some(function (regex) { return regex.test(url.pathname); })) {
        // Navigations still get the offline page when the network is down; nothing is stored.
        if (request.mode === 'navigate') {
            event.respondWith(fetch(request).catch(offlineFallback));
        }
        return;
    }

    // Partial (range) requests, e.g. PDFs/videos, cannot be cached: go to the network.
    if (request.headers.has('range')) {
        return;
    }

    if (request.mode === 'navigate') {
        event.respondWith(networkFirstPage(request));
        return;
    }

    if (url.pathname.indexOf('/public/uploads/') === 0) {
        event.respondWith(cacheFirstImage(request));
        return;
    }

    if (COVER_PATH_REGEX.test(url.pathname)) {
        event.respondWith(handleCover(event, request));
        return;
    }

    if (PAGE_THUMB_PATH_REGEX.test(url.pathname)) {
        event.respondWith(handlePageThumb(event, request));
        return;
    }

    if (url.pathname.indexOf('/public/') === 0 || url.pathname === '/manifest.webmanifest') {
        event.respondWith(handleAsset(event, request));
    }
});

self.addEventListener('message', function (event) {
    const data = event.data || {};
    const port = event.ports && event.ports[0];

    if (data.type === 'CACHE_COMIC') {
        event.waitUntil(cacheComic(data, port));
        return;
    }

    if (data.type === 'REMOVE_COMIC') {
        event.waitUntil(removeComic(data));
        return;
    }

    if (data.type === 'GET_OFFLINE_STATUS') {
        event.waitUntil(reportOfflineStatus(data, port));
    }
});
