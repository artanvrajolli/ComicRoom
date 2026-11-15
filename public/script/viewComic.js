/* ComicRoom image reader.
 * Paged mode (fit screen / width / height / original, zoom + pan) and a
 * vertical scroll (webtoon) mode with lazy, memory-bounded page loading.
 * Talks to the service worker for offline saving (CACHE_COMIC / GET_OFFLINE_STATUS).
 */
(function () {
    'use strict';

    var body = document.body;
    var root = document.documentElement;
    var ds = body ? body.dataset : {};

    // ------------------------------------------------------------------
    // Data
    // ------------------------------------------------------------------
    var comicImages = [];
    try {
        if (ds.comicImages) {
            comicImages = JSON.parse(decodeURIComponent(ds.comicImages));
        } else if (Array.isArray(window.comicImages)) {
            comicImages = window.comicImages;
        }
    } catch (error) {
        comicImages = [];
    }
    if (!Array.isArray(comicImages)) {
        comicImages = [];
    }

    var total = comicImages.length;
    var comicId = parseInt(ds.comicId || window.comicId || '0', 10) || 0;
    var comicFolder = ds.comicFolder || window.comicFolder || '';
    var signedIn = ds.signedIn !== '0';

    var MODES = ['paged', 'scroll'];
    var FITS = ['contain', 'width', 'height', 'original'];
    var FIT_LABELS = { contain: 'Fit screen', width: 'Fit width', height: 'Fit height', original: 'Original size' };
    var FIT_ICONS = { contain: 'fa-compress-arrows-alt', width: 'fa-arrows-alt-h', height: 'fa-arrows-alt-v', original: 'fa-image' };
    var PREFS_KEY = 'comicroom.reader.prefs';
    var MODE_KEY = comicFolder + '__readerMode';
    var CHROME_HIDE_DELAY = 2500;
    var PERSIST_DELAY = 1200;
    var SCROLL_KEEP_RADIUS = 10;

    var reduceMotion = false;
    try {
        reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (error) {}

    function mediaMatches(query) {
        try {
            return window.matchMedia(query).matches;
        } catch (error) {
            return false;
        }
    }

    // Phones/tablets driven by touch (no hover, coarse pointer).
    function isTouchUi() {
        return mediaMatches('(hover: none) and (pointer: coarse)');
    }

    // A phone held sideways: short and touch-driven (tablets stay > 500px tall).
    function isLandscapePhone() {
        return isTouchUi() && mediaMatches('(orientation: landscape) and (max-height: 500px)');
    }

    // Bottom-sheet presentation of the info panel (matches reader.css).
    function isSheetLayout() {
        return mediaMatches('(max-width: 575.98px)');
    }

    function isStandalone() {
        return mediaMatches('(display-mode: standalone)') || window.navigator.standalone === true;
    }

    // Data saver / very slow network: preload less and never auto-download.
    function connectionInfo() {
        try {
            var connection = navigator.connection;
            if (!connection) {
                return { constrained: false, saveData: false };
            }
            var saveData = !!connection.saveData;
            var slow = /(^|-)2g$/.test(String(connection.effectiveType || ''));
            return { constrained: saveData || slow, saveData: saveData };
        } catch (error) {
            return { constrained: false, saveData: false };
        }
    }

    function connectionConstrained() {
        return connectionInfo().constrained;
    }

    // ------------------------------------------------------------------
    // Elements
    // ------------------------------------------------------------------
    function byId(id) {
        return document.getElementById(id);
    }

    var mainImage = byId('mainImage');
    var pagedReader = byId('pagedReader');
    var scrollReader = byId('scrollReader');
    var topbar = byId('readerTopbar');
    var bottombar = byId('readerBottombar');
    var modeToggle = byId('modeToggle');
    var fitToggle = byId('fitToggle');
    var zoomToggleButton = byId('zoomToggle');
    var offlineToggleButton = byId('offlineToggle');
    var offlineSaveButton = byId('offlineSaveButton');
    var offlineStatusText = byId('offlineStatusText');
    var offlineProgress = byId('offlineProgress');
    var offlineProgressBar = byId('offlineProgressBar');
    var fullScreenButton = byId('fullScreen_icon');
    var infoToggle = byId('infoToggle');
    var infoDrawer = byId('readerInfo');
    var infoBackdrop = byId('readerBackdrop');
    var closeInfoButton = byId('closeInfoComic');
    var prevButton = byId('prevPage');
    var nextButton = byId('nextPage');
    var pageSlider = byId('pageSlider');
    var pageIndicator = byId('pageIndicator');
    var currentPageEl = byId('currentPage');
    var totalPageEl = byId('totalPage');
    var jumpForm = byId('jumpForm');
    var jumpInput = byId('jumpInput');
    var endCard = byId('endCard');
    var endCardInner = byId('endCardInner');
    var loadingEl = byId('pageLoading');
    var errorEl = byId('pageError');
    var retryButton = byId('pageRetry');
    var toastEl = byId('readerToast');
    var flashEl = byId('pageFlash');
    var srStatus = byId('srStatus');
    var hintPrev = byId('hintPrev');
    var hintNext = byId('hintNext');
    var sliderWrap = byId('sliderWrap');
    var scrubBubble = byId('scrubBubble');
    var gestureHint = byId('gestureHint');
    var gestureHintClose = byId('gestureHintClose');
    var wakeLockToggle = byId('wakeLockToggle');
    var wakeLockNote = byId('wakeLockNote');
    var sheetFullscreenButton = byId('sheetFullscreen');
    var dataSaverNote = byId('dataSaverNote');

    // ------------------------------------------------------------------
    // Storage (localStorage can throw in private mode / blocked storage)
    // ------------------------------------------------------------------
    function storageGet(key) {
        try {
            return window.localStorage.getItem(key);
        } catch (error) {
            return null;
        }
    }

    function storageSet(key, value) {
        try {
            window.localStorage.setItem(key, String(value));
        } catch (error) {}
    }

    function readPrefs() {
        try {
            var parsed = JSON.parse(storageGet(PREFS_KEY) || '{}');
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (error) {
            return {};
        }
    }

    var prefs = readPrefs();

    function savePrefs() {
        storageSet(PREFS_KEY, JSON.stringify(prefs));
    }

    var readerMode = storageGet(MODE_KEY) || prefs.mode || 'paged';
    if (MODES.indexOf(readerMode) === -1) {
        readerMode = 'paged';
    }
    // A fit the reader picked explicitly always wins. Without one, landscape
    // phones default to fit width (pages are unreadably small otherwise).
    function userFit() {
        return FITS.indexOf(prefs.fit) !== -1 ? prefs.fit : null;
    }

    function autoFit() {
        return isLandscapePhone() ? 'width' : 'contain';
    }

    var fitMode = userFit() || autoFit();

    // ------------------------------------------------------------------
    // Initial page: URL hash (#p=N) > server last-read page > local fallback
    // ------------------------------------------------------------------
    function pageFromHash() {
        var match = /(?:^#|[#&])p=(\d+)/.exec(window.location.hash || '');
        return match ? parseInt(match[1], 10) - 1 : -1;
    }

    var serverPage = parseInt(ds.pageNumber || window.lastTime || '0', 10);
    var localPage = parseInt(storageGet(comicFolder) || '0', 10);
    var hashPage = pageFromHash();
    var current = 0;

    if (hashPage >= 0 && hashPage < total) {
        current = hashPage;
    } else if (serverPage > 0 && serverPage < total) {
        current = serverPage;
    } else if (localPage > 0 && localPage < total) {
        current = localPage;
    }

    function buildImageUrl(index) {
        return '/public/uploads/' + encodeURIComponent(comicFolder) + '/' +
            String(comicImages[index]).split('/').map(encodeURIComponent).join('/');
    }

    function clampIndex(index) {
        return Math.max(0, Math.min(total - 1, index));
    }

    // ------------------------------------------------------------------
    // Small UI helpers
    // ------------------------------------------------------------------
    var toastTimer = null;
    function showToast(message, duration) {
        if (!toastEl) {
            return;
        }
        toastEl.textContent = message;
        toastEl.classList.add('is-visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toastEl.classList.remove('is-visible');
        }, duration || 1600);
    }

    var flashTimer = null;
    function flashPageNumber() {
        if (!flashEl || chromeVisible || readerMode !== 'paged') {
            return;
        }
        flashEl.textContent = (current + 1) + ' / ' + total;
        flashEl.classList.add('is-visible');
        clearTimeout(flashTimer);
        flashTimer = setTimeout(function () {
            flashEl.classList.remove('is-visible');
        }, 900);
    }

    var srTimer = null;
    function announcePage() {
        if (!srStatus) {
            return;
        }
        clearTimeout(srTimer);
        srTimer = setTimeout(function () {
            srStatus.textContent = 'Page ' + (current + 1) + ' of ' + total;
        }, 400);
    }

    function nudge(direction) {
        if (reduceMotion || !mainImage || readerMode !== 'paged') {
            return;
        }
        var className = direction < 0 ? 'rd-nudge-left' : 'rd-nudge-right';
        mainImage.classList.remove('rd-nudge-left', 'rd-nudge-right');
        void mainImage.offsetWidth;
        mainImage.classList.add(className);
    }

    if (mainImage) {
        mainImage.addEventListener('animationend', function () {
            mainImage.classList.remove('rd-nudge-left', 'rd-nudge-right');
        });
    }

    // ------------------------------------------------------------------
    // Auto-hiding chrome (top + bottom bars)
    // ------------------------------------------------------------------
    var chromeVisible = true;
    var chromeTimer = null;
    var pointerOverChrome = false;
    var sliderDragging = false;

    function isOpen(element) {
        return !!element && !element.hidden;
    }

    function chromeIsPinned() {
        if (pointerOverChrome || sliderDragging || drawerOpen || isOpen(jumpForm) || isOpen(endCard)) {
            return true;
        }
        var active = document.activeElement;
        if (active && active !== body && ((topbar && topbar.contains(active)) || (bottombar && bottombar.contains(active)))) {
            try {
                return active.matches(':focus-visible');
            } catch (error) {
                return false;
            }
        }
        return false;
    }

    function scheduleChromeHide() {
        clearTimeout(chromeTimer);
        chromeTimer = setTimeout(hideChrome, CHROME_HIDE_DELAY);
    }

    function showChrome() {
        if (!chromeVisible) {
            chromeVisible = true;
            body.classList.remove('chrome-hidden');
            if (flashEl) {
                flashEl.classList.remove('is-visible');
            }
        }
        scheduleChromeHide();
    }

    function hideChrome() {
        clearTimeout(chromeTimer);
        if (chromeIsPinned()) {
            scheduleChromeHide();
            return;
        }
        chromeVisible = false;
        body.classList.add('chrome-hidden');
    }

    function toggleChrome() {
        if (chromeVisible) {
            hideChrome();
        } else {
            showChrome();
        }
    }

    var canHover = false;
    try {
        canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    } catch (error) {}

    // Touch taps can be followed by synthetic "mouse" pointer events; never let
    // them pin the toolbar open on touch screens.
    document.addEventListener('pointerdown', function (event) {
        if (event.pointerType !== 'mouse') {
            pointerOverChrome = false;
        }
    }, true);

    [topbar, bottombar].forEach(function (bar) {
        if (!bar) {
            return;
        }
        bar.addEventListener('pointerenter', function (event) {
            if (event.pointerType === 'mouse' && canHover) {
                pointerOverChrome = true;
                showChrome();
            }
        });
        bar.addEventListener('pointerleave', function (event) {
            if (event.pointerType === 'mouse') {
                pointerOverChrome = false;
                scheduleChromeHide();
            }
        });
        bar.addEventListener('focusin', showChrome);
    });

    var lastPointerX = -1;
    var lastPointerY = -1;
    document.addEventListener('pointermove', function (event) {
        if (event.pointerType !== 'mouse') {
            return;
        }
        // Ignore sub-pixel jitter and synthetic moves with no real motion.
        if (Math.abs(event.clientX - lastPointerX) + Math.abs(event.clientY - lastPointerY) < 4) {
            return;
        }
        lastPointerX = event.clientX;
        lastPointerY = event.clientY;
        showChrome();
    }, { passive: true });

    // ------------------------------------------------------------------
    // Indicators, URL state and persistence
    // ------------------------------------------------------------------
    function updateIndicators() {
        var pageNumber = total === 0 ? 0 : current + 1;
        if (currentPageEl) {
            currentPageEl.textContent = pageNumber;
        }
        if (totalPageEl) {
            totalPageEl.textContent = total;
        }
        if (pageSlider && !sliderDragging) {
            pageSlider.value = pageNumber;
        }
        updateSliderFill();
        if (pageSlider) {
            pageSlider.setAttribute('aria-valuetext', 'Page ' + pageNumber + ' of ' + total);
        }
        if (pageIndicator) {
            pageIndicator.setAttribute('aria-label', 'Page ' + pageNumber + ' of ' + total + '. Go to page');
        }
        if (prevButton) {
            prevButton.disabled = current <= 0;
        }
        if (nextButton) {
            nextButton.disabled = total === 0;
        }
        if (hintPrev) {
            hintPrev.classList.toggle('is-disabled', current <= 0 || readerMode !== 'paged');
        }
        if (hintNext) {
            hintNext.classList.toggle('is-disabled', readerMode !== 'paged');
        }
    }

    function updateSliderFill() {
        if (!pageSlider) {
            return;
        }
        var max = parseInt(pageSlider.max, 10) || 1;
        var value = parseInt(pageSlider.value, 10) || 1;
        var percent = max > 1 ? ((value - 1) / (max - 1)) * 100 : 100;
        pageSlider.style.setProperty('--rd-fill', percent + '%');
    }

    var urlTimer = null;
    function updateUrl() {
        clearTimeout(urlTimer);
        urlTimer = setTimeout(function () {
            try {
                var target = window.location.pathname + window.location.search + '#p=' + (current + 1);
                if (window.location.hash !== '#p=' + (current + 1)) {
                    window.history.replaceState(window.history.state, '', target);
                }
            } catch (error) {}
        }, 150);
    }

    var lastSentPage = serverPage;
    var persistTimer = null;

    function flushPersist(keepalive) {
        clearTimeout(persistTimer);
        persistTimer = null;
        if (!signedIn || !comicId || total === 0 || current === lastSentPage) {
            return;
        }
        var page = current;
        lastSentPage = page;
        try {
            fetch('/ajax/lastpage/update/' + comicId + '/' + page, {
                method: 'PUT',
                credentials: 'same-origin',
                keepalive: !!keepalive
            }).catch(function () {
                if (lastSentPage === page) {
                    lastSentPage = -1;
                }
            });
        } catch (error) {
            lastSentPage = -1;
        }
    }

    function persistCurrentPage() {
        storageSet(comicFolder, current);
        updateUrl();
        clearTimeout(persistTimer);
        persistTimer = setTimeout(flushPersist, PERSIST_DELAY);
    }

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') {
            flushPersist(true);
        }
    });
    window.addEventListener('pagehide', function () {
        flushPersist(true);
    });

    // ------------------------------------------------------------------
    // Preloading (paged mode): next 2 + previous 1, bounded map
    // ------------------------------------------------------------------
    var preloadCache = new Map();
    var pageRatios = {};

    function rememberRatio(index, img) {
        if (img && img.naturalWidth && img.naturalHeight) {
            pageRatios[index] = { ratio: img.naturalWidth / img.naturalHeight, width: img.naturalWidth };
        }
    }

    function preload(index, highPriority) {
        if (index < 0 || index >= total) {
            return null;
        }
        var entry = preloadCache.get(index);
        if (entry) {
            return entry;
        }
        var img = new Image();
        img.decoding = 'async';
        try {
            img.fetchPriority = highPriority ? 'high' : 'low';
        } catch (error) {}
        entry = { img: img, ready: false, failed: false };
        entry.promise = new Promise(function (resolve) {
            img.onload = function () {
                var done = function () {
                    entry.ready = true;
                    rememberRatio(index, img);
                    resolve(entry);
                };
                if (typeof img.decode === 'function') {
                    img.decode().then(done, done);
                } else {
                    done();
                }
            };
            img.onerror = function () {
                entry.failed = true;
                if (preloadCache.get(index) === entry) {
                    preloadCache.delete(index);
                }
                resolve(entry);
            };
        });
        img.src = buildImageUrl(index);
        preloadCache.set(index, entry);
        return entry;
    }

    function trimPreloadCache() {
        preloadCache.forEach(function (entry, index) {
            if (index < current - 1 || index > current + 2) {
                entry.img.onload = null;
                entry.img.onerror = null;
                preloadCache.delete(index);
            }
        });
    }

    var preloadTimer = null;
    function preloadNeighbours() {
        clearTimeout(preloadTimer);
        preloadTimer = setTimeout(function () {
            trimPreloadCache();
            if (readerMode !== 'paged') {
                return;
            }
            var anchor = current;
            var first = preload(anchor + 1);
            if (connectionConstrained()) {
                return;
            }
            var chain = first ? first.promise : Promise.resolve();
            chain.then(function () {
                if (anchor !== current) {
                    return;
                }
                var second = preload(anchor + 2);
                preload(anchor - 1);
                return second ? second.promise : null;
            });
        }, 60);
    }

    // ------------------------------------------------------------------
    // Zoom / pan (fit-screen paged mode only)
    // ------------------------------------------------------------------
    var ZOOM_MIN = 1;
    var ZOOM_MAX = 4;
    var ZOOM_STEP = 2.5;
    var zoomScale = 1;
    var zoomX = 0;
    var zoomY = 0;

    function canZoom() {
        return readerMode === 'paged' && fitMode === 'contain';
    }

    function clampZoom(value) {
        return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value));
    }

    function isZoomed() {
        return zoomScale > 1.01;
    }

    function applyZoom() {
        if (!mainImage || !pagedReader) {
            return;
        }
        var rect = pagedReader.getBoundingClientRect();
        var maxX = (rect.width * (zoomScale - 1)) / 2;
        var maxY = (rect.height * (zoomScale - 1)) / 2;
        zoomX = Math.max(-maxX, Math.min(maxX, zoomX));
        zoomY = Math.max(-maxY, Math.min(maxY, zoomY));
        pagedReader.classList.toggle('is-zoomed', isZoomed());

        if (isZoomed()) {
            mainImage.style.transform = 'translate(' + zoomX + 'px, ' + zoomY + 'px) scale(' + zoomScale + ')';
        } else {
            mainImage.style.transform = '';
        }

        if (zoomToggleButton) {
            var icon = zoomToggleButton.querySelector('i');
            if (icon) {
                icon.className = 'fas ' + (isZoomed() ? 'fa-search-minus' : 'fa-search-plus');
            }
            zoomToggleButton.setAttribute('aria-pressed', isZoomed() ? 'true' : 'false');
            zoomToggleButton.setAttribute('aria-label', isZoomed() ? 'Reset zoom' : 'Zoom in');
        }
    }

    function resetZoom() {
        zoomScale = 1;
        zoomX = 0;
        zoomY = 0;
        if (mainImage) {
            mainImage.style.transformOrigin = 'center center';
        }
        applyZoom();
    }

    function setTransformOriginFromPoint(clientX, clientY) {
        if (!mainImage || !pagedReader) {
            return;
        }
        var rect = pagedReader.getBoundingClientRect();
        var originX = rect.width ? ((clientX - rect.left) / rect.width) * 100 : 50;
        var originY = rect.height ? ((clientY - rect.top) / rect.height) * 100 : 50;
        mainImage.style.transformOrigin = originX + '% ' + originY + '%';
    }

    function setZoomFromClientPoint(nextScale, clientX, clientY) {
        if (!canZoom()) {
            return;
        }
        if (!isZoomed()) {
            setTransformOriginFromPoint(clientX, clientY);
        }
        zoomScale = clampZoom(nextScale);
        if (!isZoomed()) {
            resetZoom();
            return;
        }
        applyZoom();
    }

    function toggleZoomAtClientPoint(clientX, clientY) {
        if (isZoomed()) {
            resetZoom();
            return;
        }
        setZoomFromClientPoint(ZOOM_STEP, clientX, clientY);
    }

    function zoomAtReaderCenter(nextScale) {
        if (!pagedReader) {
            return;
        }
        var rect = pagedReader.getBoundingClientRect();
        setZoomFromClientPoint(nextScale, rect.left + rect.width / 2, rect.top + rect.height / 2);
    }

    // ------------------------------------------------------------------
    // Paged rendering
    // ------------------------------------------------------------------
    var renderToken = 0;
    var loadingTimer = null;

    function setLoading(isLoading) {
        clearTimeout(loadingTimer);
        if (!loadingEl) {
            return;
        }
        if (isLoading) {
            loadingTimer = setTimeout(function () {
                loadingEl.hidden = false;
            }, 180);
        } else {
            loadingEl.hidden = true;
        }
    }

    function setError(isError) {
        if (errorEl) {
            errorEl.hidden = !isError;
        }
    }

    function resetStageScroll() {
        if (pagedReader && fitMode !== 'contain') {
            pagedReader.scrollTop = 0;
            pagedReader.scrollLeft = 0;
        }
    }

    function swapMainImage(index) {
        var url = buildImageUrl(index);
        setLoading(false);
        setError(false);
        if (mainImage.getAttribute('src') !== url) {
            mainImage.src = url;
        }
        mainImage.alt = 'Page ' + (index + 1) + ' of ' + total;
        resetStageScroll();
        if (mainImage.complete && mainImage.naturalWidth) {
            preloadNeighbours();
        }
    }

    function renderPaged() {
        if (!mainImage || total === 0) {
            return;
        }
        var index = current;
        var token = ++renderToken;
        resetZoom();
        setError(false);

        var entry = preloadCache.get(index);
        if (entry && entry.ready) {
            swapMainImage(index);
            return;
        }

        // Keep the previous page on screen (no blank flash / layout shift)
        // until the new one is decoded.
        setLoading(true);
        entry = preload(index, true);
        entry.promise.then(function (result) {
            if (token !== renderToken) {
                return;
            }
            if (result.failed) {
                setLoading(false);
                setError(true);
                return;
            }
            swapMainImage(index);
        });
    }

    if (mainImage) {
        mainImage.addEventListener('load', function () {
            rememberRatio(current, mainImage);
            preloadNeighbours();
        });
        mainImage.addEventListener('error', function () {
            if (mainImage.getAttribute('src')) {
                setLoading(false);
                setError(true);
            }
        });
    }

    if (retryButton) {
        retryButton.addEventListener('click', function () {
            preloadCache.delete(current);
            if (mainImage) {
                mainImage.removeAttribute('src');
            }
            if (readerMode === 'paged') {
                renderPaged();
            }
        });
    }

    // ------------------------------------------------------------------
    // Vertical scroll (webtoon) mode
    // ------------------------------------------------------------------
    var scrollBuilt = false;
    var scrollFigures = [];
    var nearPages = new Set();
    var loadedPages = new Set();
    var loadObserver = null;
    var currentObserver = null;
    var ignoreScrollSyncUntil = 0;

    function applyFigureRatio(figure, index) {
        var info = pageRatios[index];
        if (!info) {
            return;
        }
        figure.style.setProperty('--ar', info.ratio.toFixed(5));
        figure.style.setProperty('--nw', info.width + 'px');
    }

    function loadScrollPage(index) {
        var figure = scrollFigures[index];
        if (!figure || loadedPages.has(index)) {
            return;
        }
        var img = figure.firstChild;
        loadedPages.add(index);
        try {
            img.fetchPriority = Math.abs(index - current) <= 1 ? 'high' : 'low';
        } catch (error) {}
        img.src = img.getAttribute('data-src');
    }

    function unloadFarScrollPages() {
        loadedPages.forEach(function (index) {
            if (nearPages.has(index) || Math.abs(index - current) <= SCROLL_KEEP_RADIUS) {
                return;
            }
            var figure = scrollFigures[index];
            if (figure) {
                figure.firstChild.removeAttribute('src');
                figure.classList.remove('is-loaded');
            }
            loadedPages.delete(index);
        });
    }

    function unloadAllScrollPages() {
        loadedPages.forEach(function (index) {
            var figure = scrollFigures[index];
            if (figure) {
                figure.firstChild.removeAttribute('src');
                figure.classList.remove('is-loaded');
            }
        });
        loadedPages.clear();
        nearPages.clear();
    }

    function onScrollImageLoad(event) {
        var img = event.target;
        var figure = img.parentNode;
        if (!figure || !img.getAttribute('src')) {
            return;
        }
        var index = parseInt(figure.getAttribute('data-index'), 10);
        rememberRatio(index, img);
        applyFigureRatio(figure, index);
        figure.classList.add('is-loaded');
    }

    function buildEndBlock() {
        if (!endCardInner) {
            return null;
        }
        var block = document.createElement('section');
        block.className = 'rd-scroll-end';
        block.setAttribute('aria-label', 'End of comic');
        var inner = endCardInner.cloneNode(true);
        inner.removeAttribute('id');
        Array.prototype.forEach.call(inner.querySelectorAll('[id]'), function (node) {
            node.removeAttribute('id');
        });
        var stay = inner.querySelector('[data-reader-action="close-end"]');
        if (stay) {
            stay.parentNode.removeChild(stay);
        }
        block.appendChild(inner);
        return block;
    }

    function buildScrollReader() {
        if (scrollBuilt || !scrollReader) {
            return;
        }
        scrollBuilt = true;
        var fragment = document.createDocumentFragment();
        for (var index = 0; index < total; index += 1) {
            var figure = document.createElement('figure');
            figure.className = 'rd-scroll-page';
            figure.setAttribute('data-index', index);
            figure.setAttribute('data-label', String(index + 1));
            applyFigureRatio(figure, index);
            var img = document.createElement('img');
            img.alt = 'Page ' + (index + 1) + ' of ' + total;
            img.decoding = 'async';
            img.draggable = false;
            img.setAttribute('data-src', buildImageUrl(index));
            img.addEventListener('load', onScrollImageLoad);
            figure.appendChild(img);
            fragment.appendChild(figure);
            scrollFigures.push(figure);
        }
        var endBlock = buildEndBlock();
        if (endBlock) {
            fragment.appendChild(endBlock);
        }
        scrollReader.appendChild(fragment);

        if ('IntersectionObserver' in window) {
            var unloadTimer = null;
            loadObserver = new IntersectionObserver(function (entries) {
                var leftAny = false;
                entries.forEach(function (entry) {
                    var index = parseInt(entry.target.getAttribute('data-index'), 10);
                    if (entry.isIntersecting) {
                        nearPages.add(index);
                        if (readerMode === 'scroll') {
                            loadScrollPage(index);
                        }
                    } else {
                        nearPages.delete(index);
                        leftAny = true;
                    }
                });
                if (leftAny && readerMode === 'scroll') {
                    clearTimeout(unloadTimer);
                    unloadTimer = setTimeout(unloadFarScrollPages, 250);
                }
            }, { rootMargin: connectionConstrained() ? '50% 0px 60% 0px' : '150% 0px 150% 0px' });

            // A 1px band across the middle of the viewport decides the current page.
            currentObserver = new IntersectionObserver(function (entries) {
                if (readerMode !== 'scroll' || Date.now() < ignoreScrollSyncUntil) {
                    return;
                }
                entries.forEach(function (entry) {
                    if (entry.isIntersecting) {
                        setCurrentFromScroll(parseInt(entry.target.getAttribute('data-index'), 10));
                    }
                });
            }, { rootMargin: '-50% 0px -50% 0px', threshold: 0 });

            scrollFigures.forEach(function (figure) {
                loadObserver.observe(figure);
                currentObserver.observe(figure);
            });
        } else {
            scrollFigures.forEach(function (figure, index) {
                figure.firstChild.loading = 'lazy';
                loadScrollPage(index);
            });
        }
    }

    function setCurrentFromScroll(index) {
        if (!(index >= 0 && index < total) || index === current) {
            return;
        }
        current = index;
        updateIndicators();
        persistCurrentPage();
        unloadFarScrollPages();
    }

    var bottomCheckFrame = null;
    function onWindowScroll() {
        if (readerMode !== 'scroll' || bottomCheckFrame) {
            return;
        }
        bottomCheckFrame = window.requestAnimationFrame(function () {
            bottomCheckFrame = null;
            noteActivity();
            if (Date.now() < ignoreScrollSyncUntil || scrollFigures.length === 0) {
                return;
            }
            // Short last pages may never cross the middle line: treat "last page fully visible" as the last page.
            var lastRect = scrollFigures[total - 1].getBoundingClientRect();
            if (lastRect.bottom <= window.innerHeight && lastRect.bottom > 0) {
                setCurrentFromScroll(total - 1);
            }
        });
    }

    function scrollToPage(index, smooth) {
        var figure = scrollFigures[index];
        if (!figure) {
            return;
        }
        ignoreScrollSyncUntil = Date.now() + (smooth ? 700 : 150);
        loadScrollPage(index);
        // 'instant' overrides Bootstrap's `:root { scroll-behavior: smooth }`; animated jumps
        // would load every page in between.
        figure.scrollIntoView({ behavior: smooth && !reduceMotion ? 'smooth' : 'instant', block: 'start' });
    }

    // ------------------------------------------------------------------
    // Navigation
    // ------------------------------------------------------------------
    function goToPage(index, options) {
        if (total === 0) {
            return;
        }
        options = options || {};
        var target = clampIndex(index);
        var previous = current;
        closeEndCard();
        current = target;
        updateIndicators();
        persistCurrentPage();
        announcePage();
        noteActivity();

        if (readerMode === 'scroll') {
            if (options.scroll !== false) {
                scrollToPage(current, Math.abs(current - previous) <= 2);
            }
            unloadFarScrollPages();
            return;
        }

        if (target !== previous || options.force || !mainImage.getAttribute('src')) {
            renderPaged();
        }
        flashPageNumber();
    }

    function nextPage() {
        if (total === 0) {
            return;
        }
        if (current >= total - 1) {
            openEndCard();
            return;
        }
        goToPage(current + 1);
    }

    function prevPage() {
        if (total === 0) {
            return;
        }
        if (isOpen(endCard)) {
            closeEndCard();
            return;
        }
        if (current <= 0) {
            showToast('This is the first page');
            nudge(-1);
            return;
        }
        goToPage(current - 1);
    }

    function stageCanScroll(direction) {
        if (!pagedReader || readerMode !== 'paged' || fitMode === 'contain') {
            return false;
        }
        if (direction > 0) {
            return pagedReader.scrollTop + pagedReader.clientHeight < pagedReader.scrollHeight - 2;
        }
        return pagedReader.scrollTop > 2;
    }

    function stageScrollBy(amount) {
        if (!pagedReader) {
            return;
        }
        pagedReader.scrollBy({ top: amount, behavior: reduceMotion ? 'auto' : 'smooth' });
    }

    // Space / Shift+Space: scroll within a tall page first, then turn the page.
    function spaceStep(direction) {
        if (stageCanScroll(direction)) {
            stageScrollBy(direction * pagedReader.clientHeight * 0.85);
            return;
        }
        if (direction > 0) {
            nextPage();
        } else {
            prevPage();
        }
    }

    // ------------------------------------------------------------------
    // End of comic
    // ------------------------------------------------------------------
    var endCardReturnFocus = null;

    function openEndCard() {
        if (!endCard || !endCard.hidden) {
            return;
        }
        if (readerMode === 'scroll') {
            var endBlock = scrollReader ? scrollReader.querySelector('.rd-scroll-end') : null;
            if (endBlock) {
                endBlock.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
                return;
            }
        }
        flushPersist();
        endCardReturnFocus = document.activeElement;
        endCard.hidden = false;
        showChrome();
        var firstAction = endCard.querySelector('a, button');
        if (firstAction) {
            firstAction.focus({ preventScroll: true });
        }
    }

    function closeEndCard() {
        if (!endCard || endCard.hidden) {
            return;
        }
        endCard.hidden = true;
        if (endCardReturnFocus && typeof endCardReturnFocus.focus === 'function' && document.contains(endCardReturnFocus)) {
            endCardReturnFocus.focus({ preventScroll: true });
        }
        endCardReturnFocus = null;
    }

    document.addEventListener('click', function (event) {
        var actionEl = event.target.closest ? event.target.closest('[data-reader-action]') : null;
        if (!actionEl) {
            return;
        }
        var action = actionEl.getAttribute('data-reader-action');
        if (action === 'restart') {
            event.preventDefault();
            closeEndCard();
            goToPage(0, { force: true });
        } else if (action === 'close-end') {
            event.preventDefault();
            closeEndCard();
        }
    });

    if (endCard) {
        endCard.addEventListener('click', function (event) {
            if (event.target === endCard) {
                closeEndCard();
            }
        });
    }

    // ------------------------------------------------------------------
    // Reading mode + fit
    // ------------------------------------------------------------------
    function syncSettingButtons() {
        Array.prototype.forEach.call(document.querySelectorAll('[data-set-mode]'), function (button) {
            button.setAttribute('aria-pressed', button.getAttribute('data-set-mode') === readerMode ? 'true' : 'false');
        });
        Array.prototype.forEach.call(document.querySelectorAll('[data-set-fit]'), function (button) {
            button.setAttribute('aria-pressed', button.getAttribute('data-set-fit') === fitMode ? 'true' : 'false');
        });

        if (modeToggle) {
            var modeIcon = modeToggle.querySelector('i');
            if (modeIcon) {
                modeIcon.className = 'fas ' + (readerMode === 'scroll' ? 'fa-scroll' : 'fa-book-open');
            }
            modeToggle.setAttribute('aria-label', readerMode === 'scroll'
                ? 'Reading mode: vertical scroll. Switch to page by page'
                : 'Reading mode: page by page. Switch to vertical scroll');
        }
        if (fitToggle) {
            var fitIcon = fitToggle.querySelector('i');
            if (fitIcon) {
                fitIcon.className = 'fas ' + FIT_ICONS[fitMode];
            }
            fitToggle.setAttribute('aria-label', 'Page fit: ' + FIT_LABELS[fitMode] + '. Change fit');
        }
        if (zoomToggleButton) {
            zoomToggleButton.hidden = !canZoom();
        }
    }

    // fromAuto: an automatic (orientation-based) fit that must not be saved as the user's choice.
    function setFitMode(nextFit, announce, fromAuto) {
        if (FITS.indexOf(nextFit) === -1) {
            return;
        }
        fitMode = nextFit;
        if (!fromAuto) {
            prefs.fit = fitMode;
            savePrefs();
        }
        resetZoom();
        if (pagedReader) {
            pagedReader.setAttribute('data-fit', fitMode);
        }
        if (scrollReader) {
            scrollReader.setAttribute('data-fit', fitMode);
        }
        resetStageScroll();
        syncSettingButtons();
        if (readerMode === 'scroll') {
            scrollToPage(current, false);
        }
        if (announce) {
            showToast(FIT_LABELS[fitMode]);
        }
    }

    function applyAutoFit() {
        if (userFit()) {
            return;
        }
        var next = autoFit();
        if (next !== fitMode) {
            setFitMode(next, false, true);
        }
    }

    function cycleFit() {
        setFitMode(FITS[(FITS.indexOf(fitMode) + 1) % FITS.length], true);
    }

    function setReaderMode(nextMode, announce) {
        readerMode = nextMode === 'scroll' ? 'scroll' : 'paged';
        prefs.mode = readerMode;
        savePrefs();
        storageSet(MODE_KEY, readerMode);
        resetZoom();
        closeEndCard();

        var paged = readerMode === 'paged';
        body.classList.toggle('is-paged', paged);
        body.classList.toggle('is-scroll', !paged);
        root.classList.toggle('rd-paged', paged);
        if (pagedReader) {
            pagedReader.hidden = !paged;
        }
        if (scrollReader) {
            scrollReader.hidden = paged;
        }
        setLoading(false);
        setError(false);
        syncSettingButtons();
        updateIndicators();

        if (paged) {
            unloadAllScrollPages();
            window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
            renderPaged();
        } else {
            preloadCache.clear();
            if (mainImage) {
                mainImage.removeAttribute('src');
            }
            ignoreScrollSyncUntil = Date.now() + 400;
            buildScrollReader();
            window.requestAnimationFrame(function () {
                scrollToPage(current, false);
            });
        }
        if (announce) {
            showToast(paged ? 'Page by page' : 'Vertical scroll');
        }
    }

    if (modeToggle) {
        modeToggle.addEventListener('click', function () {
            setReaderMode(readerMode === 'paged' ? 'scroll' : 'paged', true);
        });
    }
    if (fitToggle) {
        fitToggle.addEventListener('click', cycleFit);
    }
    Array.prototype.forEach.call(document.querySelectorAll('[data-set-mode]'), function (button) {
        button.addEventListener('click', function () {
            setReaderMode(button.getAttribute('data-set-mode'));
        });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-set-fit]'), function (button) {
        button.addEventListener('click', function () {
            setFitMode(button.getAttribute('data-set-fit'));
        });
    });

    // ------------------------------------------------------------------
    // Info drawer
    // ------------------------------------------------------------------
    var drawerOpen = false;
    var drawerReturnFocus = null;

    function openDrawer() {
        if (!infoDrawer || drawerOpen) {
            return;
        }
        drawerOpen = true;
        drawerReturnFocus = document.activeElement;
        resetSheetDrag();
        infoDrawer.classList.add('is-open');
        infoDrawer.setAttribute('aria-hidden', 'false');
        if (infoBackdrop) {
            infoBackdrop.hidden = false;
        }
        if (infoToggle) {
            infoToggle.setAttribute('aria-expanded', 'true');
        }
        showChrome();
        if (closeInfoButton) {
            closeInfoButton.focus({ preventScroll: true });
        }
    }

    function closeDrawer() {
        if (!infoDrawer || !drawerOpen) {
            return;
        }
        drawerOpen = false;
        resetSheetDrag();
        infoDrawer.classList.remove('is-open');
        infoDrawer.setAttribute('aria-hidden', 'true');
        if (infoBackdrop) {
            infoBackdrop.hidden = true;
        }
        if (infoToggle) {
            infoToggle.setAttribute('aria-expanded', 'false');
        }
        var target = drawerReturnFocus && document.contains(drawerReturnFocus) ? drawerReturnFocus : infoToggle;
        if (target && typeof target.focus === 'function') {
            target.focus({ preventScroll: true });
        }
        drawerReturnFocus = null;
        scheduleChromeHide();
    }

    if (infoToggle) {
        infoToggle.addEventListener('click', function () {
            if (drawerOpen) {
                closeDrawer();
            } else {
                openDrawer();
            }
        });
    }
    if (closeInfoButton) {
        closeInfoButton.addEventListener('click', closeDrawer);
    }
    if (infoBackdrop) {
        infoBackdrop.addEventListener('click', closeDrawer);
    }

    // Bottom sheet (phones): drag down from the handle/header, or from the
    // content when it is scrolled to the top, to close.
    var sheetDrag = null;
    var drawerBody = infoDrawer ? infoDrawer.querySelector('.rd-drawer-body') : null;

    function resetSheetDrag() {
        sheetDrag = null;
        if (infoDrawer) {
            infoDrawer.classList.remove('is-dragging');
            infoDrawer.style.transform = '';
        }
        if (infoBackdrop) {
            infoBackdrop.style.opacity = '';
        }
    }

    if (infoDrawer) {
        infoDrawer.addEventListener('touchstart', function (event) {
            if (!drawerOpen || !isSheetLayout() || event.touches.length !== 1) {
                sheetDrag = null;
                return;
            }
            var target = event.target;
            var inBody = drawerBody && drawerBody.contains(target);
            if (inBody && drawerBody.scrollTop > 0) {
                sheetDrag = null;
                return;
            }
            // Leave horizontal gestures on segmented controls / inputs alone.
            sheetDrag = {
                startY: event.touches[0].clientY,
                startX: event.touches[0].clientX,
                startTime: Date.now(),
                dy: 0,
                active: false,
                fromBody: inBody
            };
        }, { passive: true });

        infoDrawer.addEventListener('touchmove', function (event) {
            if (!sheetDrag || event.touches.length !== 1) {
                return;
            }
            var dy = event.touches[0].clientY - sheetDrag.startY;
            var dx = event.touches[0].clientX - sheetDrag.startX;
            if (!sheetDrag.active) {
                if (Math.abs(dy) < 8 && Math.abs(dx) < 8) {
                    return;
                }
                // Upward or sideways first: it's a scroll, not a dismiss.
                if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
                    sheetDrag = null;
                    return;
                }
                sheetDrag.active = true;
                infoDrawer.classList.add('is-dragging');
            }
            event.preventDefault();
            sheetDrag.dy = Math.max(0, dy);
            infoDrawer.style.transform = 'translateY(' + sheetDrag.dy + 'px)';
            if (infoBackdrop) {
                var height = infoDrawer.offsetHeight || 1;
                infoBackdrop.style.opacity = String(Math.max(0.2, 1 - sheetDrag.dy / height));
            }
        }, { passive: false });

        var endSheetDrag = function (event) {
            if (!sheetDrag) {
                return;
            }
            var state = sheetDrag;
            sheetDrag = null;
            if (!state.active) {
                return;
            }
            var elapsed = Math.max(1, Date.now() - state.startTime);
            var velocity = state.dy / elapsed;
            var height = infoDrawer.offsetHeight || 400;
            infoDrawer.classList.remove('is-dragging');
            if (event.type !== 'touchcancel' && (state.dy > Math.min(120, height * 0.3) || (state.dy > 30 && velocity > 0.5))) {
                // Transition runs from the dragged position down to closed.
                closeDrawer();
            } else {
                infoDrawer.style.transform = '';
                if (infoBackdrop) {
                    infoBackdrop.style.opacity = '';
                }
            }
        };
        infoDrawer.addEventListener('touchend', endSheetDrag, { passive: true });
        infoDrawer.addEventListener('touchcancel', endSheetDrag, { passive: true });
    }

    // ------------------------------------------------------------------
    // Jump to page
    // ------------------------------------------------------------------
    function openJump() {
        if (!jumpForm || total === 0) {
            return;
        }
        jumpForm.hidden = false;
        if (pageIndicator) {
            pageIndicator.setAttribute('aria-expanded', 'true');
        }
        showChrome();
        if (jumpInput) {
            jumpInput.value = current + 1;
            jumpInput.focus();
            jumpInput.select();
        }
    }

    function closeJump(restoreFocus) {
        if (!jumpForm || jumpForm.hidden) {
            return;
        }
        jumpForm.hidden = true;
        if (pageIndicator) {
            pageIndicator.setAttribute('aria-expanded', 'false');
            if (restoreFocus) {
                pageIndicator.focus({ preventScroll: true });
            }
        }
        scheduleChromeHide();
    }

    if (pageIndicator) {
        pageIndicator.addEventListener('click', function () {
            if (isOpen(jumpForm)) {
                closeJump(true);
            } else {
                openJump();
            }
        });
    }

    if (jumpForm) {
        jumpForm.addEventListener('submit', function (event) {
            event.preventDefault();
            var value = parseInt(jumpInput ? jumpInput.value : '', 10);
            if (!(value >= 1 && value <= total)) {
                showToast('Enter a page between 1 and ' + total);
                return;
            }
            closeJump(false);
            if (document.activeElement && typeof document.activeElement.blur === 'function') {
                document.activeElement.blur();
            }
            goToPage(value - 1);
        });
        document.addEventListener('pointerdown', function (event) {
            if (isOpen(jumpForm) && !jumpForm.contains(event.target) && event.target !== pageIndicator && !(pageIndicator && pageIndicator.contains(event.target))) {
                closeJump(false);
                // The tap that dismisses the popover must not also turn the page.
                if ((pagedReader && pagedReader.contains(event.target)) || (scrollReader && scrollReader.contains(event.target))) {
                    suppressClickUntil = Date.now() + 500;
                }
            }
        });
    }

    // ------------------------------------------------------------------
    // Slider + prev/next buttons
    // ------------------------------------------------------------------
    var SLIDER_THUMB = 22;
    var scrubHideTimer = null;

    function positionScrubBubble() {
        if (!pageSlider || !scrubBubble || !sliderWrap) {
            return;
        }
        var max = parseInt(pageSlider.max, 10) || 1;
        var value = parseInt(pageSlider.value, 10) || 1;
        var fraction = max > 1 ? (value - 1) / (max - 1) : 0;
        var width = pageSlider.clientWidth || sliderWrap.clientWidth;
        var x = SLIDER_THUMB / 2 + fraction * Math.max(0, width - SLIDER_THUMB);
        // Keep the bubble on screen near the ends of the track.
        var half = (scrubBubble.offsetWidth || 64) / 2;
        var wrapRect = sliderWrap.getBoundingClientRect();
        var minX = half + 6 - wrapRect.left;
        var maxX = window.innerWidth - half - 6 - wrapRect.left;
        x = Math.max(minX, Math.min(maxX, x));
        sliderWrap.style.setProperty('--rd-thumb-x', x + 'px');
        scrubBubble.textContent = value + ' / ' + total;
    }

    function startScrub() {
        if (!sliderWrap || !pageSlider || pageSlider.disabled) {
            return;
        }
        clearTimeout(scrubHideTimer);
        positionScrubBubble();
        sliderWrap.classList.add('is-scrubbing');
    }

    function endScrub(delay) {
        if (!sliderWrap) {
            return;
        }
        clearTimeout(scrubHideTimer);
        scrubHideTimer = setTimeout(function () {
            sliderWrap.classList.remove('is-scrubbing');
        }, typeof delay === 'number' ? delay : 450);
    }

    if (pageSlider) {
        pageSlider.max = Math.max(total, 1);
        pageSlider.addEventListener('pointerdown', function () {
            sliderDragging = true;
            startScrub();
        });
        pageSlider.addEventListener('input', function () {
            sliderDragging = true;
            if (currentPageEl) {
                currentPageEl.textContent = pageSlider.value;
            }
            updateSliderFill();
            startScrub();
            showChrome();
        });
        pageSlider.addEventListener('change', function () {
            sliderDragging = false;
            endScrub();
            goToPage(parseInt(pageSlider.value, 10) - 1);
        });
        ['pointerup', 'pointercancel', 'blur'].forEach(function (type) {
            pageSlider.addEventListener(type, function () {
                sliderDragging = false;
                endScrub();
            });
        });
    }
    if (prevButton) {
        prevButton.addEventListener('click', prevPage);
    }
    if (nextButton) {
        nextButton.addEventListener('click', nextPage);
    }

    // ------------------------------------------------------------------
    // Fullscreen
    // ------------------------------------------------------------------
    function fullscreenSupported() {
        return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
    }

    // iPhone Safari has no element fullscreen; an installed app is already full screen.
    var fullscreenAvailable = fullscreenSupported() && !isStandalone();

    function isFullscreen() {
        return !!(document.fullscreenElement || document.webkitFullscreenElement);
    }

    function updateFullscreenButton() {
        if (!fullScreenButton) {
            return;
        }
        var active = isFullscreen();
        var icon = fullScreenButton.querySelector('i');
        if (icon) {
            icon.className = 'fas ' + (active ? 'fa-compress' : 'fa-expand');
        }
        fullScreenButton.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
        if (sheetFullscreenButton) {
            var sheetIcon = sheetFullscreenButton.querySelector('i');
            var sheetText = sheetFullscreenButton.querySelector('span');
            if (sheetIcon) {
                sheetIcon.className = 'fas ' + (active ? 'fa-compress' : 'fa-expand');
            }
            if (sheetText) {
                sheetText.textContent = active ? 'Exit full screen' : 'Full screen';
            }
        }
    }

    function toggleFullScreen() {
        if (!fullscreenAvailable) {
            return;
        }
        try {
            var result;
            if (!isFullscreen()) {
                var request = root.requestFullscreen || root.webkitRequestFullscreen;
                result = request ? request.call(root) : null;
            } else {
                var exit = document.exitFullscreen || document.webkitExitFullscreen;
                result = exit ? exit.call(document) : null;
            }
            if (result && typeof result.catch === 'function') {
                result.catch(function () {});
            }
        } catch (error) {}
    }

    if (!fullscreenAvailable) {
        root.classList.add('rd-no-fullscreen');
    }
    if (fullScreenButton) {
        if (!fullscreenAvailable) {
            fullScreenButton.hidden = true;
        }
        fullScreenButton.addEventListener('click', toggleFullScreen);
    }
    if (sheetFullscreenButton) {
        sheetFullscreenButton.hidden = !fullscreenAvailable;
        sheetFullscreenButton.addEventListener('click', toggleFullScreen);
    }
    document.addEventListener('fullscreenchange', updateFullscreenButton);
    document.addEventListener('webkitfullscreenchange', updateFullscreenButton);

    // ------------------------------------------------------------------
    // Keyboard
    // ------------------------------------------------------------------
    var lastRepeatAt = 0;

    function isTypingTarget(target) {
        if (!target || !target.tagName) {
            return false;
        }
        var tag = target.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
    }

    document.addEventListener('keydown', function (event) {
        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
            return;
        }
        var key = event.key;
        var target = event.target;

        if (key === 'Escape') {
            if (isOpen(gestureHint)) {
                dismissGestureHint();
            } else if (isOpen(jumpForm)) {
                closeJump(true);
            } else if (isOpen(endCard)) {
                closeEndCard();
            } else if (drawerOpen) {
                closeDrawer();
            } else if (isZoomed()) {
                resetZoom();
            } else {
                return;
            }
            event.preventDefault();
            return;
        }

        if (isTypingTarget(target) || isOpen(gestureHint)) {
            return;
        }
        // Let focused buttons/links handle Enter and Space themselves.
        var onControl = target && target.closest && target.closest('button, a, [role="button"]');
        if (onControl && (key === ' ' || key === 'Enter')) {
            return;
        }
        if (drawerOpen && key !== 'i' && key !== 'I') {
            return;
        }

        // Throttle key auto-repeat so holding an arrow flips at a readable pace.
        if (event.repeat) {
            var now = Date.now();
            if (now - lastRepeatAt < 120) {
                event.preventDefault();
                return;
            }
            lastRepeatAt = now;
        }

        var handled = true;
        switch (key) {
            case 'ArrowRight':
            case 'd':
            case 'D':
                nextPage();
                break;
            case 'ArrowLeft':
            case 'a':
            case 'A':
                prevPage();
                break;
            case ' ':
            case 'Spacebar':
                if (readerMode === 'scroll') {
                    handled = false;
                } else {
                    spaceStep(event.shiftKey ? -1 : 1);
                }
                break;
            case 'PageDown':
                if (readerMode === 'scroll') {
                    handled = false;
                } else {
                    nextPage();
                }
                break;
            case 'PageUp':
                if (readerMode === 'scroll') {
                    handled = false;
                } else {
                    prevPage();
                }
                break;
            case 'ArrowDown':
            case 'ArrowUp':
                if (stageCanScroll(key === 'ArrowDown' ? 1 : -1)) {
                    stageScrollBy((key === 'ArrowDown' ? 1 : -1) * pagedReader.clientHeight * 0.2);
                } else {
                    handled = false;
                }
                break;
            case 'Home':
                goToPage(0);
                break;
            case 'End':
                goToPage(total - 1);
                break;
            case 'r':
            case 'R':
                goToPage(0);
                break;
            case 'f':
            case 'F':
                toggleFullScreen();
                break;
            case 'g':
            case 'G':
                openJump();
                break;
            case 'i':
            case 'I':
            case '?':
                if (drawerOpen) {
                    closeDrawer();
                } else {
                    openDrawer();
                }
                break;
            case 'm':
            case 'M':
                setReaderMode(readerMode === 'paged' ? 'scroll' : 'paged', true);
                break;
            case 'w':
            case 'W':
                cycleFit();
                break;
            case '+':
            case '=':
                if (canZoom()) {
                    zoomAtReaderCenter(isZoomed() ? zoomScale + 0.5 : ZOOM_STEP);
                } else {
                    handled = false;
                }
                break;
            case '-':
            case '_':
                if (canZoom()) {
                    zoomAtReaderCenter(zoomScale - 0.5);
                } else {
                    handled = false;
                }
                break;
            case '0':
                resetZoom();
                break;
            default:
                handled = false;
        }
        if (handled) {
            event.preventDefault();
        }
    });

    // ------------------------------------------------------------------
    // Pointer / touch on the paged stage
    // ------------------------------------------------------------------
    var suppressClickUntil = 0;
    var lastCenterTap = 0;
    var centerTapTimer = null;
    var lastPointerType = 'mouse';

    document.addEventListener('pointerdown', function (event) {
        lastPointerType = event.pointerType || 'mouse';
        noteActivity();
    }, true);

    function inBarBand(clientY) {
        var topBand = topbar ? topbar.offsetHeight : 0;
        var bottomBand = bottombar ? bottombar.offsetHeight : 0;
        return clientY < topBand || clientY > window.innerHeight - bottomBand;
    }

    if (zoomToggleButton) {
        zoomToggleButton.addEventListener('click', function () {
            zoomAtReaderCenter(isZoomed() ? 1 : ZOOM_STEP);
        });
    }

    if (pagedReader) {
        pagedReader.addEventListener('click', function (event) {
            if (Date.now() < suppressClickUntil) {
                event.preventDefault();
                return;
            }
            // Touch: with the bars hidden, a tap where a bar lives brings the bars
            // back instead of turning the page (aiming for the slider is not "next").
            if (!chromeVisible && lastPointerType !== 'mouse' && inBarBand(event.clientY)) {
                lastCenterTap = 0;
                showChrome();
                return;
            }
            var rect = pagedReader.getBoundingClientRect();
            var relativeX = rect.width ? (event.clientX - rect.left) / rect.width : 0.5;
            var zoomed = isZoomed();

            // Left / right third turn pages (disabled while zoomed so taps can pan).
            if (!zoomed && relativeX < 1 / 3) {
                lastCenterTap = 0;
                prevPage();
                return;
            }
            if (!zoomed && relativeX > 2 / 3) {
                lastCenterTap = 0;
                nextPage();
                return;
            }

            // Centre: single tap toggles the controls, double tap zooms.
            var now = Date.now();
            if (now - lastCenterTap < 300) {
                clearTimeout(centerTapTimer);
                lastCenterTap = 0;
                if (canZoom()) {
                    toggleZoomAtClientPoint(event.clientX, event.clientY);
                }
                return;
            }
            lastCenterTap = now;
            clearTimeout(centerTapTimer);
            centerTapTimer = setTimeout(toggleChrome, 260);
        });

        pagedReader.addEventListener('wheel', function (event) {
            if (!event.ctrlKey || !canZoom()) {
                return;
            }
            event.preventDefault();
            if (!isZoomed()) {
                setTransformOriginFromPoint(event.clientX, event.clientY);
            }
            zoomScale = clampZoom(zoomScale + (event.deltaY < 0 ? 0.25 : -0.25));
            if (!isZoomed()) {
                resetZoom();
            } else {
                applyZoom();
            }
        }, { passive: false });

        // Mouse drag to pan when zoomed.
        var mousePan = null;
        pagedReader.addEventListener('mousedown', function (event) {
            if (event.button !== 0 || !isZoomed()) {
                return;
            }
            event.preventDefault();
            mousePan = { x: event.clientX, y: event.clientY, zx: zoomX, zy: zoomY, moved: false };
            pagedReader.classList.add('is-panning');
        });
        window.addEventListener('mousemove', function (event) {
            if (!mousePan) {
                return;
            }
            var dx = event.clientX - mousePan.x;
            var dy = event.clientY - mousePan.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) {
                mousePan.moved = true;
            }
            zoomX = mousePan.zx + dx;
            zoomY = mousePan.zy + dy;
            applyZoom();
        });
        window.addEventListener('mouseup', function () {
            if (!mousePan) {
                return;
            }
            if (mousePan.moved) {
                suppressClickUntil = Date.now() + 250;
            }
            mousePan = null;
            pagedReader.classList.remove('is-panning');
        });

        // Touch: pinch zoom, pan when zoomed, horizontal swipe to turn pages.
        var touch = null;

        function touchDistance(touches) {
            var dx = touches[0].clientX - touches[1].clientX;
            var dy = touches[0].clientY - touches[1].clientY;
            return Math.sqrt(dx * dx + dy * dy);
        }

        function setSwipeOffset(offset) {
            if (!mainImage || reduceMotion || fitMode !== 'contain') {
                return;
            }
            mainImage.style.transform = offset ? 'translateX(' + offset + 'px)' : '';
        }

        pagedReader.addEventListener('touchstart', function (event) {
            if (event.touches.length === 2 && canZoom()) {
                var midX = (event.touches[0].clientX + event.touches[1].clientX) / 2;
                var midY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
                if (!isZoomed()) {
                    setTransformOriginFromPoint(midX, midY);
                }
                setSwipeOffset(0);
                touch = { mode: 'pinch', startDistance: touchDistance(event.touches), startScale: zoomScale };
                pagedReader.classList.remove('is-panning', 'is-swiping');
                return;
            }
            if (event.touches.length !== 1) {
                touch = null;
                return;
            }
            var point = event.touches[0];
            touch = {
                mode: isZoomed() ? 'pan' : 'swipe',
                startX: point.clientX,
                startY: point.clientY,
                startTime: Date.now(),
                zx: zoomX,
                zy: zoomY,
                moved: false,
                axis: null,
                atLeftEdge: pagedReader.scrollLeft <= 2,
                atRightEdge: pagedReader.scrollLeft + pagedReader.clientWidth >= pagedReader.scrollWidth - 2
            };
            if (touch.mode === 'pan') {
                pagedReader.classList.add('is-panning');
            }
        }, { passive: true });

        pagedReader.addEventListener('touchmove', function (event) {
            if (!touch) {
                return;
            }
            if (touch.mode === 'pinch') {
                if (event.touches.length === 2) {
                    event.preventDefault();
                    if (touch.startDistance > 0) {
                        zoomScale = clampZoom(touch.startScale * (touchDistance(event.touches) / touch.startDistance));
                        applyZoom();
                    }
                }
                return;
            }
            if (event.touches.length !== 1) {
                return;
            }
            var point = event.touches[0];
            var dx = point.clientX - touch.startX;
            var dy = point.clientY - touch.startY;
            if (Math.abs(dx) + Math.abs(dy) > 8) {
                touch.moved = true;
            }

            if (touch.mode === 'pan') {
                event.preventDefault();
                zoomX = touch.zx + dx;
                zoomY = touch.zy + dy;
                applyZoom();
                return;
            }

            if (!touch.axis && touch.moved) {
                touch.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
            }
            if (touch.axis === 'x' && fitMode === 'contain') {
                event.preventDefault();
                pagedReader.classList.add('is-swiping');
                setSwipeOffset(dx * 0.35);
            }
        }, { passive: false });

        function endTouch(event) {
            if (!touch) {
                return;
            }
            var state = touch;
            touch = null;
            pagedReader.classList.remove('is-panning', 'is-swiping');

            if (state.mode === 'pinch') {
                if (zoomScale <= 1.05) {
                    resetZoom();
                }
                suppressClickUntil = Date.now() + 350;
                return;
            }
            if (state.mode === 'pan') {
                if (state.moved) {
                    suppressClickUntil = Date.now() + 350;
                }
                return;
            }

            // Swipe
            var point = event.changedTouches && event.changedTouches[0];
            if (mainImage && fitMode === 'contain' && mainImage.style.transform) {
                mainImage.classList.add('is-settling');
                setSwipeOffset(0);
                setTimeout(function () {
                    mainImage.classList.remove('is-settling');
                }, 220);
            }
            if (!point || !state.moved || event.type === 'touchcancel') {
                return;
            }
            suppressClickUntil = Date.now() + 350;
            var dx = point.clientX - state.startX;
            var dy = point.clientY - state.startY;
            var width = pagedReader.clientWidth || window.innerWidth;
            var threshold = Math.max(50, width * 0.08);
            var quick = Date.now() - state.startTime < 800;
            if (!quick || Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy) * 1.4) {
                return;
            }
            // In scrollable fits, only turn the page once the stage is at its horizontal edge.
            if (dx < 0 && (fitMode === 'contain' || state.atRightEdge)) {
                nextPage();
            } else if (dx > 0 && (fitMode === 'contain' || state.atLeftEdge)) {
                prevPage();
            }
        }

        pagedReader.addEventListener('touchend', endTouch, { passive: true });
        pagedReader.addEventListener('touchcancel', endTouch, { passive: true });
    }

    if (scrollReader) {
        scrollReader.addEventListener('click', function (event) {
            if (event.target.closest && event.target.closest('a, button')) {
                return;
            }
            if (Date.now() < suppressClickUntil) {
                return;
            }
            toggleChrome();
        });
    }

    // Mouse/touch clicks should not leave focus on toolbar buttons, otherwise
    // Space would re-trigger the last button instead of turning the page.
    document.addEventListener('click', function (event) {
        if (event.detail === 0) {
            return;
        }
        var button = event.target.closest ? event.target.closest('.rd-bar .rd-btn') : null;
        if (button && button === document.activeElement && typeof button.blur === 'function') {
            button.blur();
        }
    });

    window.addEventListener('scroll', onWindowScroll, { passive: true });

    // ------------------------------------------------------------------
    // Rotation / resize: keep the page, reset zoom, re-apply the auto fit
    // ------------------------------------------------------------------
    var viewportW = window.innerWidth;
    var viewportH = window.innerHeight;
    var resizeTimer = null;
    var resizeAnchorPage = -1;
    var stageScrollFraction = 0;

    if (pagedReader) {
        pagedReader.addEventListener('scroll', function () {
            var range = pagedReader.scrollHeight - pagedReader.clientHeight;
            stageScrollFraction = range > 0 ? pagedReader.scrollTop / range : 0;
        }, { passive: true });
    }

    function onViewportSettled() {
        var width = window.innerWidth;
        var height = window.innerHeight;
        var widthChanged = Math.abs(width - viewportW) > 1;
        var rotated = (width > height) !== (viewportW > viewportH);
        viewportW = width;
        viewportH = height;
        var anchor = resizeAnchorPage;
        resizeAnchorPage = -1;

        // Height-only changes are the mobile URL bar showing/hiding: leave the reader alone.
        if (!widthChanged && !rotated) {
            if (isZoomed()) {
                applyZoom();
            }
            return;
        }
        if (anchor >= 0 && anchor < total && anchor !== current) {
            current = anchor;
            updateIndicators();
        }
        resetZoom();
        var fitBefore = fitMode;
        applyAutoFit();
        if (readerMode === 'scroll') {
            if (fitBefore === fitMode) {
                scrollToPage(current, false);
            }
            // Pages above may still change height as their real aspect ratios load:
            // re-anchor once more unless the reader has scrolled in the meantime.
            var anchorIndex = current;
            var anchorY = window.scrollY;
            setTimeout(function () {
                var figure = scrollFigures[anchorIndex];
                if (readerMode !== 'scroll' || !figure || current !== anchorIndex || Math.abs(window.scrollY - anchorY) > 2) {
                    return;
                }
                if (Math.abs(figure.getBoundingClientRect().top) > 2) {
                    scrollToPage(anchorIndex, false);
                }
            }, 450);
        } else if (fitMode !== 'contain' && pagedReader && fitBefore === fitMode) {
            var range = pagedReader.scrollHeight - pagedReader.clientHeight;
            pagedReader.scrollTop = Math.round(stageScrollFraction * Math.max(0, range));
        }
        if (positionScrubBubble && sliderWrap && sliderWrap.classList.contains('is-scrubbing')) {
            positionScrubBubble();
        }
        if (drawerOpen) {
            resetSheetDrag();
        }
        // Bars still auto-hide after the idle delay in the new orientation.
        if (chromeVisible) {
            scheduleChromeHide();
        }
    }

    window.addEventListener('resize', function () {
        if (Math.abs(window.innerWidth - viewportW) > 1 && resizeAnchorPage < 0) {
            // Layout is about to reflow: freeze the current page against scroll sync.
            resizeAnchorPage = current;
            ignoreScrollSyncUntil = Date.now() + 600;
        }
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(onViewportSettled, 150);
    });
    window.addEventListener('hashchange', function () {
        var page = pageFromHash();
        if (page >= 0 && page < total && page !== current) {
            goToPage(page);
        }
    });

    // Discourage casual "save image as" (kept from the original reader).
    window.addEventListener('contextmenu', function (event) {
        if (event.target && event.target.closest && event.target.closest('.rd-stage, .rd-scroll')) {
            event.preventDefault();
        }
    });

    // ------------------------------------------------------------------
    // Offline saving (service worker)
    // ------------------------------------------------------------------
    var offlineState = 'idle';
    var offlineRequestPending = false;

    function buildOfflinePageUrls() {
        var urls = [];
        for (var index = 0; index < total; index += 1) {
            urls.push(buildImageUrl(index));
        }
        return urls;
    }

    function buildOfflineAssetUrls() {
        var urls = [];
        document.querySelectorAll('link[rel="stylesheet"][href], script[src]').forEach(function (node) {
            var value = node.getAttribute('href') || node.getAttribute('src') || '';
            if (value.charAt(0) === '/' && value.charAt(1) !== '/') {
                urls.push(value);
            }
        });
        return urls;
    }

    function setOfflineProgress(percent) {
        var clamped = Math.max(0, Math.min(100, Math.round(percent)));
        if (offlineToggleButton) {
            offlineToggleButton.style.setProperty('--rd-progress', clamped);
        }
        if (offlineProgressBar) {
            offlineProgressBar.style.width = clamped + '%';
        }
    }

    function setOfflineButtonState(state, label, percent) {
        offlineState = state;
        var icons = {
            saving: 'fa-cloud-download-alt',
            ready: 'fa-check-circle',
            offline: 'fa-cloud',
            error: 'fa-exclamation-circle',
            idle: 'fa-cloud-download-alt'
        };
        if (offlineToggleButton) {
            var icon = offlineToggleButton.querySelector('i');
            if (icon) {
                icon.className = 'fas ' + (icons[state] || icons.idle);
            }
            offlineToggleButton.classList.toggle('is-saving', state === 'saving');
            offlineToggleButton.classList.toggle('is-ready', state === 'ready');
            offlineToggleButton.classList.toggle('is-error', state === 'error');
            if (label) {
                offlineToggleButton.title = label;
                offlineToggleButton.setAttribute('aria-label', label);
            }
        }
        if (offlineStatusText && label) {
            offlineStatusText.textContent = label;
        }
        if (offlineProgress) {
            offlineProgress.classList.toggle('is-ready', state === 'ready');
        }
        if (typeof percent === 'number') {
            setOfflineProgress(percent);
        } else if (state === 'ready') {
            setOfflineProgress(100);
        } else if (state !== 'saving') {
            setOfflineProgress(0);
        }
        if (offlineSaveButton) {
            offlineSaveButton.disabled = state === 'saving' || state === 'ready';
            offlineSaveButton.innerHTML = state === 'ready'
                ? '<i class="fas fa-check-circle" aria-hidden="true"></i> Saved on this device'
                : (state === 'saving'
                    ? '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Saving...'
                    : '<i class="fas fa-cloud-download-alt" aria-hidden="true"></i> Save for offline');
        }
    }

    function serviceWorkerController() {
        return navigator.serviceWorker && navigator.serviceWorker.controller ? navigator.serviceWorker.controller : null;
    }

    function checkOfflineStatus() {
        var controller = serviceWorkerController();
        if (total === 0 || !controller) {
            if (!('serviceWorker' in navigator)) {
                setOfflineButtonState('offline', 'Offline reading is not supported in this browser');
            }
            return;
        }
        var channel = new MessageChannel();
        channel.port1.onmessage = function (event) {
            var data = event.data || {};
            if (data.type !== 'OFFLINE_STATUS' || !(data.total > 0) || offlineRequestPending) {
                return;
            }
            if (data.missing === 0) {
                setOfflineButtonState('ready', 'Available offline');
            } else {
                var saved = data.total - data.missing;
                setOfflineButtonState('idle', saved > 0
                    ? saved + ' of ' + data.total + ' pages saved. Save the rest for offline reading'
                    : 'Save comic for offline reading', (saved / data.total) * 100);
            }
        };
        controller.postMessage({
            type: 'GET_OFFLINE_STATUS',
            comicFolder: comicFolder,
            pageUrls: buildOfflinePageUrls()
        }, [channel.port2]);
    }

    function requestOfflineCache() {
        if (total === 0) {
            return;
        }
        var controller = serviceWorkerController();
        if (!controller) {
            setOfflineButtonState('offline', 'Offline saving is not available yet. Reload the page and try again');
            return;
        }
        if (!navigator.onLine) {
            setOfflineButtonState('offline', 'You are offline');
            return;
        }
        if (offlineRequestPending) {
            return;
        }

        offlineRequestPending = true;
        setOfflineButtonState('saving', 'Saving comic for offline reading...', 0);

        var channel = new MessageChannel();
        channel.port1.onmessage = function (event) {
            var data = event.data || {};
            if (data.type === 'CACHE_PROGRESS') {
                var done = (data.cachedCount || 0) + (data.failureCount || 0);
                setOfflineButtonState('saving', 'Saving ' + data.cachedCount + ' of ' + data.total + ' pages...', data.total ? (done / data.total) * 100 : 0);
                return;
            }
            if (data.type === 'CACHE_DONE') {
                offlineRequestPending = false;
                if (data.ok) {
                    setOfflineButtonState('ready', data.failureCount > 0
                        ? 'Available offline (' + data.failureCount + ' pages failed)'
                        : 'Available offline');
                } else {
                    setOfflineButtonState('error', data.error || 'Could not save for offline');
                }
            }
        };

        controller.postMessage({
            type: 'CACHE_COMIC',
            comicFolder: comicFolder,
            comicId: comicId,
            title: document.title,
            // No hash: the cached HTML is keyed on path + query only.
            pageUrl: window.location.pathname + window.location.search,
            pageUrls: buildOfflinePageUrls(),
            assetUrls: buildOfflineAssetUrls()
        }, [channel.port2]);
    }

    function scheduleOfflineCache() {
        if (total === 0 || !('serviceWorker' in navigator)) {
            setOfflineButtonState('offline', 'Offline reading is not supported in this browser');
            return;
        }
        var run = function () {
            checkOfflineStatus();
            // Data saver / slow network: only save when the reader asks for it.
            if (!connectionConstrained()) {
                setTimeout(function () {
                    if (!connectionConstrained()) {
                        requestOfflineCache();
                    }
                }, 1200);
            }
        };
        if (serviceWorkerController()) {
            run();
            return;
        }
        setOfflineButtonState('idle', 'Save comic for offline reading');
        navigator.serviceWorker.addEventListener('controllerchange', run, { once: true });
    }

    if (offlineToggleButton) {
        offlineToggleButton.addEventListener('click', function () {
            if (offlineState === 'ready') {
                showToast('This comic is available offline');
                return;
            }
            if (offlineState === 'saving') {
                openDrawer();
                return;
            }
            requestOfflineCache();
        });
    }
    if (offlineSaveButton) {
        offlineSaveButton.addEventListener('click', requestOfflineCache);
    }

    window.addEventListener('offline', function () {
        if (offlineState !== 'ready' && !offlineRequestPending) {
            setOfflineButtonState('offline', 'You are offline');
        }
    });
    window.addEventListener('online', checkOfflineStatus);

    // ------------------------------------------------------------------
    // Data saver note
    // ------------------------------------------------------------------
    function updateDataSaverNote() {
        if (!dataSaverNote) {
            return;
        }
        var info = connectionInfo();
        dataSaverNote.hidden = !info.constrained;
        if (info.constrained) {
            var lead = info.saveData ? 'Data saver is on' : 'Slow connection';
            dataSaverNote.innerHTML = '<i class="fas fa-leaf" aria-hidden="true"></i> <span></span>';
            dataSaverNote.querySelector('span').textContent = lead +
                ': only the next page is loaded ahead, and comics are saved for offline only when you tap Save.';
        }
    }

    try {
        if (navigator.connection && typeof navigator.connection.addEventListener === 'function') {
            navigator.connection.addEventListener('change', updateDataSaverNote);
        }
    } catch (error) {}

    // ------------------------------------------------------------------
    // Screen Wake Lock ("Keep screen on", default on)
    // ------------------------------------------------------------------
    var WAKE_IDLE_LIMIT = 10 * 60 * 1000;
    var wakeLockSupported = false;
    try {
        wakeLockSupported = !!(navigator.wakeLock && typeof navigator.wakeLock.request === 'function');
    } catch (error) {}
    var keepAwake = prefs.keepAwake !== false;
    var wakeSentinel = null;
    var wakePending = false;
    var lastActivityAt = Date.now();

    function acquireWakeLock() {
        if (!wakeLockSupported || !keepAwake || wakeSentinel || wakePending || document.visibilityState !== 'visible') {
            return;
        }
        wakePending = true;
        var request;
        try {
            request = navigator.wakeLock.request('screen');
        } catch (error) {
            wakePending = false;
            return;
        }
        Promise.resolve(request).then(function (sentinel) {
            wakePending = false;
            if (!sentinel) {
                return;
            }
            if (!keepAwake || document.visibilityState !== 'visible') {
                sentinel.release().catch(function () {});
                return;
            }
            wakeSentinel = sentinel;
            sentinel.addEventListener('release', function () {
                if (wakeSentinel === sentinel) {
                    wakeSentinel = null;
                }
            });
        }, function () {
            wakePending = false;
        });
    }

    function releaseWakeLock() {
        var sentinel = wakeSentinel;
        wakeSentinel = null;
        if (sentinel) {
            try {
                sentinel.release().catch(function () {});
            } catch (error) {}
        }
    }

    // Called on page turns, taps, keys and scrolling: re-takes the lock after an idle release.
    function noteActivity() {
        lastActivityAt = Date.now();
        if (keepAwake && !wakeSentinel) {
            acquireWakeLock();
        }
    }

    if (wakeLockSupported) {
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') {
                lastActivityAt = Date.now();
                acquireWakeLock();
            } else {
                releaseWakeLock();
            }
        });
        // Walked away from the device: let the screen sleep after a long idle period.
        setInterval(function () {
            if (wakeSentinel && Date.now() - lastActivityAt > WAKE_IDLE_LIMIT) {
                releaseWakeLock();
            }
        }, 30000);
    }

    if (wakeLockToggle) {
        wakeLockToggle.checked = keepAwake && wakeLockSupported;
        if (!wakeLockSupported) {
            wakeLockToggle.disabled = true;
            if (wakeLockNote) {
                wakeLockNote.textContent = 'Not supported in this browser.';
            }
        }
        wakeLockToggle.addEventListener('change', function () {
            keepAwake = wakeLockToggle.checked;
            prefs.keepAwake = keepAwake;
            savePrefs();
            if (keepAwake) {
                noteActivity();
            } else {
                releaseWakeLock();
            }
            showToast(keepAwake ? 'Screen stays on while reading' : 'Screen can turn off');
        });
    }

    // ------------------------------------------------------------------
    // First-run gesture hint (touch screens, shown once)
    // ------------------------------------------------------------------
    var GESTURE_HINT_KEY = 'comicroom.reader.gestureHintSeen';
    var gestureHintReturnFocus = null;

    function dismissGestureHint() {
        if (!isOpen(gestureHint)) {
            return;
        }
        gestureHint.hidden = true;
        storageSet(GESTURE_HINT_KEY, '1');
        // A dismissing tap must not reach the page underneath.
        suppressClickUntil = Date.now() + 400;
        if (gestureHintReturnFocus && typeof gestureHintReturnFocus.focus === 'function' && document.contains(gestureHintReturnFocus)) {
            gestureHintReturnFocus.focus({ preventScroll: true });
        }
        gestureHintReturnFocus = null;
        scheduleChromeHide();
    }

    function maybeShowGestureHint() {
        if (!gestureHint || total < 2 || readerMode !== 'paged' || !isTouchUi() || storageGet(GESTURE_HINT_KEY)) {
            return;
        }
        if (drawerOpen || isOpen(endCard)) {
            return;
        }
        gestureHintReturnFocus = document.activeElement;
        gestureHint.hidden = false;
        if (gestureHintClose) {
            gestureHintClose.focus({ preventScroll: true });
        }
    }

    if (gestureHint) {
        gestureHint.addEventListener('click', function (event) {
            event.preventDefault();
            dismissGestureHint();
        });
        gestureHint.addEventListener('touchmove', function (event) {
            event.preventDefault();
        }, { passive: false });
    }

    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------
    if (pagedReader) {
        pagedReader.setAttribute('data-fit', fitMode);
    }
    if (scrollReader) {
        scrollReader.setAttribute('data-fit', fitMode);
    }
    try {
        if ('scrollRestoration' in window.history) {
            window.history.scrollRestoration = 'manual';
        }
    } catch (error) {}
    updateFullscreenButton();
    setReaderMode(readerMode);
    persistCurrentPage();
    scheduleChromeHide();
    scheduleOfflineCache();
    updateDataSaverNote();
    acquireWakeLock();
    setTimeout(maybeShowGestureHint, 700);
})();
