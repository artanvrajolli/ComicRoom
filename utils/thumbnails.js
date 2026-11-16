const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getUploadFolderPath } = require('./comicStorage');

// Cover and page thumbnails: generated once from the full-size image, stored
// outside public/uploads and kept in bounded in-memory LRU caches so repeat
// requests never touch the (slow, FUSE-mounted) disk.
//   covers: cache/covers/<comicId>-<sha1(folder|coverImage) first 16 hex>.webp (400px)
//   pages:  cache/pages/<comicId>-<sha1(folder|relativePath)>.webp (320px)

const THUMB_WIDTH = 400;
const PAGE_THUMB_WIDTH = 320;
const THUMB_QUALITY = 80;
const MAX_REQUEST_CONCURRENCY = 2;
const CACHE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const CACHE_DIR = process.env.COVER_CACHE_DIR || path.join(__dirname, '..', 'cache', 'covers');
const PAGE_CACHE_DIR = process.env.PAGE_THUMB_CACHE_DIR || path.join(__dirname, '..', 'cache', 'pages');
const UPLOADS_ROOT = path.resolve(getUploadFolderPath(''));

// Rendering runs in a child process (utils/thumbWorker.js) so a native Skia
// crash cannot take down the web server. The worker starts on demand and
// exits after a period of inactivity to free its memory.
const { fork } = require('child_process');
const WORKER_PATH = path.join(__dirname, 'thumbWorker.js');
const WORKER_TIMEOUT_MS = 2 * 60 * 1000;
const WORKER_IDLE_MS = 5 * 60 * 1000;

let worker = null;
let nextRequestId = 1;
const pendingRenders = new Map(); // id -> { resolve, reject, timer }
let idleTimer = null;

function failAllPending(reason) {
    for (const [id, pending] of pendingRenders) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
        pendingRenders.delete(id);
    }
}

function getWorker() {
    if (worker && worker.connected) {
        return worker;
    }
    const child = fork(WORKER_PATH, [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    child.on('message', (msg) => {
        const pending = msg && pendingRenders.get(msg.id);
        if (!pending) return;
        pendingRenders.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok) {
            pending.resolve(Buffer.from(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength));
        } else {
            pending.reject(new Error(msg.error || 'Thumbnail render failed'));
        }
        scheduleIdleShutdown();
    });
    child.on('exit', (code, signal) => {
        if (worker === child) worker = null;
        if ((signal || code) && !child.stoppedIntentionally) {
            console.error(`Thumbnail worker exited (${signal || code}); it will restart on the next request.`);
        }
        failAllPending('Thumbnail worker exited');
    });
    child.on('error', (err) => {
        console.error('Thumbnail worker error:', err.message);
    });
    worker = child;
    return child;
}

function scheduleIdleShutdown() {
    clearTimeout(idleTimer);
    if (pendingRenders.size > 0) return;
    idleTimer = setTimeout(() => {
        if (worker && pendingRenders.size === 0) {
            worker.disconnect();
        }
    }, WORKER_IDLE_MS);
    idleTimer.unref();
}

function stopWorker() {
    clearTimeout(idleTimer);
    if (worker) {
        worker.stoppedIntentionally = true;
        try { worker.kill(); } catch (err) { /* already gone */ }
        worker = null;
    }
}

// Small LRU keyed by cache file name, bounded by entry count and total bytes.
class LruCache {
    constructor(maxEntries, maxBytes) {
        this.maxEntries = maxEntries;
        this.maxBytes = maxBytes;
        this.bytes = 0;
        this.map = new Map(); // key -> { buffer, etag, lastModified }
    }

    get(key) {
        const entry = this.map.get(key);
        if (entry) {
            this.map.delete(key);
            this.map.set(key, entry);
        }
        return entry;
    }

    set(key, entry) {
        this.delete(key);
        this.map.set(key, entry);
        this.bytes += entry.buffer.length;
        while (this.map.size > 0 && (this.map.size > this.maxEntries || this.bytes > this.maxBytes)) {
            this.delete(this.map.keys().next().value);
        }
    }

    delete(key) {
        const entry = this.map.get(key);
        if (entry) {
            this.bytes -= entry.buffer.length;
            this.map.delete(key);
        }
    }

    deleteByPrefix(prefix) {
        for (const key of Array.from(this.map.keys())) {
            if (key.startsWith(prefix)) this.delete(key);
        }
    }
}

const coverMemory = new LruCache(300, 48 * 1024 * 1024);
const pageMemory = new LruCache(500, 24 * 1024 * 1024);

// cacheDir|fileName -> Promise (dedupes concurrent generation of the same thumb)
const inFlight = new Map();

let activeJobs = 0;
const waiters = [];
async function withSlot(task) {
    if (activeJobs >= MAX_REQUEST_CONCURRENCY) {
        await new Promise(resolve => waiters.push(resolve));
    }
    activeJobs++;
    try {
        return await task();
    } finally {
        activeJobs--;
        const next = waiters.shift();
        if (next) next();
    }
}

function sha1Hex(value) {
    return crypto.createHash('sha1').update(value).digest('hex');
}

function coverHash(savedFolder, coverImage) {
    return sha1Hex(`${savedFolder}|${coverImage}`).slice(0, 16);
}

function getThumbFileName(comic) {
    return `${comic.id}-${coverHash(comic.savedFolder, comic.coverImage)}.webp`;
}

function getPageThumbFileName(comic, relativePath) {
    return `${comic.id}-${sha1Hex(`${comic.savedFolder}|${relativePath}`)}.webp`;
}

// Absolute path of `relativePath` inside the comic folder, or '' when it would
// escape the comic folder (or public/uploads).
function resolveInsideComicFolder(savedFolder, relativePath) {
    if (!savedFolder || !relativePath || typeof relativePath !== 'string' || relativePath.includes('\0')) {
        return '';
    }
    const folderPath = path.resolve(getUploadFolderPath(savedFolder));
    if (!folderPath.startsWith(UPLOADS_ROOT + path.sep)) {
        return '';
    }
    const absolutePath = path.resolve(folderPath, relativePath);
    if (!absolutePath.startsWith(folderPath + path.sep)) {
        return '';
    }
    return absolutePath;
}

// Absolute path of the original cover, or '' when it would escape public/uploads.
function resolveOriginalCoverPath(comic) {
    if (!comic || !comic.savedFolder || !comic.coverImage) {
        return '';
    }
    return resolveInsideComicFolder(comic.savedFolder, comic.coverImage);
}

// Absolute path of an original page image, or '' when it would escape the comic folder.
// Callers must also check that relativePath is one of the comic's current pages.
function resolveOriginalPagePath(comic, relativePath) {
    if (!comic || !comic.savedFolder) {
        return '';
    }
    return resolveInsideComicFolder(comic.savedFolder, relativePath);
}

function makeEntry(buffer, mtime) {
    return {
        buffer,
        etag: `"${crypto.createHash('sha1').update(buffer).digest('base64url').slice(0, 27)}"`,
        lastModified: new Date(Math.floor(mtime.getTime() / 1000) * 1000)
    };
}

async function removeStaleThumbs(comicId, keepFileName) {
    try {
        const prefix = `${comicId}-`;
        const files = await fs.promises.readdir(CACHE_DIR);
        await Promise.all(files
            .filter(file => file.startsWith(prefix) && file !== keepFileName)
            .map(file => fs.promises.unlink(path.join(CACHE_DIR, file)).catch(() => {})));
    } catch (err) {
        // cache dir missing or unreadable: nothing to clean
    }
}

// Removes every cached page thumbnail of a comic (disk and memory). Called after
// page add/delete/move, since managed page files are renamed on every rebuild.
async function removePageThumbs(comicId) {
    const prefix = `${comicId}-`;
    pageMemory.deleteByPrefix(prefix);
    try {
        const files = await fs.promises.readdir(PAGE_CACHE_DIR);
        await Promise.all(files
            .filter(file => file.startsWith(prefix))
            .map(file => fs.promises.unlink(path.join(PAGE_CACHE_DIR, file)).catch(() => {})));
    } catch (err) {
        // cache dir missing or unreadable: nothing to clean
    }
}

// Removes every cached cover and page thumbnail of a comic (disk and memory).
// Called when the comic is deleted.
async function removeComicThumbs(comicId) {
    coverMemory.deleteByPrefix(`${comicId}-`);
    await Promise.all([removeStaleThumbs(comicId, null), removePageThumbs(comicId)]);
}

// Renders a resized image in the isolated worker. Options: see utils/thumbWorker.js.
function renderImage(options) {
    return new Promise((resolve, reject) => {
        const id = nextRequestId++;
        const child = getWorker();
        clearTimeout(idleTimer);
        const timer = setTimeout(() => {
            pendingRenders.delete(id);
            reject(new Error('Thumbnail render timed out'));
            // A stuck worker would block every later render; replace it.
            stopWorker();
        }, WORKER_TIMEOUT_MS);
        pendingRenders.set(id, { resolve, reject, timer });
        child.send(Object.assign({}, options, { id }));
    });
}

// Shared memory -> disk -> render pipeline. Returns { buffer, etag, lastModified }.
// Throws if the source cannot be read or resized.
function getCachedRender({ cacheDir, fileName, memory, sourcePath, width, afterWrite }) {
    const cached = memory.get(fileName);
    if (cached) {
        return Promise.resolve(cached);
    }

    const flightKey = `${cacheDir}|${fileName}`;
    const existing = inFlight.get(flightKey);
    if (existing) {
        return existing;
    }

    const promise = (async () => {
        const thumbPath = path.join(cacheDir, fileName);
        try {
            const [buffer, stats] = await Promise.all([
                fs.promises.readFile(thumbPath),
                fs.promises.stat(thumbPath)
            ]);
            if (buffer.length > 0) {
                const entry = makeEntry(buffer, stats.mtime);
                memory.set(fileName, entry);
                return entry;
            }
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.error('Thumbnail cache read failed:', err.message);
            }
        }

        if (!sourcePath) {
            throw new Error('Source image path is invalid');
        }

        const buffer = await withSlot(() => renderImage({ src: sourcePath, width, format: 'webp', quality: THUMB_QUALITY }));
        await fs.promises.mkdir(cacheDir, { recursive: true });
        const tmpPath = `${thumbPath}.${process.pid}.${Date.now()}.tmp`;
        await fs.promises.writeFile(tmpPath, buffer);
        await fs.promises.rename(tmpPath, thumbPath);
        if (afterWrite) afterWrite();

        const entry = makeEntry(buffer, new Date());
        memory.set(fileName, entry);
        return entry;
    })();

    inFlight.set(flightKey, promise);
    promise.then(() => inFlight.delete(flightKey), () => inFlight.delete(flightKey));
    return promise;
}

// Returns { buffer, etag, lastModified } for the comic's cover thumbnail,
// generating and persisting it if needed.
function getThumbnail(comic) {
    const fileName = getThumbFileName(comic);
    return getCachedRender({
        cacheDir: CACHE_DIR,
        fileName,
        memory: coverMemory,
        sourcePath: resolveOriginalCoverPath(comic),
        width: THUMB_WIDTH,
        afterWrite: () => removeStaleThumbs(comic.id, fileName)
    });
}

// Returns { buffer, etag, lastModified } for a ~320px page thumbnail. The caller
// must have validated relativePath against the comic's current page list.
function getPageThumbnail(comic, relativePath) {
    return getCachedRender({
        cacheDir: PAGE_CACHE_DIR,
        fileName: getPageThumbFileName(comic, relativePath),
        memory: pageMemory,
        sourcePath: resolveOriginalPagePath(comic, relativePath),
        width: PAGE_THUMB_WIDTH
    });
}

// Fire-and-forget generation (used after uploads and page edits).
function warmThumbnail(comic) {
    if (!comic || !comic.id || !comic.coverImage) {
        return;
    }
    getThumbnail(comic).catch(err => {
        console.error(`Thumbnail generation failed for comic ${comic.id}:`, err.message);
    });
}

// Sequentially generates thumbnails that are missing on disk (concurrency 1).
async function prewarmAll(comics) {
    let existingFiles = new Set();
    try {
        existingFiles = new Set(await fs.promises.readdir(CACHE_DIR));
    } catch (err) {
        // directory will be created on first write
    }

    let generated = 0;
    for (const comic of comics) {
        if (!comic || !comic.coverImage || !comic.savedFolder) continue;
        if (existingFiles.has(getThumbFileName(comic))) continue;
        try {
            await getThumbnail(comic);
            generated++;
        } catch (err) {
            console.error(`Thumbnail prewarm failed for comic ${comic.id}:`, err.message);
        }
    }
    return generated;
}

module.exports = {
    CACHE_DIR,
    CACHE_MAX_AGE_SECONDS,
    PAGE_CACHE_DIR,
    getPageThumbFileName,
    getPageThumbnail,
    getThumbnail,
    getThumbFileName,
    prewarmAll,
    removeComicThumbs,
    removePageThumbs,
    renderImage,
    resolveOriginalCoverPath,
    resolveOriginalPagePath,
    stopWorker,
    warmThumbnail
};
