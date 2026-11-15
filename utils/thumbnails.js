const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getUploadFolderPath } = require('./comicStorage');

// Cover thumbnails: generated once from the full-size cover, stored outside
// public/uploads and kept in a small in-memory cache so repeat requests never
// touch the (slow, FUSE-mounted) disk.

const THUMB_WIDTH = 400;
const THUMB_QUALITY = 80;
const MAX_REQUEST_CONCURRENCY = 2;
const MEMORY_CACHE_MAX_ENTRIES = 300;
const CACHE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const CACHE_DIR = process.env.COVER_CACHE_DIR || path.join(__dirname, '..', 'cache', 'covers');
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

// id -> Promise (dedupes concurrent generation for the same comic)
const inFlight = new Map();
// cacheKey -> { buffer, etag, lastModified }
const memoryCache = new Map();

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

function coverHash(savedFolder, coverImage) {
    return crypto.createHash('sha1').update(`${savedFolder}|${coverImage}`).digest('hex').slice(0, 16);
}

function getThumbFileName(comic) {
    return `${comic.id}-${coverHash(comic.savedFolder, comic.coverImage)}.webp`;
}

// Absolute path of the original cover, or '' when it would escape public/uploads.
function resolveOriginalCoverPath(comic) {
    if (!comic || !comic.savedFolder || !comic.coverImage) {
        return '';
    }
    const absolutePath = path.resolve(getUploadFolderPath(comic.savedFolder), comic.coverImage);
    if (!absolutePath.startsWith(UPLOADS_ROOT + path.sep)) {
        return '';
    }
    return absolutePath;
}

function rememberInMemory(key, entry) {
    memoryCache.delete(key);
    memoryCache.set(key, entry);
    while (memoryCache.size > MEMORY_CACHE_MAX_ENTRIES) {
        memoryCache.delete(memoryCache.keys().next().value);
    }
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

function renderThumbnail(sourcePath) {
    return renderImage({ src: sourcePath, width: THUMB_WIDTH, format: 'webp', quality: THUMB_QUALITY });
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

// Returns { buffer, etag, lastModified } for the comic's thumbnail, generating
// and persisting it if needed. Throws if the cover cannot be read or resized.
function getThumbnail(comic) {
    const fileName = getThumbFileName(comic);
    const cached = memoryCache.get(fileName);
    if (cached) {
        return Promise.resolve(cached);
    }

    const existing = inFlight.get(fileName);
    if (existing) {
        return existing;
    }

    const promise = (async () => {
        const thumbPath = path.join(CACHE_DIR, fileName);
        try {
            const [buffer, stats] = await Promise.all([
                fs.promises.readFile(thumbPath),
                fs.promises.stat(thumbPath)
            ]);
            if (buffer.length > 0) {
                const entry = makeEntry(buffer, stats.mtime);
                rememberInMemory(fileName, entry);
                return entry;
            }
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.error('Thumbnail cache read failed:', err.message);
            }
        }

        const sourcePath = resolveOriginalCoverPath(comic);
        if (!sourcePath) {
            throw new Error('Cover path is invalid');
        }

        const buffer = await withSlot(() => renderThumbnail(sourcePath));
        await fs.promises.mkdir(CACHE_DIR, { recursive: true });
        const tmpPath = `${thumbPath}.${process.pid}.${Date.now()}.tmp`;
        await fs.promises.writeFile(tmpPath, buffer);
        await fs.promises.rename(tmpPath, thumbPath);
        removeStaleThumbs(comic.id, fileName);

        const entry = makeEntry(buffer, new Date());
        rememberInMemory(fileName, entry);
        return entry;
    })();

    inFlight.set(fileName, promise);
    promise.then(() => inFlight.delete(fileName), () => inFlight.delete(fileName));
    return promise;
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
    getThumbnail,
    getThumbFileName,
    prewarmAll,
    renderImage,
    resolveOriginalCoverPath,
    stopWorker,
    warmThumbnail
};
