/*
 * Shared app-shell behaviour (loaded with `defer` from head_tags.ejs on every page, incl. readers).
 * - Upload state: polls active upload jobs and lists finished ones. Shown as the bell
 *   (desktop, #uploadNotification) and as the badge on the Uploads tab (phones/tablets, #crUploadsBadge).
 *   Public functions kept global: toggleNotificationDropdown(), clearNotifications(),
 *   addCompletedNotification(), updateNotificationUI(), checkActiveJobs(), testNotification().
 *   window.ComicRoomShell.refreshUploads() re-polls now; a `cr:uploads` event is dispatched on
 *   document after every poll with detail { jobs, active }.
 * - Sheets: account menu (#crAccountSheet) and search (#crSearchSheet) are native <dialog>s.
 * - Install: "Install app" menu item from beforeinstallprompt, or an iOS "Add to Home Screen" hint.
 * - Dismissible alerts: [data-cr-dismiss] removes its closest .cr-alert.
 * Runs after the DOM is parsed (defer), so it does not rely on window.onload.
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'completedNotifications';
    var POLL_IDLE_MS = 15000;
    var POLL_ACTIVE_MS = 5000;

    function readStored() {
        try {
            var parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return [];
        }
    }

    function persist() {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(completedNotifications));
        } catch (error) { /* storage unavailable (private mode) */ }
    }

    var completedNotifications = readStored();
    var lastKnownJobs = new Set();
    var activeJobs = [];

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function plural(count, one, many) {
        return count + ' ' + (count === 1 ? one : many);
    }

    /* ---------------- Upload notifications ---------------- */

    function setDropdownOpen(open) {
        var dropdown = document.getElementById('notificationDropdown');
        var toggle = document.getElementById('notificationToggle');
        if (!dropdown) return;
        dropdown.style.display = open ? 'block' : 'none';
        if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function addCompletedNotification(jobId, fileName, comicId, comicFolderId, success, errorMessage) {
        completedNotifications.unshift({
            id: Date.now(),
            jobId: jobId,
            fileName: fileName,
            comicId: comicId,
            comicFolderId: comicFolderId,
            success: success !== false,
            errorMessage: errorMessage || null,
            timestamp: new Date().toISOString(),
            viewed: false
        });
        completedNotifications = completedNotifications.slice(0, 10); // keep the last 10
        persist();
        updateNotificationUI();
    }

    function markViewed(predicate) {
        var changed = false;
        completedNotifications.forEach(function (n) {
            if (!n.viewed && (!predicate || predicate(n))) {
                n.viewed = true;
                changed = true;
            }
        });
        if (changed) persist();
        return changed;
    }

    function toggleNotificationDropdown() {
        var dropdown = document.getElementById('notificationDropdown');
        if (!dropdown) return;
        setDropdownOpen(dropdown.style.display === 'none');

        // Opening (or closing) the panel marks everything as read
        markViewed();
        updateNotificationUI();
    }

    function clearNotifications() {
        completedNotifications = [];
        persist();
        updateNotificationUI();
        setDropdownOpen(false);
    }

    function buildItem(notification) {
        var item = el('div', 'cr-notify-item' + (notification.viewed ? '' : ' is-unread'));

        var status = el('div', 'cr-notify-status ' + (notification.success ? 'ok' : 'fail'));
        var icon = el('i', notification.success ? 'fas fa-check-circle' : 'fas fa-exclamation-circle');
        icon.setAttribute('aria-hidden', 'true');
        status.appendChild(icon);
        status.appendChild(document.createTextNode(notification.success ? ' Upload complete' : ' Upload failed'));
        item.appendChild(status);

        var name = notification.fileName || 'Unknown file';
        if (notification.jobId != null && notification.jobId !== '') {
            var statusLink = el('a', 'cr-notify-file text-truncate', name);
            statusLink.href = '/comic/status/' + encodeURIComponent(notification.jobId);
            statusLink.title = 'Upload status for ' + name;
            item.appendChild(statusLink);
        } else {
            item.appendChild(el('div', 'text-truncate', name));
        }

        if (notification.success) {
            if (notification.comicFolderId != null && notification.comicId != null) {
                var link = el('a', 'btn btn-sm cr-btn-ghost mt-1', 'Review details');
                link.href = '/comic/' + encodeURIComponent(notification.comicFolderId) + '/' + encodeURIComponent(notification.comicId);
                item.appendChild(link);
            }
        } else {
            item.appendChild(el('span', 'cr-notify-meta', notification.errorMessage || 'Unknown error'));
        }

        var date = new Date(notification.timestamp);
        var time = el('time', null, isNaN(date) ? '' : date.toLocaleString());
        if (!isNaN(date)) time.setAttribute('datetime', date.toISOString());
        item.appendChild(time);
        return item;
    }

    // Uploads tab badge (phones/tablets): active job count, or the number of unseen results.
    function updateTabBadge(activeCount, unviewed) {
        var badge = document.getElementById('crUploadsBadge');
        var tab = document.getElementById('crUploadsTab');
        if (!badge) return;
        var label = 'Uploads';
        if (activeCount > 0) {
            badge.hidden = false;
            badge.textContent = activeCount > 9 ? '9+' : String(activeCount);
            badge.className = 'cr-badge is-active';
            label += ', ' + plural(activeCount, 'upload', 'uploads') + ' in progress';
        } else if (unviewed > 0) {
            badge.hidden = false;
            badge.textContent = unviewed > 9 ? '9+' : String(unviewed);
            badge.className = 'cr-badge';
            label += ', ' + plural(unviewed, 'new result', 'new results');
        } else {
            badge.hidden = true;
            badge.textContent = '';
        }
        if (tab) {
            if (label === 'Uploads') tab.removeAttribute('aria-label');
            else tab.setAttribute('aria-label', label);
        }
    }

    function updateNotificationUI() {
        var unviewed = completedNotifications.filter(function (n) { return !n.viewed; }).length;
        var activeCount = activeJobs.length;
        updateTabBadge(activeCount, unviewed);

        var notificationArea = document.getElementById('uploadNotification');
        var badge = document.getElementById('notificationBadge');
        var list = document.getElementById('notificationList');
        var toggle = document.getElementById('notificationToggle');

        if (!notificationArea || !badge || !list) {
            return; // not logged in / page without the app header
        }

        if (completedNotifications.length === 0 && activeCount === 0) {
            notificationArea.style.display = 'none';
            setDropdownOpen(false);
            return;
        }

        notificationArea.style.display = 'block';
        if (unviewed > 0) {
            badge.style.display = 'block';
            badge.textContent = unviewed;
        } else {
            badge.style.display = 'none';
        }
        notificationArea.classList.toggle('is-busy', activeCount > 0);
        if (toggle) {
            var parts = [];
            if (activeCount > 0) parts.push(activeCount + ' in progress');
            if (unviewed > 0) parts.push(unviewed + ' new');
            toggle.setAttribute('aria-label', 'Upload notifications' + (parts.length ? ' (' + parts.join(', ') + ')' : ''));
        }

        var activeLine = document.getElementById('notificationActive');
        if (activeLine) {
            activeLine.hidden = activeCount === 0;
            activeLine.textContent = '';
            if (activeCount > 0) {
                var spinner = el('i', 'fas fa-circle-notch fa-spin');
                spinner.setAttribute('aria-hidden', 'true');
                activeLine.appendChild(spinner);
                activeLine.appendChild(document.createTextNode(' ' + plural(activeCount, 'upload', 'uploads') + ' in progress'));
            }
        }
        var clearButton = document.getElementById('notificationClear');
        if (clearButton) clearButton.hidden = completedNotifications.length === 0;

        list.textContent = '';
        completedNotifications.forEach(function (notification) {
            list.appendChild(buildItem(notification));
        });
    }

    async function checkActiveJobs() {
        try {
            var response = await fetch('/ajax/upload/active', { credentials: 'same-origin' });
            if (!response.ok) return;

            var data = await response.json();
            var jobs = Array.isArray(data.jobs) ? data.jobs : [];
            var currentJobs = new Set(jobs.map(function (job) { return job.jobId; }));

            // Jobs that were active before but are gone now have finished: fetch their final status
            for (var jobId of lastKnownJobs) {
                if (currentJobs.has(jobId)) continue;
                try {
                    var statusResponse = await fetch('/ajax/upload/status/' + encodeURIComponent(jobId), { credentials: 'same-origin' });
                    if (!statusResponse.ok) continue;
                    var statusData = await statusResponse.json();
                    var fileName = statusData.fileName || 'Unknown file';

                    if (statusData.status === 'completed') {
                        addCompletedNotification(jobId, fileName, statusData.comicId, statusData.comicFolderId, true);
                    } else if (statusData.status === 'failed') {
                        addCompletedNotification(jobId, fileName, null, null, false, statusData.errorMessage);
                    }
                } catch (error) {
                    console.error('Error checking completed job status:', error);
                }
            }

            lastKnownJobs = currentJobs;
            activeJobs = jobs;
            // A result the user is already looking at does not need a badge
            markViewed(isOnPageFor);
            updateNotificationUI();
            document.dispatchEvent(new CustomEvent('cr:uploads', { detail: { jobs: jobs.slice(), active: jobs.length } }));
        } catch (error) {
            if (navigator.onLine !== false) console.error('Error checking active jobs:', error);
        }
    }

    // On /comic/uploads every result is visible; on /comic/status/<jobId> that job's result is.
    function isOnPageFor(notification) {
        var path = window.location.pathname;
        if (/^\/comic\/uploads\/?$/.test(path)) return true;
        var match = /^\/comic\/status\/([^/]+)\/?$/.exec(path);
        return !!match && decodeURIComponent(match[1]) === String(notification.jobId);
    }

    // Debug helper: testNotification() in the console adds a fake entry
    function testNotification() {
        addCompletedNotification('test123', 'Test Comic.cbz', 1, 'comic_123', true);
    }

    // Close the bell panel on outside click or Escape
    document.addEventListener('click', function (event) {
        var notification = document.getElementById('uploadNotification');
        if (notification && !notification.contains(event.target)) {
            setDropdownOpen(false);
        }
    });
    document.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape') return;
        var dropdown = document.getElementById('notificationDropdown');
        if (dropdown && dropdown.style.display !== 'none') {
            setDropdownOpen(false);
            var toggle = document.getElementById('notificationToggle');
            if (toggle) toggle.focus();
        }
    });

    window.addCompletedNotification = addCompletedNotification;
    window.toggleNotificationDropdown = toggleNotificationDropdown;
    window.clearNotifications = clearNotifications;
    window.updateNotificationUI = updateNotificationUI;
    window.checkActiveJobs = checkActiveJobs;
    window.testNotification = testNotification;

    /* ---------------- Sheets (native <dialog>) ---------------- */

    var openers = new WeakMap();

    function openSheet(dialog, opener, focusTarget) {
        if (!dialog || dialog.open) return;
        if (typeof dialog.showModal === 'function') {
            dialog.showModal();
        } else {
            dialog.setAttribute('open', ''); // very old browsers: plain overlay, Escape handled below
        }
        document.body.classList.add('cr-sheet-open');
        if (opener) {
            openers.set(dialog, opener);
            opener.setAttribute('aria-expanded', 'true');
        }
        // Focus synchronously inside the tap so iOS opens the keyboard
        if (focusTarget) {
            focusTarget.focus();
            if (typeof focusTarget.setSelectionRange === 'function' && focusTarget.value) {
                try { focusTarget.setSelectionRange(focusTarget.value.length, focusTarget.value.length); } catch (e) { /* type=search in old engines */ }
            }
        }
    }

    function closeSheet(dialog) {
        if (!dialog || !dialog.open) return;
        if (typeof dialog.close === 'function') dialog.close();
        else { dialog.removeAttribute('open'); onSheetClosed(dialog); }
    }

    function onSheetClosed(dialog) {
        if (!document.querySelector('dialog.cr-sheet[open]')) document.body.classList.remove('cr-sheet-open');
        var opener = openers.get(dialog);
        if (opener) {
            opener.setAttribute('aria-expanded', 'false');
            if (document.activeElement === document.body || dialog.contains(document.activeElement)) opener.focus();
        }
    }

    function initSheet(dialog) {
        if (!dialog) return;
        dialog.addEventListener('close', function () { onSheetClosed(dialog); });
        // Tap on the backdrop (the dialog box itself, outside .cr-sheet-inner) closes it
        dialog.addEventListener('click', function (event) {
            if (event.target === dialog) closeSheet(dialog);
            else if (event.target.closest && event.target.closest('[data-cr-close]')) closeSheet(dialog);
        });
        dialog.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && typeof dialog.showModal !== 'function') closeSheet(dialog);
        });
    }

    function initSheets() {
        var account = document.getElementById('crAccountSheet');
        var accountToggle = document.getElementById('crAccountToggle');
        var search = document.getElementById('crSearchSheet');
        var searchTab = document.getElementById('crSearchTab');
        var searchInput = document.getElementById('crSearchInput');
        initSheet(account);
        initSheet(search);

        if (account && accountToggle) {
            accountToggle.addEventListener('click', function () {
                if (account.open) closeSheet(account);
                else openSheet(account, accountToggle, account.querySelector('[data-cr-close]'));
            });
        }
        if (search && searchTab) {
            searchTab.addEventListener('click', function () {
                openSheet(search, searchTab, searchInput);
            });
        }
        // Back to a desktop width with a sheet open (rotate / resize): the search sheet has no desktop use
        if (window.matchMedia) {
            var desktop = window.matchMedia('(min-width: 992px)');
            var onChange = function () { if (desktop.matches) closeSheet(search); };
            if (desktop.addEventListener) desktop.addEventListener('change', onChange);
            else if (desktop.addListener) desktop.addListener(onChange);
        }
    }

    /* ---------------- Install app ---------------- */

    var installPrompt = window.__crInstallPrompt || null;

    function isStandalone() {
        var mm = window.matchMedia ? function (q) { return window.matchMedia(q).matches; } : function () { return false; };
        return navigator.standalone === true || mm('(display-mode: standalone)') || mm('(display-mode: fullscreen)')
            || mm('(display-mode: minimal-ui)') || mm('(display-mode: window-controls-overlay)');
    }

    function isIOS() {
        var ua = navigator.userAgent || '';
        return /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    }

    function updateInstallUI() {
        var item = document.getElementById('crInstallItem');
        var hint = document.getElementById('crInstallHint');
        var standalone = isStandalone();
        if (item) item.hidden = standalone || !installPrompt;
        if (hint) hint.hidden = standalone || !!installPrompt || !isIOS();
    }

    function initInstall() {
        window.addEventListener('beforeinstallprompt', function (event) {
            event.preventDefault();
            installPrompt = event;
            window.__crInstallPrompt = event;
            updateInstallUI();
        });
        window.addEventListener('appinstalled', function () {
            installPrompt = null;
            window.__crInstallPrompt = null;
            updateInstallUI();
        });
        var button = document.getElementById('crInstallBtn');
        if (button) {
            button.addEventListener('click', function () {
                var prompt = installPrompt;
                if (!prompt) return;
                installPrompt = null; // a prompt can only be used once
                window.__crInstallPrompt = null;
                closeSheet(document.getElementById('crAccountSheet'));
                prompt.prompt();
                Promise.resolve(prompt.userChoice).catch(function () {}).then(updateInstallUI);
            });
        }
        updateInstallUI();
    }

    /* ---------------- Misc shell behaviour ---------------- */

    // [data-cr-dismiss] closes its alert (flash messages)
    document.addEventListener('click', function (event) {
        var trigger = event.target.closest && event.target.closest('[data-cr-dismiss]');
        if (!trigger) return;
        var alert = trigger.closest('.cr-alert');
        if (alert) alert.remove();
    });

    // Hide the tab bar while the on-screen keyboard is likely open (touch devices, text fields)
    function initKeyboardState() {
        if (!document.getElementById('crTabbar')) return;
        if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) return;
        var nonText = /^(checkbox|radio|range|button|submit|reset|file|color|image)$/i;
        function isTextField(node) {
            if (!node || !node.tagName) return false;
            if (node.isContentEditable || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') return true;
            return node.tagName === 'INPUT' && !nonText.test(node.type);
        }
        document.addEventListener('focusin', function (event) {
            if (isTextField(event.target) && !event.target.closest('dialog')) document.body.classList.add('cr-kb-open');
        });
        document.addEventListener('focusout', function () {
            setTimeout(function () {
                if (!isTextField(document.activeElement)) document.body.classList.remove('cr-kb-open');
            }, 50);
        });
    }

    var pollTimer = null;
    function schedulePoll() {
        clearTimeout(pollTimer);
        pollTimer = setTimeout(function () {
            if (document.hidden) { schedulePoll(); return; }
            checkActiveJobs().then(schedulePoll, schedulePoll);
        }, activeJobs.length > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    }

    function refreshUploads() {
        clearTimeout(pollTimer);
        return checkActiveJobs().then(schedulePoll, schedulePoll);
    }

    window.ComicRoomShell = {
        refreshUploads: refreshUploads,
        openSearch: function () {
            openSheet(document.getElementById('crSearchSheet'), document.getElementById('crSearchTab'), document.getElementById('crSearchInput'));
        }
    };

    function init() {
        initSheets();
        initInstall();
        initKeyboardState();

        if (!document.body || document.body.dataset.userAuthenticated !== 'true') {
            return;
        }
        markViewed(isOnPageFor);
        updateNotificationUI();
        refreshUploads();
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) refreshUploads();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
