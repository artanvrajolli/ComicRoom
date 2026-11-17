(() => {
    const discoverForm = document.getElementById('urlDiscoverForm');
    if (!discoverForm) return;
    const imagesForm = document.getElementById('urlImagesForm');
    const list = document.getElementById('urlImageList');
    const message = document.getElementById('urlImportMessage');
    const find = document.getElementById('findUrlImages');
    const start = document.getElementById('startUrlImport');
    const method = document.getElementById('importMethod');
    method?.addEventListener('change', () => { imagesForm.hidden = true; message.textContent = ''; });
    let source = '';
    async function post(url, body) {
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Import failed. Please try again.');
        return result;
    }
    discoverForm.addEventListener('submit', async event => {
        event.preventDefault();
        find.disabled = true;
        if (method) method.disabled = true;
        imagesForm.hidden = true;
        message.textContent = method?.value === 'agent'
            ? 'Agent is finding original images… This can take up to 3 minutes.'
            : 'Finding images… This can take up to 90 seconds.';
        try {
            const result = await post('/comic/import-url/preview', {
                url: document.getElementById('importUrl').value,
                selector: document.getElementById('importSelector').value,
                method: method?.value || 'scrape'
            });
            source = result.source;
            document.getElementById('urlComicTitle').value = result.title;
            list.replaceChildren();
            result.images.forEach((url, index) => {
                const label = document.createElement('label');
                label.className = 'd-flex align-items-center gap-2 p-2 border-bottom';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox'; checkbox.checked = true; checkbox.value = url;
                checkbox.setAttribute('aria-label', 'Include image ' + (index + 1));
                const image = document.createElement('img');
                image.src = url; image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
                image.style.cssText = 'width:64px;height:80px;object-fit:contain;flex-shrink:0';
                const text = document.createElement('span');
                text.className = 'small'; text.style.cssText = 'overflow-wrap:anywhere;min-width:0';
                text.textContent = (index + 1) + '. ' + url;
                label.append(checkbox, image, text);
                list.append(label);
            });
            message.textContent = result.images.length + ' images found. Review the selection below.';
            imagesForm.hidden = false;
        } catch (error) { message.textContent = error.message; }
        finally { find.disabled = false; if (method) method.disabled = false; }
    });
    document.getElementById('urlSelectAll').onclick = () => list.querySelectorAll('input').forEach(input => { input.checked = true; });
    document.getElementById('urlSelectNone').onclick = () => list.querySelectorAll('input').forEach(input => { input.checked = false; });
    imagesForm.addEventListener('submit', async event => {
        event.preventDefault();
        const images = Array.from(list.querySelectorAll('input:checked'), input => input.value);
        if (!images.length) { message.textContent = 'Select at least one image.'; return; }
        start.disabled = true;
        find.disabled = true;
        message.textContent = 'Starting import…';
        try {
            const result = await post('/comic/import-url', {
                source, images, title: document.getElementById('urlComicTitle').value,
                private: document.getElementById('urlPrivate').checked ? '1' : '0'
            });
            location.assign('/comic/status/' + encodeURIComponent(result.jobId));
        } catch (error) {
            message.textContent = error.message;
            start.disabled = false;
            find.disabled = false;
        }
    });
})();
