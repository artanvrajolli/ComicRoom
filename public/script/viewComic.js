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

function renderPagedImage() {
    if (!mainImage || comicImagesLength === 0) {
        return;
    }
    mainImage.src = buildImageUrl(comicImages[xView]);
    updateCurrentPageIndicator();
    persistCurrentPage();
    setInfoVisibility(false);
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