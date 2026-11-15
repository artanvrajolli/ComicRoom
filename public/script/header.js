/*
 * Shared header behaviour (loaded with `defer` from head_tags.ejs on every page).
 * - Upload notification bell: polls active upload jobs and lists finished ones.
 *   Public functions kept global: toggleNotificationDropdown(), clearNotifications(),
 *   addCompletedNotification(), updateNotificationUI(), checkActiveJobs(), testNotification().
 * Runs after the DOM is parsed (defer), so it does not rely on window.onload.
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'completedNotifications';
    var POLL_INTERVAL_MS = 15000;

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

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

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

    function toggleNotificationDropdown() {
        var dropdown = document.getElementById('notificationDropdown');
        if (!dropdown) return;
        setDropdownOpen(dropdown.style.display === 'none');

        // Opening (or closing) the panel marks everything as read
        completedNotifications.forEach(function (n) { n.viewed = true; });
        persist();
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

        item.appendChild(el('div', 'text-truncate', notification.fileName || 'Unknown file'));

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

    function updateNotificationUI() {
        var notificationArea = document.getElementById('uploadNotification');
        var badge = document.getElementById('notificationBadge');
        var list = document.getElementById('notificationList');
        var toggle = document.getElementById('notificationToggle');

        if (!notificationArea || !badge || !list) {
            return; // not logged in / page without the app header
        }

        if (completedNotifications.length === 0) {
            notificationArea.style.display = 'none';
            return;
        }

        notificationArea.style.display = 'block';
        var unviewed = completedNotifications.filter(function (n) { return !n.viewed; }).length;
        if (unviewed > 0) {
            badge.style.display = 'block';
            badge.textContent = unviewed;
        } else {
            badge.style.display = 'none';
        }
        if (toggle) {
            toggle.setAttribute('aria-label', unviewed > 0
                ? 'Upload notifications (' + unviewed + ' new)'
                : 'Upload notifications');
        }

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
        } catch (error) {
            console.error('Error checking active jobs:', error);
        }
    }

    // Debug helper: testNotification() in the console adds a fake entry
    function testNotification() {
        addCompletedNotification('test123', 'Test Comic.cbz', 1, 'comic_123', true);
    }

    // Close the panel on outside click or Escape
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

    function init() {
        if (!document.body || document.body.dataset.userAuthenticated !== 'true') {
            return;
        }
        updateNotificationUI();
        checkActiveJobs();
        setInterval(function () {
            if (!document.hidden) checkActiveJobs();
        }, POLL_INTERVAL_MS);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
