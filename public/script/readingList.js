(() => {
    // The browser can restore an old reading list after Back without asking
    // the server, even though a comic's reading time has changed meanwhile.
    let refreshing = false;
    function refresh() {
        if (refreshing || !navigator.onLine) return;
        refreshing = true;
        window.location.reload();
    }
    window.addEventListener('pageshow', event => { if (event.persisted) refresh(); });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refresh();
    });
})();
