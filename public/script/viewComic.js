var comicViewerState = document.body ? document.body.dataset : {};
var comicImages = [];
if (comicViewerState.comicImages) {
    comicImages = JSON.parse(decodeURIComponent(comicViewerState.comicImages));
} else if (Array.isArray(window.comicImages)) {
    comicImages = window.comicImages;
}

var comicId = parseInt(comicViewerState.comicId || window.comicId || '0', 10);
var comicImagesLength = comicImages.length;
var comicFolder = comicViewerState.comicFolder || window.comicFolder || '';
var mainImage = document.getElementById("mainImage");
var cachedImage = document.getElementById("cachedImage");
var closeInfoComic = document.getElementById("closeInfoComic");
var backToStart = document.getElementById("backToStart");
var leftTrigger = document.getElementById("leftTrigger");
var rightTrigger = document.getElementById("rightTrigger");
var currentPageIndicator = document.getElementById("currentPage");
var totalPageIndicator = document.getElementById("totalPage");
var infoComic = document.getElementById("infoComic");
var infoComicDetails = document.getElementById("infoComic_details");
var backToComics = document.getElementById("backToComics");
var fullScreen_icon = document.getElementById("fullScreen_icon");
var pagedReader = document.getElementById("pagedReader");
var scrollReader = document.getElementById("scrollReader");
var pagedModeButton = document.getElementById("pagedModeButton");
var scrollModeButton = document.getElementById("scrollModeButton");
var zoomToggleButton = document.getElementById("zoomToggle");
var offlineToggleButton = document.getElementById("offlineToggle");
var scrollPages = Array.from(document.querySelectorAll(".scroll-page"));
var lastTime = parseInt(comicViewerState.pageNumber || window.lastTime || '0', 10);
var savedLastPage = parseInt(window.localStorage[comicFolder] || '0', 10);
var readerModeStorageKey = `${comicFolder}__readerMode`;
var readerMode = window.localStorage[readerModeStorageKey] || 'paged';
var persistTimer = setTimeout(function(){}, 1000);
var scrollSyncFrame = null;
var xView = 0;

if (!Number.isInteger(lastTime) || lastTime < 0) {
    lastTime = 0;
}
if (lastTime === 0 && Number.isInteger(savedLastPage) && savedLastPage > 0 && savedLastPage < comicImagesLength) {
    lastTime = savedLastPage;
}
if (lastTime >= comicImagesLength) {
    lastTime = 0;
}
xView = lastTime;

function buildImageUrl(relativePath) {
    return "/public/uploads/" + comicFolder + "/" + relativePath;
}

function setInfoVisibility(isVisible) {
    if (!infoComic) {
        return;
    }
    infoComic.style.visibility = isVisible ? "visible" : "hidden";
    if (leftTrigger) {
        leftTrigger.style.visibility = isVisible || readerMode !== 'paged' ? "hidden" : "visible";
    }
    if (rightTrigger) {
        rightTrigger.style.visibility = isVisible || readerMode !== 'paged' ? "hidden" : "visible";
    }
}

function updateCurrentPageIndicator() {
    if (currentPageIndicator) {
        currentPageIndicator.innerHTML = comicImagesLength === 0 ? 0 : (xView + 1);
    }
    if (totalPageIndicator) {
        totalPageIndicator.innerHTML = comicImagesLength;
    }
    if (backToStart) {
        backToStart.style.display = xView > 0 ? "" : "none";
    }
}

function persistCurrentPage() {
    window.localStorage[comicFolder] = xView;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(function(){
        fetch("/ajax/lastpage/update/" + comicId + "/" + xView, {
            method: "put"
        });
    }, 250);
}

function cacheNextImage() {
    if (!cachedImage || readerMode !== 'paged' || comicImagesLength === 0) {
        return;
    }
    cachedImage.src = buildImageUrl(comicImages[(xView + 1) % comicImagesLength]);
}

var ZOOM_MIN = 1;
var ZOOM_MAX = 4;
var ZOOM_STEP = 2.5;
var zoomScale = 1;
var zoomX = 0;
var zoomY = 0;
var pinchActive = false;
var pinchStartDistance = 0;
var pinchStartScale = 1;
var panActive = false;
var panStartX = 0;
var panStartY = 0;
var panStartZoomX = 0;
var panStartZoomY = 0;
var touchStartX = 0;
var touchStartY = 0;
var touchStartTime = 0;
var touchMoved = false;
var lastTapTime = 0;
var lastTapX = 0;
var lastTapY = 0;
var suppressClickUntil = 0;

function clampZoom(value) {
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value));
}

function applyZoom() {
    if (!mainImage) {
        return;
    }

    if (pagedReader) {
        var rect = pagedReader.getBoundingClientRect();
        var maxX = (rect.width * (zoomScale - 1)) / 2;
        var maxY = (rect.height * (zoomScale - 1)) / 2;
        zoomX = Math.max(-maxX, Math.min(maxX, zoomX));
        zoomY = Math.max(-maxY, Math.min(maxY, zoomY));
        pagedReader.classList.toggle("is-zoomed", zoomScale > 1.01);
    }

    mainImage.style.transform = "translate(" + zoomX + "px, " + zoomY + "px) scale(" + zoomScale + ")";

    if (zoomToggleButton) {
        var zoomIcon = zoomToggleButton.querySelector("i");
        if (zoomIcon) {
            zoomIcon.className = "mx-2 fas " + (zoomScale > 1.01 ? "fa-search-minus" : "fa-search-plus");
        }
    }
}

function resetZoom() {
    zoomScale = 1;
    zoomX = 0;
    zoomY = 0;
    if (mainImage) {
        mainImage.style.transformOrigin = "center center";
    }
    applyZoom();
}

function setZoomFromClientPoint(nextScale, clientX, clientY) {
    if (!mainImage || !pagedReader) {
        return;
    }

    var rect = pagedReader.getBoundingClientRect();
    var originX = rect.width ? ((clientX - rect.left) / rect.width) * 100 : 50;
    var originY = rect.height ? ((clientY - rect.top) / rect.height) * 100 : 50;
    mainImage.style.transformOrigin = originX + "% " + originY + "%";
    zoomScale = clampZoom(nextScale);

    if (zoomScale <= 1.01) {
        resetZoom();
        return;
    }
    applyZoom();
}

function toggleZoomAtClientPoint(clientX, clientY) {
    if (zoomScale > 1.01) {
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

function touchDistance(touches) {
    var dx = touches[0].clientX - touches[1].clientX;
    var dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
}

function renderPagedImage() {
    if (!mainImage || comicImagesLength === 0) {
        return;
    }
    resetZoom();
    mainImage.src = buildImageUrl(comicImages[xView]);
    updateCurrentPageIndicator();
    persistCurrentPage();
    setInfoVisibility(false);
}

function buildOfflinePageUrls() {
    return comicImages.map(function(relativePath){
        return "/public/uploads/" + encodeURIComponent(comicFolder) + "/" + relativePath.split('/').map(encodeURIComponent).join('/');
    });
}

function buildOfflineAssetUrls() {
    var urls = [];
    document.querySelectorAll('link[rel="stylesheet"][href], script[src]').forEach(function(node){
        var value = node.getAttribute('href') || node.getAttribute('src') || '';
        if (value.charAt(0) === '/') {
            urls.push(value);
        }
    });
    return urls;
}

function setOfflineButtonState(state, label) {
    if (!offlineToggleButton) {
        return;
    }
    var icon = offlineToggleButton.querySelector("i");
    if (label) {
        offlineToggleButton.title = label;
    }
    if (!icon) {
        return;
    }
    if (state === 'saving') {
        icon.className = "mx-2 fas fa-spinner fa-spin";
    } else if (state === 'ready') {
        icon.className = "mx-2 fas fa-check-circle";
    } else if (state === 'offline') {
        icon.className = "mx-2 fas fa-cloud";
    } else if (state === 'error') {
        icon.className = "mx-2 fas fa-exclamation-circle";
    } else {
        icon.className = "mx-2 fas fa-cloud-download-alt";
    }
}

function checkOfflineStatus() {
    if (!offlineToggleButton || comicImagesLength === 0 || !navigator.serviceWorker || !navigator.serviceWorker.controller) {
        return;
    }

    var channel = new MessageChannel();
    channel.port1.onmessage = function(event){
        var data = event.data || {};
        if (data.type === 'OFFLINE_STATUS' && data.total > 0) {
            if (data.missing === 0) {
                setOfflineButtonState('ready', 'Available offline');
            } else {
                setOfflineButtonState('idle', 'Save comic for offline reading');
            }
        }
    };

    navigator.serviceWorker.controller.postMessage({
        type: 'GET_OFFLINE_STATUS',
        comicFolder: comicFolder,
        pageUrls: buildOfflinePageUrls()
    }, [channel.port2]);
}

var offlineRequestPending = false;

function requestOfflineCache() {
    if (!offlineToggleButton || comicImagesLength === 0) {
        return;
    }
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
        setOfflineButtonState('offline', 'Offline saving is not available yet');
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
    setOfflineButtonState('saving', 'Saving comic for offline reading...');

    var channel = new MessageChannel();
    channel.port1.onmessage = function(event){
        var data = event.data || {};
        if (data.type === 'CACHE_PROGRESS') {
            setOfflineButtonState('saving', 'Saving ' + data.cachedCount + '/' + data.total + ' pages...');
            return;
        }
        if (data.type === 'CACHE_DONE') {
            offlineRequestPending = false;
            if (data.ok) {
                setOfflineButtonState('ready', data.failureCount > 0 ? 'Available offline (' + data.failureCount + ' pages failed)' : 'Available offline');
            } else {
                setOfflineButtonState('error', data.error || 'Could not save for offline');
            }
        }
    };

    navigator.serviceWorker.controller.postMessage({
        type: 'CACHE_COMIC',
        comicFolder: comicFolder,
        comicId: comicId,
        title: document.title,
        pageUrl: window.location.pathname + window.location.search,
        pageUrls: buildOfflinePageUrls(),
        assetUrls: buildOfflineAssetUrls()
    }, [channel.port2]);
}

function scheduleOfflineCache() {
    if (!offlineToggleButton || comicImagesLength === 0 || !navigator.serviceWorker) {
        return;
    }

    var run = function(){
        checkOfflineStatus();
        setTimeout(requestOfflineCache, 1200);
    };

    if (navigator.serviceWorker.controller) {
        run();
        return;
    }

    navigator.serviceWorker.addEventListener('controllerchange', run, { once: true });
}

function goToPage(nextIndex, options) {
    if (comicImagesLength === 0) {
        return;
    }

    options = options || {};
    var clampedIndex = Math.max(0, Math.min(nextIndex, comicImagesLength - 1));
    xView = clampedIndex;
    updateCurrentPageIndicator();
    persistCurrentPage();

    if (readerMode === 'scroll') {
        if (options.scrollIntoView !== false && scrollPages[xView]) {
            scrollPages[xView].scrollIntoView({ behavior: options.behavior || 'smooth', block: 'start' });
        }
        return;
    }

    renderPagedImage();
}

function backToStartFun() {
    goToPage(0, { behavior: 'smooth' });
}

function rightTriggerArrow(event_t) {
    if (event_t) {
        event_t.preventDefault();
    }
    goToPage(xView + 1);
}

function leftTriggerArrow(event_t) {
    if (event_t) {
        event_t.preventDefault();
    }
    goToPage(xView - 1);
}

function setReaderMode(nextMode) {
    readerMode = nextMode === 'scroll' ? 'scroll' : 'paged';
    window.localStorage[readerModeStorageKey] = readerMode;
    resetZoom();

    if (pagedReader) {
        pagedReader.style.display = readerMode === 'paged' ? "flex" : "none";
    }
    if (scrollReader) {
        scrollReader.style.display = readerMode === 'scroll' ? "block" : "none";
    }
    if (pagedModeButton) {
        pagedModeButton.classList.toggle('active', readerMode === 'paged');
    }
    if (scrollModeButton) {
        scrollModeButton.classList.toggle('active', readerMode === 'scroll');
    }

    setInfoVisibility(false);

    if (readerMode === 'scroll') {
        updateCurrentPageIndicator();
        if (scrollPages[xView]) {
            setTimeout(function(){
                scrollPages[xView].scrollIntoView({ behavior: 'auto', block: 'start' });
            }, 0);
        }
        return;
    }

    if (window.scrollY !== 0) {
        window.scrollTo({ top: 0, behavior: 'auto' });
    }
    renderPagedImage();
}

function syncScrollReaderCurrentPage() {
    if (readerMode !== 'scroll' || scrollPages.length === 0) {
        return;
    }

    var viewportMiddle = window.innerHeight / 2;
    var bestPageIndex = xView;
    var bestDistance = Number.POSITIVE_INFINITY;

    scrollPages.forEach(function(pageElement, index){
        var rect = pageElement.getBoundingClientRect();
        var pageMiddle = rect.top + (rect.height / 2);
        var distance = Math.abs(pageMiddle - viewportMiddle);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestPageIndex = index;
        }
    });

    if (bestPageIndex !== xView) {
        xView = bestPageIndex;
        updateCurrentPageIndicator();
        persistCurrentPage();
    }
}

function scheduleScrollSync() {
    if (readerMode !== 'scroll') {
        return;
    }
    if (scrollSyncFrame) {
        return;
    }
    scrollSyncFrame = window.requestAnimationFrame(function(){
        scrollSyncFrame = null;
        syncScrollReaderCurrentPage();
    });
}

if (mainImage && comicFolder && comicImagesLength > 0) {
    mainImage.src = buildImageUrl(comicImages[xView]);
}
updateCurrentPageIndicator();
cacheNextImage();
setInfoVisibility(false);

window.addEventListener("contextmenu", function(event_t){
    event_t.preventDefault();
});

if (backToStart) {
    backToStart.addEventListener("click", function(){
        backToStartFun();
    });
}

if (mainImage) {
    mainImage.addEventListener("load", function(){
        cacheNextImage();
    });
}

if (rightTrigger) {
    rightTrigger.addEventListener("click", function(event_t){
        rightTriggerArrow(event_t);
    });
}
if (leftTrigger) {
    leftTrigger.addEventListener("click", function(event_t){
        leftTriggerArrow(event_t);
    });
}

document.addEventListener("keydown", function(event_t){
    if (event_t.key == " " || event_t.key == "ArrowRight") {
        rightTriggerArrow(event_t);
    }
    if (event_t.key == "ArrowLeft") {
        leftTriggerArrow(event_t);
    }
    if (event_t.key == "r" && xView > 0) {
        backToStartFun();
    }
    if (event_t.key == "f") {
        toggleFullScreen();
    }
    if (event_t.key == "+" || event_t.key == "=") {
        zoomAtReaderCenter(zoomScale > 1.01 ? zoomScale + 0.5 : ZOOM_STEP);
    }
    if (event_t.key == "-") {
        zoomAtReaderCenter(zoomScale - 0.5);
    }
    if (event_t.key == "0") {
        resetZoom();
    }
});

if (infoComicDetails) {
    infoComicDetails.addEventListener("mousedown", function(){
        setInfoVisibility(true);
    });
}

if (closeInfoComic) {
    closeInfoComic.addEventListener("click", function(){
        setInfoVisibility(false);
    });
}

if (pagedModeButton) {
    pagedModeButton.addEventListener("click", function(event_t){
        event_t.preventDefault();
        setReaderMode('paged');
    });
}

if (scrollModeButton) {
    scrollModeButton.addEventListener("click", function(event_t){
        event_t.preventDefault();
        setReaderMode('scroll');
    });
}

if (zoomToggleButton) {
    zoomToggleButton.addEventListener("click", function(event_t){
        event_t.preventDefault();
        var rect = pagedReader ? pagedReader.getBoundingClientRect() : null;
        var centerX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
        var centerY = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
        toggleZoomAtClientPoint(centerX, centerY);
    });
}

if (offlineToggleButton) {
    offlineToggleButton.addEventListener("click", function(event_t){
        event_t.preventDefault();
        requestOfflineCache();
    });
}

window.addEventListener("offline", function(){
    setOfflineButtonState('offline', 'You are offline');
});

window.addEventListener("online", function(){
    checkOfflineStatus();
});

if (pagedReader) {
    pagedReader.addEventListener("wheel", function(event_t){
        if (!event_t.ctrlKey) {
            return;
        }
        event_t.preventDefault();
        if (zoomScale <= 1.01 && mainImage) {
            var rect = pagedReader.getBoundingClientRect();
            var originX = rect.width ? ((event_t.clientX - rect.left) / rect.width) * 100 : 50;
            var originY = rect.height ? ((event_t.clientY - rect.top) / rect.height) * 100 : 50;
            mainImage.style.transformOrigin = originX + "% " + originY + "%";
        }
        zoomScale = clampZoom(zoomScale + (event_t.deltaY < 0 ? 0.25 : -0.25));
        if (zoomScale <= 1.01) {
            resetZoom();
        } else {
            applyZoom();
        }
    }, { passive: false });

    pagedReader.addEventListener("click", function(event_t){
        if (Date.now() < suppressClickUntil) {
            event_t.preventDefault();
            event_t.stopPropagation();
        }
    }, true);

    pagedReader.addEventListener("touchstart", function(event_t){
        if (event_t.touches.length === 2 && mainImage) {
            pinchActive = true;
            panActive = false;
            pagedReader.classList.remove("is-panning");
            pinchStartDistance = touchDistance(event_t.touches);
            pinchStartScale = zoomScale;
            var midX = (event_t.touches[0].clientX + event_t.touches[1].clientX) / 2;
            var midY = (event_t.touches[0].clientY + event_t.touches[1].clientY) / 2;
            var rect = pagedReader.getBoundingClientRect();
            var originX = rect.width ? ((midX - rect.left) / rect.width) * 100 : 50;
            var originY = rect.height ? ((midY - rect.top) / rect.height) * 100 : 50;
            mainImage.style.transformOrigin = originX + "% " + originY + "%";
            return;
        }

        if (event_t.touches.length === 1) {
            touchStartTime = Date.now();
            touchStartX = event_t.touches[0].clientX;
            touchStartY = event_t.touches[0].clientY;
            touchMoved = false;

            if (zoomScale > 1.01) {
                panActive = true;
                panStartX = event_t.touches[0].clientX;
                panStartY = event_t.touches[0].clientY;
                panStartZoomX = zoomX;
                panStartZoomY = zoomY;
                pagedReader.classList.add("is-panning");
            }
        }
    }, { passive: true });

    pagedReader.addEventListener("touchmove", function(event_t){
        if (pinchActive && event_t.touches.length === 2) {
            event_t.preventDefault();
            touchMoved = true;
            var distance = touchDistance(event_t.touches);
            if (pinchStartDistance > 0) {
                zoomScale = clampZoom(pinchStartScale * (distance / pinchStartDistance));
                applyZoom();
            }
            return;
        }

        if (panActive && event_t.touches.length === 1) {
            event_t.preventDefault();
            touchMoved = true;
            zoomX = panStartZoomX + (event_t.touches[0].clientX - panStartX);
            zoomY = panStartZoomY + (event_t.touches[0].clientY - panStartY);
            applyZoom();
        }
    }, { passive: false });

    pagedReader.addEventListener("touchend", function(event_t){
        if (pinchActive) {
            pinchActive = false;
            panActive = false;
            pagedReader.classList.remove("is-panning");
            if (zoomScale <= 1.05) {
                resetZoom();
            }
            suppressClickUntil = Date.now() + 350;
            return;
        }

        if (panActive) {
            panActive = false;
            pagedReader.classList.remove("is-panning");
            if (touchMoved) {
                suppressClickUntil = Date.now() + 350;
            }
        }

        if (event_t.touches.length === 0 && event_t.changedTouches.length > 0) {
            if (event_t.target && event_t.target.closest && event_t.target.closest('.reader-side-trigger')) {
                lastTapTime = 0;
                return;
            }

            var touch = event_t.changedTouches[0];
            var duration = Date.now() - touchStartTime;
            var movedDistance = Math.abs(touch.clientX - touchStartX) + Math.abs(touch.clientY - touchStartY);
            if (touchMoved || duration > 300 || movedDistance > 12) {
                return;
            }

            var now = Date.now();
            if (now - lastTapTime < 320 && Math.abs(touch.clientX - lastTapX) < 40 && Math.abs(touch.clientY - lastTapY) < 40) {
                lastTapTime = 0;
                suppressClickUntil = now + 350;
                event_t.preventDefault();
                toggleZoomAtClientPoint(touch.clientX, touch.clientY);
                return;
            }

            lastTapTime = now;
            lastTapX = touch.clientX;
            lastTapY = touch.clientY;
        }
    }, { passive: false });
}

window.addEventListener("scroll", scheduleScrollSync, { passive: true });
window.addEventListener("resize", scheduleScrollSync);

if (backToComics) {
    backToComics.addEventListener("click", function(){
        window.location.href = "/comic";
    });
}

if (fullScreen_icon) {
    fullScreen_icon.addEventListener("click", function(){
        toggleFullScreen();
    });
}

function toggleFullScreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
        fullScreen_icon.innerHTML = `<i class="mx-2 fas fa-compress"></i>`;
    } else if (document.exitFullscreen) {
        fullScreen_icon.innerHTML = `<i class="mx-2 fas fa-expand"></i>`;
        document.exitFullscreen();
    }
}

setReaderMode(readerMode);
scheduleOfflineCache();