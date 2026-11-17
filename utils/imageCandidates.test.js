const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fullSizeImages, isThumbnailUrl } = require('./imageCandidates');
const source = 'https://reader.example/chapter/1';

test('gallery thumbnails resolve to linked originals in page order without duplicate thumbnail pages', () => {
    const html = '<a class="gallery-item" href="/assets/pages/book/001.png?token=abc&amp;size=original"><img class="gallery-thumbnail" src="/assets/styles/square_thumbnail/pages/book/001.png?itok=xyz"></a>' +
        '<a href="/assets/pages/book/002.png"><img src="/thumbs/002.png"></a>';
    const urls = ['https://reader.example/thumbs/002.png', 'https://reader.example/assets/styles/square_thumbnail/pages/book/001.png?itok=xyz', 'https://reader.example/assets/pages/book/002.png'];
    assert.deepEqual(fullSizeImages(urls, html, source), [
        'https://reader.example/assets/pages/book/001.png?token=abc&size=original',
        'https://reader.example/assets/pages/book/002.png'
    ]);
});

test('uses original lazy images and the largest responsive image while preserving page order', () => {
    const html = '<img src="/thumbs/1.jpg" data-original="/original/1.jpg">' +
        '<img src="/small/2.jpg" srcset="/small/2.jpg 200w, /original/2.jpg 1600w, /medium/2.jpg 800w">' +
        '<picture><source srcset="/medium/3.webp 1x, /original/3.webp 2x"><img src="/thumbs/3.jpg"></picture>';
    assert.deepEqual(fullSizeImages(['/thumbs/1.jpg', '/small/2.jpg', '/thumbs/3.jpg'], html, source), [
        'https://reader.example/original/1.jpg', 'https://reader.example/original/2.jpg', 'https://reader.example/original/3.webp'
    ]);
});

test('retains signed CDN URLs and handles commas in responsive image paths', () => {
    const html = '<img src="/thumbs/1.jpg" data-srcset="https://cdn.example/w_200,q_auto/1.jpg?sig=small 200w, https://cdn.example/w_1600,q_auto/1.jpg?sig=large%2Btoken&amp;expires=123 1600w">';
    assert.deepEqual(fullSizeImages(['/thumbs/1.jpg'], html, source), ['https://cdn.example/w_1600,q_auto/1.jpg?sig=large%2Btoken&expires=123']);
});

test('does not import thumbnail-only previews or follow links to HTML reader pages as image files', () => {
    assert.deepEqual(fullSizeImages(['/thumbs/1.jpg', '/image.jpg?w=200'], '<a href="/reader/1"><img src="/thumbs/1.jpg"></a>', source), []);
    assert(isThumbnailUrl('https://reader.example/styles/square_thumbnail/public/1.jpg'));
    assert(!isThumbnailUrl('https://reader.example/comics/ThumbprintStory/001.jpg?signature=original'));
    assert(!isThumbnailUrl('https://reader.example/image.jpg?w=200&h=3000'));
});

test('respects the discovered selector result instead of pulling unrelated image links out of raw HTML', () => {
    const html = '<a href="/original/1.jpg"><img src="/thumbs/1.jpg"></a><a href="/ads/banner.jpg"><img src="/thumbs/banner.jpg"></a>';
    assert.deepEqual(fullSizeImages(['/thumbs/1.jpg'], html, source, true), ['https://reader.example/original/1.jpg']);
    assert.deepEqual(fullSizeImages([], html, source, true), []);
});

test('ignores commented-out and script-generated markup and keeps normal original images', () => {
    const html = '<!-- <img src="/fake.jpg"> --><script>const x="<img src=\"/fake2.jpg\">";</script><img src="/original/1.jpg">';
    assert.deepEqual(fullSizeImages([], html, source), ['https://reader.example/original/1.jpg']);
    assert.deepEqual(fullSizeImages([], '<img src="/original/2.jpg" width="1600" srcset="/medium/2.jpg 800w">', source), ['https://reader.example/original/2.jpg']);
});
