/*
 * ComicRoom background uploader (loaded on every page).
 *
 * Sends comic files to POST /comic/upload-chunk in 2 MB parts. The chosen File is
 * kept in IndexedDB, so the upload survives moving between pages: every page load
 * asks the server which parts it already has (GET /comic/upload-chunk/:id) and
 * sends the rest. Leaving a page only pauses the upload for a moment.
 *
 * Only one tab sends at a time (Web Locks); other tabs show the same progress via
 * BroadcastChannel. If the browser cannot store the File (some private modes),
 * the upload still works but only while the page that started it stays open.
 *
 * window.CRUploads:
 *   start(file) -> Promise<id>     queue and start sending a file
 *   cancel(id), resume(id)         stop and forget / retry after an error
 *   attachFile(id, file) -> bool   re-attach the file when the browser dropped it
 *   list() -> [state]              { id, name, size, sent, state, error, jobId, persisted }
 *   persistent                     false when files cannot be kept across pages
 * Events on document:
 *   cr:upload-progress { uploads: [state] }
 *   cr:upload-done     { id, name, jobId }
 */
(function () {
    'use strict';
    if (window.CRUploads) return;

    // 2 MB: a page change loses at most the part in flight, a few seconds on mobile data
    var CHUNK_SIZE = 2 * 1024 * 1024;
    var MAX_RETRIES = 5;
    var DB_NAME = 'comicroom-uploads';
    var STORE = 'uploads';
    var LOCK_NAME = 'comicroom-upload-sender';
    // states: queued | sending | waiting (offline / other tab) | error | needs-file | login | done
    var uploads = new Map();           // id -> { record, state, sent, error, jobId }
    var memoryFiles = new Map();       // id -> File, for uploads that could not be stored
    var currentXhr = null;
    var currentId = null;
    var pumping = false;
    var otherTabSending = false;
    var channel = null;
    var persistent = !!window.indexedDB;

    try { channel = new BroadcastChannel('comicroom-uploads'); } catch (e) { channel = null; }

    // ---------- IndexedDB ----------
    var dbPromise = null;
    function openDb() {
        if (!window.indexedDB) return Promise.reject(new Error('no IndexedDB'));
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve, reject) {
            var request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = function () {
                request.result.createObjectStore(STORE, { keyPath: 'id' });
            };
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error); };
            request.onblocked = function () { reject(new Error('IndexedDB blocked')); };
        });
        dbPromise.catch(function () { dbPromise = null; });
        return dbPromise;
    }
    function tx(mode, work) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var transaction = db.transaction(STORE, mode);
                var store = transaction.objectStore(STORE);
                var result = work(store);
                transaction.oncomplete = function () { resolve(result && 'result' in result ? result.result : undefined); };
                transaction.onerror = function () { reject(transaction.error); };
                transaction.onabort = function () { reject(transaction.error || new Error('aborted')); };
            });
        });
    }
    function dbAll() { return tx('readonly', function (store) { return store.getAll(); }).then(function (rows) { return rows || []; }); }
    function dbPut(record) { return tx('readwrite', function (store) { return store.put(record); }); }
    function dbDelete(id) { return tx('readwrite', function (store) { return store.delete(id); }); }

    // ---------- state & events ----------
    function snapshot() {
        return Array.from(uploads.values()).sort(function (a, b) {
            return a.record.createdAt - b.record.createdAt;
        }).map(function (u) {
            return {
                id: u.record.id, name: u.record.name, size: u.record.size,
                sent: Math.min(u.sent || 0, u.record.size), state: u.state, error: u.error || '',
                jobId: u.jobId || null, persisted: !!u.record.persisted
            };
        });
    }
    function emit(remote) {
        var list = snapshot();
        document.dispatchEvent(new CustomEvent('cr:upload-progress', { detail: { uploads: list } }));
        if (!remote && channel) {
            try { channel.postMessage({ type: 'progress', uploads: list }); } catch (e) {}
        }
    }
    function setState(u, state, error) {
        u.state = state;
        u.error = error || '';
        emit();
    }

    // Last amount the server confirmed, so a new page shows it at once instead of
    // 0 while it asks the server again. Kept outside IndexedDB: rewriting the
    // record there could copy the whole stored file each time.
    var SENT_KEY = 'cr-upload-sent:';
    function rememberSent(id, bytes) {
        try { localStorage.setItem(SENT_KEY + id, String(bytes)); } catch (e) {}
    }
    function recalledSent(id) {
        try { return Number(localStorage.getItem(SENT_KEY + id)) || 0; } catch (e) { return 0; }
    }
    function forgetSent(id) {
        try { localStorage.removeItem(SENT_KEY + id); } catch (e) {}
    }

    function getFile(u) {
        return u.record.file || memoryFiles.get(u.record.id) || null;
    }

    // ---------- server calls ----------
    function getJson(url, options) {
        return fetch(url, Object.assign({ credentials: 'same-origin', headers: { Accept: 'application/json' } }, options || {}))
            .catch(function () {
                var e = new Error('Cannot reach the server.');
                e.network = true;
                throw e;
            })
            .then(function (response) {
                if (response.status === 401 || response.redirected) {
                    var err = new Error('Log in again to continue the upload.');
                    err.login = true;
                    throw err;
                }
                return response.json().catch(function () { return {}; }).then(function (data) {
                    if (!response.ok) {
                        var e = new Error(data.error || ('Server error (HTTP ' + response.status + ').'));
                        e.status = response.status;
                        e.network = response.status === 502 || response.status === 503 || response.status === 504;
                        throw e;
                    }
                    return data;
                });
            });
    }

    function expectedSize(record, index) {
        return Math.min(record.chunkSize, record.size - index * record.chunkSize);
    }

    function sendChunk(u, file, index, onProgress) {
        var record = u.record;
        return new Promise(function (resolve, reject) {
            var start = index * record.chunkSize;
            var end = Math.min(start + record.chunkSize, record.size);
            var form = new FormData();
            form.append('chunk', file.slice(start, end));
            form.append('chunkIndex', index);
            form.append('totalChunks', record.totalChunks);
            form.append('fileName', record.name);
            form.append('uploadId', record.id);
            if (record.isPrivate) form.append('private', '1');

            var xhr = new XMLHttpRequest();
            currentXhr = xhr;
            var last = index === record.totalChunks - 1;
            xhr.timeout = last ? 10 * 60 * 1000 : 90000;
            xhr.upload.onprogress = function (event) {
                if (event.lengthComputable) onProgress(Math.min(event.loaded / event.total, 1) * (end - start));
            };
            xhr.onload = function () {
                currentXhr = null;
                var data = null;
                try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
                if (xhr.status === 200 && data) return resolve(data);
                var err;
                if (xhr.status === 401 || (xhr.status === 200 && !data)) {
                    err = new Error('Log in again to continue the upload.');
                    err.login = true;
                } else {
                    err = new Error((data && data.error) || ('Server error (HTTP ' + xhr.status + ').'));
                    err.fatal = xhr.status === 400 || xhr.status === 403 || xhr.status === 413;
                    // 502/503/504: the app is restarting behind the proxy
                    err.network = xhr.status === 0 || xhr.status === 502 || xhr.status === 503 || xhr.status === 504;
                }
                reject(err);
            };
            xhr.onerror = function () { currentXhr = null; var e = new Error('Cannot reach the server.'); e.network = true; reject(e); };
            xhr.ontimeout = function () { currentXhr = null; var e = new Error('The server took too long to respond.'); e.network = true; reject(e); };
            xhr.onabort = function () { currentXhr = null; var e = new Error('stopped'); e.aborted = true; reject(e); };
            xhr.open('POST', '/comic/upload-chunk');
            xhr.setRequestHeader('Accept', 'application/json');
            xhr.send(form);
        });
    }

    function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

    // ---------- the sending loop for one upload ----------
    async function runUpload(u) {
        var record = u.record;
        var file = getFile(u);
        if (!file) { setState(u, 'needs-file', 'Choose the file again to continue.'); return; }

        currentId = record.id;
        setState(u, 'sending');
        var statusUrl = '/comic/upload-chunk/' + encodeURIComponent(record.id);
        var status = await patiently(u, function () { return getJson(statusUrl); });
        while (status.status === 'assembling') {
            await sleep(3000);
            status = await patiently(u, function () { return getJson(statusUrl); });
        }
        if (status.status === 'complete') return finish(u, status.jobId);

        var have = new Set();
        (status.received || []).forEach(function (part) {
            if (part.index < record.totalChunks && part.size === expectedSize(record, part.index)) have.add(part.index);
        });
        var confirmed = 0;
        have.forEach(function (index) { confirmed += expectedSize(record, index); });
        u.sent = confirmed;
        rememberSent(record.id, confirmed);
        emit();

        for (var index = 0; index < record.totalChunks; index++) {
            if (have.has(index)) continue;
            if (!uploads.has(record.id)) return; // cancelled
            var attempt = 0;
            while (true) {
                try {
                    var base = confirmed;
                    var lastEmit = 0;
                    var result = await sendChunk(u, file, index, function (partSent) {
                        u.sent = base + partSent;
                        var now = Date.now();
                        if (now - lastEmit > 250) { lastEmit = now; emit(); }
                    });
                    serverWaits = 0;
                    confirmed += expectedSize(record, index);
                    u.sent = confirmed;
                    rememberSent(record.id, confirmed);
                    emit();
                    if (result.status === 'complete' && result.jobId) return finish(u, result.jobId);
                    if (result.status === 'assembling') {
                        while (true) {
                            await sleep(3000);
                            var again = await patiently(u, function () { return getJson(statusUrl); });
                            if (again.status === 'complete') return finish(u, again.jobId);
                            if (again.status !== 'assembling') break;
                        }
                    }
                    break;
                } catch (error) {
                    if (error.aborted) throw error;
                    if (error.login || error.fatal) throw error;
                    if (navigator.onLine === false) {
                        setState(u, 'waiting', 'Waiting for a connection...');
                        await waitForOnline();
                        setState(u, 'sending');
                        continue;
                    }
                    if (error.network) {
                        // Server restarting or connection dropped: keep trying, without a limit
                        await waitForServer(u, error);
                        continue;
                    }
                    attempt++;
                    if (attempt >= MAX_RETRIES) throw error;
                    setState(u, 'sending', error.message + ' Retrying...');
                    await sleep(Math.min(30000, Math.pow(2, attempt) * 1000));
                }
            }
        }
        // Every part sent but no job reported (e.g. the reply to the last part got lost)
        var final = await patiently(u, function () { return getJson(statusUrl); });
        if (final.status === 'complete') return finish(u, final.jobId);
        throw new Error('The server did not confirm the upload. Try again.');
    }

    // Waits with growing pauses (up to 30 s) until the server answers again.
    var serverWaits = 0;
    async function waitForServer(u, error) {
        serverWaits++;
        setState(u, 'waiting', error.message + ' Trying again...');
        if (navigator.onLine === false) await waitForOnline();
        await sleep(Math.min(30000, 2000 * Math.pow(1.6, Math.min(serverWaits, 8))));
        setState(u, 'sending');
    }

    // Runs a status request, retrying through network failures (e.g. a server restart).
    async function patiently(u, request) {
        while (true) {
            try {
                var result = await request();
                serverWaits = 0;
                return result;
            } catch (error) {
                if (!error.network) throw error;
                await waitForServer(u, error);
            }
        }
    }

    function waitForOnline() {
        return new Promise(function (resolve) {
            if (navigator.onLine !== false) return resolve();
            window.addEventListener('online', function on() { window.removeEventListener('online', on); resolve(); });
        });
    }

    function finish(u, jobId) {
        var record = u.record;
        u.sent = record.size;
        u.jobId = jobId;
        u.state = 'done';
        memoryFiles.delete(record.id);
        dbDelete(record.id).catch(function () {});
        forgetSent(record.id);
        emit();
        document.dispatchEvent(new CustomEvent('cr:upload-done', { detail: { id: record.id, name: record.name, jobId: jobId } }));
        if (channel) { try { channel.postMessage({ type: 'done', id: record.id, name: record.name, jobId: jobId }); } catch (e) {} }
        if (window.ComicRoomShell && window.ComicRoomShell.refreshUploads) window.ComicRoomShell.refreshUploads();
        // Finished uploads drop out of the list after a moment
        setTimeout(function () { if (uploads.get(record.id) === u) { uploads.delete(record.id); emit(); } }, 15000);
    }

    // ---------- pump: send queued uploads one after another ----------
    function nextPending() {
        return snapshot().map(function (s) { return uploads.get(s.id); }).find(function (u) {
            return u.state === 'queued' || u.state === 'sending' || u.state === 'waiting';
        });
    }

    async function pumpLocked() {
        var u;
        while ((u = nextPending())) {
            try {
                await runUpload(u);
            } catch (error) {
                currentId = null;
                if (!uploads.has(u.record.id)) continue; // cancelled meanwhile
                if (error.aborted) { setState(u, 'queued'); return; } // page is going away
                if (error.login) { setState(u, 'login', error.message); return; }
                setState(u, 'error', error.message || 'Upload failed.');
                if (error.fatal) dbDelete(u.record.id).catch(function () {});
            }
            currentId = null;
        }
    }

    function pump() {
        if (pumping) return;
        if (!nextPending()) return;
        pumping = true;
        var run = function () { return pumpLocked().finally(function () { pumping = false; }); };
        if (navigator.locks && navigator.locks.request) {
            navigator.locks.request(LOCK_NAME, { ifAvailable: true }, function (lock) {
                if (!lock) {
                    // Another tab is sending; it broadcasts progress. Check again later.
                    otherTabSending = true;
                    pumping = false;
                    setTimeout(pump, 5000);
                    return undefined;
                }
                otherTabSending = false;
                return run();
            }).catch(function () { pumping = false; });
        } else {
            run();
        }
    }

    // ---------- public API ----------
    function newId() {
        return 'upload_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
    }

    // options.private: the comics made from this file are visible to the uploader only
    async function start(file, options) {
        var record = {
            id: newId(), name: file.name, size: file.size, lastModified: file.lastModified || 0,
            isPrivate: !!(options && options.private),
            chunkSize: CHUNK_SIZE, totalChunks: Math.max(1, Math.ceil(file.size / CHUNK_SIZE)),
            createdAt: Date.now(), persisted: false, file: file
        };
        try {
            await dbPut(record);
            record.persisted = true;
        } catch (error) {
            // Not storable (private mode, quota): keep it in memory for this page only
            record.file = null;
            memoryFiles.set(record.id, file);
            persistent = false;
        }
        uploads.set(record.id, { record: record, state: 'queued', sent: 0 });
        emit();
        pump();
        return record.id;
    }

    function cancel(id) {
        var u = uploads.get(id);
        uploads.delete(id);
        memoryFiles.delete(id);
        if (currentId === id && currentXhr) { try { currentXhr.abort(); } catch (e) {} }
        dbDelete(id).catch(function () {});
        forgetSent(id);
        if (channel) { try { channel.postMessage({ type: 'cancel', id: id }); } catch (e) {} }
        fetch('/comic/upload-chunk/' + encodeURIComponent(id) + '/cancel', { method: 'POST', credentials: 'same-origin' }).catch(function () {});
        emit();
        return !!u;
    }

    function resume(id) {
        var u = uploads.get(id);
        if (!u || u.state === 'done') return;
        setState(u, getFile(u) ? 'queued' : 'needs-file', getFile(u) ? '' : 'Choose the file again to continue.');
        pump();
    }

    function attachFile(id, file) {
        var u = uploads.get(id);
        if (!u || !file || file.name !== u.record.name || file.size !== u.record.size) return false;
        memoryFiles.set(id, file);
        u.record.file = file;
        dbPut(Object.assign({}, u.record, { file: file })).then(function () { u.record.persisted = true; }).catch(function () {});
        resume(id);
        return true;
    }

    window.CRUploads = {
        start: start,
        cancel: cancel,
        resume: resume,
        attachFile: attachFile,
        list: snapshot,
        isSending: function () { return pumping || otherTabSending; },
        get persistent() { return persistent; }
    };

    // ---------- other tabs ----------
    if (channel) {
        channel.onmessage = function (event) {
            var data = event.data || {};
            if (data.type === 'progress' && Array.isArray(data.uploads) && !pumping) {
                data.uploads.forEach(function (s) {
                    var u = uploads.get(s.id);
                    if (!u) return;
                    u.sent = s.sent; u.state = s.state; u.error = s.error; u.jobId = s.jobId;
                });
                emit(true);
            } else if (data.type === 'done' || data.type === 'cancel') {
                var u = uploads.get(data.id);
                if (u && data.type === 'done') { u.state = 'done'; u.jobId = data.jobId; u.sent = u.record.size; }
                if (data.type === 'cancel') uploads.delete(data.id);
                emit(true);
                if (data.type === 'done') {
                    document.dispatchEvent(new CustomEvent('cr:upload-done', { detail: { id: data.id, name: data.name, jobId: data.jobId, otherTab: true } }));
                }
            }
        };
    }

    // ---------- toast on pages other than the upload page ----------
    function showToast(detail) {
        if (/^\/comic\/upload\/?$/.test(location.pathname) || detail.otherTab) return;
        var toast = document.createElement('div');
        toast.setAttribute('role', 'status');
        toast.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(var(--cr-bottom-nav-h,0px) + env(safe-area-inset-bottom,0px) + 16px);'
            + 'z-index:2000;max-width:min(92vw,420px);background:var(--cr-surface-2,#26262b);color:var(--cr-text,#ededf0);border:1px solid var(--cr-border,#34343b);'
            + 'border-left:4px solid var(--cr-success,#4ade80);border-radius:var(--cr-radius-sm,10px);padding:.75rem 1rem;box-shadow:var(--cr-shadow,0 8px 24px rgba(0,0,0,.4));'
            + 'font-size:.95rem;display:flex;gap:.75rem;align-items:center;';
        var text = document.createElement('span');
        text.textContent = '"' + detail.name + '" is uploaded and being processed.';
        toast.appendChild(text);
        if (detail.jobId) {
            var link = document.createElement('a');
            link.href = '/comic/status/' + encodeURIComponent(detail.jobId);
            link.textContent = 'View';
            link.style.cssText = 'color:var(--cr-accent,#f5a524);font-weight:700;white-space:nowrap;min-height:44px;display:inline-flex;align-items:center;';
            toast.appendChild(link);
        }
        document.body.appendChild(toast);
        setTimeout(function () { toast.remove(); }, 8000);
    }
    document.addEventListener('cr:upload-done', function (event) { showToast(event.detail); });

    // ---------- start-up: continue stored uploads ----------
    function boot() {
        dbAll().then(function (rows) {
            rows.forEach(function (record) {
                if (uploads.has(record.id)) return;
                record.persisted = true;
                var hasFile = !!record.file;
                uploads.set(record.id, { record: record, state: hasFile ? 'queued' : 'needs-file', sent: Math.min(recalledSent(record.id), record.size), error: hasFile ? '' : 'Choose the file again to continue.' });
            });
            emit();
            pump();
        }).catch(function () { persistent = false; });
    }
    window.addEventListener('online', pump);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') pump(); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
