// No database or Express imports here: all archive, image and folder work runs
// outside the HTTP process, including the synchronous work in dependencies.
const fs = require('fs');
const extractComics = require('./extractComic');
const { extractMetadataFromFilename, getUploadFolderPath, invalidateComicAssets, resolveComicAssets, sanitizeUploadFileName } = require('./comicStorage');
const { decideBundle, detectComicMetadata } = require('./aiMetadata');
const { cleanLabel, planComicParts } = require('./comicBundles');

const MAX_AI_PARTS = 30;

async function prepareComic(job, progress) {
    const folder = getUploadFolderPath(job.comicFolderId);
    const safeFileName = sanitizeUploadFileName(job.fileName);
    const knownTitles = job.knownTitles || [];
    const metadata = extractMetadataFromFilename(safeFileName, { knownTitles });
    let source = job.tempFilePath;
    // Earlier versions renamed CBR uploads before extracting them. Accept that
    // leftover too, but new jobs can read CBR content without a rename.
    if (job.extension === 'cbr' && !fs.existsSync(source) && fs.existsSync(source + '.rar')) source += '.rar';
    fs.mkdirSync(folder, { recursive: true });
    progress(30);
    if (job.extension === 'url') {
        await require('./urlImport').importImages(source, folder,
            value => progress(30 + Math.round((value - 10) / 2)));
    } else {
        await extractComics(source, job.extension, job.comicFolderId);
    }
    invalidateComicAssets(job.comicFolderId);
    progress(60);
    const plan = await planComicParts(job.comicFolderId, safeFileName, {
        decide: decideBundle,
        log: message => console.log(`Job ${job.jobId}: ${message}`)
    });
    const parts = plan.parts.map(part => ({ ...part, assets: resolveComicAssets(part.folder) }))
        .filter(part => ['image', 'pdf'].includes(part.assets.viewerType));
    if (!parts.length) throw new Error('No supported content was found in the uploaded file.');
    const comics = [];
    for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        let ai = null;
        if (index < MAX_AI_PARTS) {
            try { ai = await detectComicMetadata(part.folder, part.assets.images); }
            catch (error) { console.error('AI metadata detection failed:', error.message); }
        }
        const isBundlePart = parts.length > 1;
        const fallback = isBundlePart && part.label
            ? extractMetadataFromFilename(part.label + '.cbz', { knownTitles }) : metadata;
        comics.push({
            savedFolder: part.folder,
            title: ai?.title || (isBundlePart && part.label ? cleanLabel(part.label) : fallback.title) || fallback.title,
            author: ai?.author || (isBundlePart ? '' : fallback.author || ''),
            description: ai?.description || '',
            coverImage: part.assets.coverImage,
            totalPages: part.assets.totalPages
        });
        progress(60 + Math.round((index + 1) / parts.length * 30));
    }
    return { comics };
}

if (require.main === module) {
    let busy = false;
    process.on('message', async message => {
        if (!message || message.type !== 'prepare') return;
        const { id, job } = message;
        if (busy) { process.send?.({ id, type: 'error', error: 'Comic worker is busy.' }); return; }
        busy = true;
        try {
            const result = await prepareComic(job, progress => process.send?.({ id, type: 'progress', progress }));
            process.send?.({ id, type: 'result', result });
        } catch (error) {
            process.send?.({ id, type: 'error', error: error.message || 'Comic processing failed.' });
        } finally { busy = false; }
    });
    process.on('disconnect', () => process.exit(0));
}

module.exports = { prepareComic };
