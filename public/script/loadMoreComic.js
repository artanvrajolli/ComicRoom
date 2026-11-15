/*
 * Infinite scroll for the gallery (/comic) and reading list (/onread).
 * Reads its config from #bodyComic: data-feed ("comic" | "onread"), data-offset,
 * data-page-size and data-keyword. Uses an IntersectionObserver on #feedSentinel,
 * with the #loadMore button as a visible fallback. Cards are built as DOM nodes
 * (no HTML string interpolation), so titles are never parsed as markup.
 */
(function () {
    'use strict';

    var grid = document.getElementById('bodyComic');
    if (!grid) return;

    var loadMoreButton = document.getElementById('loadMore');
    var statusEl = document.getElementById('feedStatus');
    var sentinel = document.getElementById('feedSentinel');

    var feed = grid.dataset.feed === 'onread' ? 'onread' : 'comic';
    var pageSize = parseInt(grid.dataset.pageSize, 10) || 12;
    var offset = parseInt(grid.dataset.offset, 10) || 0;
    var keyword = grid.dataset.keyword || '';
    var SKELETON_COUNT = 6;

    var loading = false;
    var done = offset < pageSize; // first page was not full: nothing more to fetch
    var failed = false;
    var pagesLoaded = 0;
    var observer = null;

    var seen = new Set();
    Array.prototype.forEach.call(grid.children, function (li) {
        if (li.dataset.id) seen.add(String(li.dataset.id));
    });

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function buildCard(comic, readingEntry) {
        var li = el('li');
        li.dataset.id = comic.id;

        var link = el('a', 'cr-comic-card');
        link.href = '/comic/show/' + encodeURIComponent(comic.id);

        var cover = el('div', 'cr-cover');
        var img = el('img');
        img.src = '/comic/cover/' + encodeURIComponent(comic.id);
        img.alt = '';
        img.width = 400;
        img.height = 600;
        img.loading = 'lazy';
        img.decoding = 'async';
        cover.appendChild(img);
        link.appendChild(cover);

        var meta = el('div', 'cr-comic-meta');
        meta.appendChild(el('h2', 'cr-comic-title', comic.title || 'Untitled'));
        if (comic.author) {
            meta.appendChild(el('p', 'cr-comic-author', comic.author));
        }

        if (readingEntry) {
            // pageNumber is stored 0-based by the reader
            var total = parseInt(comic.totalPages, 10) || 0;
            var current = (parseInt(readingEntry.pageNumber, 10) || 0) + 1;
            if (total > 0) {
                if (current > total) current = total;
                var bar = el('div', 'cr-progress');
                bar.setAttribute('role', 'progressbar');
                bar.setAttribute('aria-label', 'Reading progress');
                bar.setAttribute('aria-valuemin', '0');
                bar.setAttribute('aria-valuemax', String(total));
                bar.setAttribute('aria-valuenow', String(current));
                bar.setAttribute('aria-valuetext', 'Page ' + current + ' of ' + total);
                var fill = el('span');
                fill.style.width = Math.round((current / total) * 100) + '%';
                bar.appendChild(fill);
                meta.appendChild(bar);
                meta.appendChild(el('p', 'cr-progress-label', 'Page ' + current + ' of ' + total));
            }
        }

        link.appendChild(meta);
        li.appendChild(link);
        return li;
    }

    function showSkeletons() {
        var fragment = document.createDocumentFragment();
        for (var i = 0; i < SKELETON_COUNT; i++) {
            var li = el('li', 'cr-skeleton');
            li.setAttribute('aria-hidden', 'true');
            li.appendChild(el('div', 'cr-cover'));
            li.appendChild(el('div', 'cr-skeleton-line'));
            li.appendChild(el('div', 'cr-skeleton-line short'));
            fragment.appendChild(li);
        }
        grid.appendChild(fragment);
    }

    function removeSkeletons() {
        Array.prototype.slice.call(grid.querySelectorAll('.cr-skeleton')).forEach(function (node) {
            node.remove();
        });
    }

    function setStatus(text, isError) {
        if (!statusEl) return;
        statusEl.textContent = '';
        statusEl.classList.toggle('cr-feed-error', !!isError);
        if (text) statusEl.appendChild(document.createTextNode(text));
    }

    function updateControls() {
        if (loadMoreButton) {
            loadMoreButton.hidden = done;
            loadMoreButton.disabled = loading;
            loadMoreButton.textContent = failed ? 'Try again' : (loading ? 'Loading…' : 'Load more');
        }
        grid.setAttribute('aria-busy', loading ? 'true' : 'false');
    }

    function finish() {
        done = true;
        if (observer) observer.disconnect();
        if (pagesLoaded > 0) setStatus('You have reached the end.');
        updateControls();
    }

    function loadMore() {
        if (loading || done) return;
        loading = true;
        failed = false;
        setStatus('');
        showSkeletons();
        updateControls();

        var url = '/ajax/' + feed + '/' + offset + '?keyword=' + encodeURIComponent(keyword);
        fetch(url, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (items) {
                if (!Array.isArray(items)) throw new Error('Unexpected response');
                removeSkeletons();
                loading = false;
                pagesLoaded++;
                offset += items.length;

                var fragment = document.createDocumentFragment();
                items.forEach(function (item) {
                    var comic = feed === 'onread' ? item && item.comic : item;
                    if (!comic || comic.id == null || seen.has(String(comic.id))) return;
                    seen.add(String(comic.id));
                    fragment.appendChild(buildCard(comic, feed === 'onread' ? item : null));
                });
                grid.appendChild(fragment);

                if (items.length === 0 || items.length < pageSize) {
                    finish();
                    return;
                }
                updateControls();
                // Re-observe so a sentinel that is still on screen (tall viewports) triggers again
                if (observer && sentinel) {
                    observer.unobserve(sentinel);
                    observer.observe(sentinel);
                }
            })
            .catch(function (error) {
                console.error('Could not load more comics:', error);
                removeSkeletons();
                loading = false;
                failed = true;
                setStatus('Could not load more comics. Check your connection and try again.', true);
                updateControls();
            });
    }

    if (loadMoreButton) {
        loadMoreButton.addEventListener('click', loadMore);
    }

    if (done) {
        updateControls();
        return;
    }

    if ('IntersectionObserver' in window && sentinel) {
        observer = new IntersectionObserver(function (entries) {
            // After an error, wait for the user to press "Try again" instead of retrying on every scroll
            if (failed) return;
            if (entries.some(function (entry) { return entry.isIntersecting; })) {
                loadMore();
            }
        }, { rootMargin: '0px 0px 600px 0px' });
        observer.observe(sentinel);
    }
    updateControls();
})();
