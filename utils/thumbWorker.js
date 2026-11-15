// Child process that renders cover thumbnails with @napi-rs/canvas.
// Skia has crashed (SIGSEGV) inside its async thread-pool work when running in
// the web server process, taking the whole site down. Rendering here means a
// native crash only kills this worker; utils/thumbnails.js respawns it.
const fs = require('fs');
const { loadImage, createCanvas } = require('@napi-rs/canvas');

let queue = Promise.resolve();

// Resize options: `width` caps the width (keeps aspect ratio), `maxSide` caps
// the longest side. `format` is 'webp' or 'jpeg'; `background` fills first
// (useful for JPEG of images with transparency).
async function render({ src, width, maxSide, format = 'webp', quality = 80, background }) {
    const sourceBuffer = await fs.promises.readFile(src);
    const image = await loadImage(sourceBuffer);
    if (!image.width || !image.height) {
        throw new Error('Image has no dimensions');
    }
    let scale = 1;
    if (width) scale = Math.min(scale, width / image.width);
    if (maxSide) scale = Math.min(scale, maxSide / Math.max(image.width, image.height));
    const w = Math.max(1, Math.round(image.width * scale));
    const h = Math.max(1, Math.round(image.height * scale));
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, w, h);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, w, h);
    // Synchronous encode: avoids Skia's async thread-pool path.
    return canvas.encodeSync(format === 'jpeg' ? 'jpeg' : 'webp', quality);
}

process.on('message', (msg) => {
    if (!msg || typeof msg.id === 'undefined') return;
    // One render at a time.
    queue = queue.then(async () => {
        try {
            const buffer = await render(msg);
            process.send({ id: msg.id, ok: true, data: new Uint8Array(buffer) });
        } catch (err) {
            process.send({ id: msg.id, ok: false, error: err && err.message ? err.message : String(err) });
        }
    });
});

process.on('disconnect', () => process.exit(0));
