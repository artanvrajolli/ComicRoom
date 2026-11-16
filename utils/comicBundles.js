// Turns one extracted upload into one or more comics.
//
// An uploaded archive is extracted into public/uploads/<rootFolder>. It may hold:
//   - one comic (the usual case),
//   - several comic archives (.cbz/.cbr/.zip/.rar/.pdf inside a .zip/.rar),
//   - several comics as folders ("Scarlet Crush 01/", "Scarlet Crush 02/"),
//   - several comics as one flat list of pages whose names carry the issue
//     ("Scarlet Crush 01 - 001.jpg", "Scarlet Crush 02 - 001.jpg").
// Nested archives are always split. Folder / file-name groups are ambiguous
// (chapters of one book look the same), so the AI decision model is asked
// when one is configured, with a file-name heuristic as the fallback.
const fs = require('fs');
const path = require('path');
const extractComics = require('./extractComic');
const { getUploadFolderPath, invalidateComicAssets } = require('./comicStorage');

const IMAGE_FILE_REGEX = /\.(?:apng|avif|gif|jpeg|png|svg|webp|jpg)$/i;
const NESTED_ARCHIVE_REGEX = /\.(?:cbz|cbr|zip|rar|pdf)$/i;
const JUNK_NAMES = new Set(['__macosx', '.ds_store', 'thumbs.db', 'desktop.ini']);
// A group smaller than this is treated as covers/extras, not a comic of its own.
const MIN_PAGES = 4;
const MAX_PARTS = 100;
const MAX_NESTING = 2;
const CHAPTER_WORDS = /\b(?:ch|chap|chapter|chapters|part|pt|disc|scene|episode|ep|extras?|bonus|covers?|variants?)\b/i;

function toPosix(value) {
    return value.split(path.sep).join('/');
}

function naturalCompare(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// Removes OS junk (__MACOSX, ._ resource forks, .DS_Store, Thumbs.db).
function removeJunk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const lower = entry.name.toLowerCase();
        if (JUNK_NAMES.has(lower) || entry.name.startsWith('._')) {
            fs.rmSync(full, { recursive: true, force: true });
        } else if (entry.isDirectory()) {
            removeJunk(full);
        }
    }
}

function listFiles(dir, base = dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
    const files = [];
    for (const entry of entries.sort((a, b) => naturalCompare(a.name, b.name))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...listFiles(full, base));
        else if (entry.isFile()) files.push(toPosix(path.relative(base, full)));
    }
    return files;
}

function stripExtension(name) {
    return String(name || '').replace(/\.[a-z0-9]{2,4}$/i, '');
}

// Human label for a part: archive or folder name without extension and release tags.
function cleanLabel(name) {
    const cleaned = stripExtension(path.posix.basename(String(name || '')))
        .replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ')
        .replace(/\((?:digital|digital-hd|c2c|webrip|scan|f|[^)]*empire[^)]*|[^)]*-?rips?)\)/ig, ' ')
        .replace(/[_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned || stripExtension(path.posix.basename(String(name || '')));
}

// "Scarlet Crush 01 - 001" -> "Scarlet Crush 01"; "001" -> "".
function pageGroupKey(fileName) {
    return stripExtension(path.posix.basename(fileName))
        .replace(/[\s._-]*(?:p|pg|page)?[\s._-]*\d+[a-z]?$/i, '')
        .replace(/[\s._-]+$/, '')
        .trim();
}

function issueNumbers(label) {
    return (String(label).match(/\d+/g) || []).map(Number).filter(n => n < 1900 || n > 2100);
}

// "Scarlet Crush 01-02 (1998)" / "#1-4" / "1 to 3": a range of issues in the archive name.
function hasIssueRange(archiveName) {
    const name = stripExtension(archiveName).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
    const match = /(?:^|[\s#])#?(\d{1,3})\s*(?:-|–|~|to)\s*#?(\d{1,3})(?:\s|$)/i.exec(name);
    return Boolean(match && Number(match[2]) > Number(match[1]));
}

// Fallback when no AI decision is available.
function heuristicIsBundle(archiveName, groups) {
    const big = groups.filter(group => group.pages >= MIN_PAGES);
    if (big.length < 2) return false;
    if (hasIssueRange(archiveName)) return true;
    const labels = big.map(group => group.label);
    if (labels.some(label => CHAPTER_WORDS.test(label))) return false;
    const numbers = labels.map(label => issueNumbers(label).join('.'));
    const distinct = new Set(numbers);
    const textOnly = new Set(labels.map(label => label.replace(/\d+/g, '#').toLowerCase().replace(/\s+/g, ' ').trim()));
    // Same series name, a different issue number each: "Saga 01", "Saga 02".
    return numbers.every(Boolean) && distinct.size === labels.length && textOnly.size === 1;
}

// Image groups: one per folder holding pages, or (flat archive) one per file-name prefix.
function findImageGroups(rootPath) {
    const images = listFiles(rootPath).filter(file => IMAGE_FILE_REGEX.test(file));
    if (images.length === 0) return [];

    const byDir = new Map();
    for (const file of images) {
        const dir = path.posix.dirname(file);
        if (!byDir.has(dir)) byDir.set(dir, []);
        byDir.get(dir).push(file);
    }
    if (byDir.size >= 2) {
        return Array.from(byDir.keys()).sort(naturalCompare).map(dir => ({
            kind: 'folder',
            dir,
            label: dir === '.' ? '' : path.posix.basename(dir),
            files: byDir.get(dir),
            pages: byDir.get(dir).length
        }));
    }

    const byKey = new Map();
    for (const file of images) {
        const key = pageGroupKey(file);
        const norm = key.toLowerCase().replace(/\s+/g, ' ');
        if (!byKey.has(norm)) byKey.set(norm, { label: key, files: [] });
        byKey.get(norm).files.push(file);
    }
    const groups = Array.from(byKey.values()).filter(group => group.label);
    const covered = groups.reduce((sum, group) => sum + group.files.length, 0);
    const bigGroups = groups.filter(group => group.files.length >= MIN_PAGES);
    if (bigGroups.length >= 2 && covered >= images.length * 0.9) {
        return groups.sort((a, b) => naturalCompare(a.label, b.label)).map(group => ({
            kind: 'files', label: group.label, files: group.files, pages: group.files.length
        }));
    }
    return [{ kind: 'single', label: '', files: images, pages: images.length }];
}

function newPartFolder(rootFolder, index) {
    return rootFolder + String(index + 1).padStart(2, '0');
}

function moveFile(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
}

// Moves each group into its own comic folder. Small groups (covers, extras)
// join the comic before them (or the first one).
function splitGroups(rootFolder, groups) {
    const rootPath = getUploadFolderPath(rootFolder);
    const big = groups.filter(group => group.pages >= MIN_PAGES).slice(0, MAX_PARTS);
    const parts = big.map((group, index) => ({ folder: newPartFolder(rootFolder, index), label: group.label, files: [] }));
    let current = 0;
    for (const group of groups) {
        const bigIndex = big.indexOf(group);
        if (bigIndex !== -1) current = bigIndex;
        // Extras keep a prefix so they sort after the comic's own pages and never overwrite them.
        const extraPrefix = bigIndex === -1 ? 'zz-extra-' : '';
        parts[current].files.push(...group.files.map(file => ({ file, name: extraPrefix + path.posix.basename(file) })));
    }
    for (const part of parts) {
        const partPath = getUploadFolderPath(part.folder);
        fs.mkdirSync(partPath, { recursive: true });
        for (const { file, name } of part.files) {
            let target = path.join(partPath, name);
            for (let n = 2; fs.existsSync(target); n++) {
                target = path.join(partPath, `${stripExtension(name)}-${n}${path.extname(name)}`);
            }
            moveFile(path.join(rootPath, file), target);
        }
        invalidateComicAssets(part.folder);
        delete part.files;
    }
    fs.rmSync(rootPath, { recursive: true, force: true });
    invalidateComicAssets(rootFolder);
    return parts;
}

/**
 * Splits an extracted upload into comics.
 * @param {string} rootFolder  "comic_<digits>" folder the upload was extracted into
 * @param {string} archiveName original upload file name
 * @param {object} [options]
 * @param {function} [options.decide] async ({archiveName, groups}) => {isBundle, probability, model} | null
 * @param {function} [options.log]
 * @returns {Promise<{parts: Array<{folder: string, label: string}>, bundle: boolean, reason: string}>}
 */
async function planComicParts(rootFolder, archiveName, options = {}, depth = 0) {
    const log = options.log || (() => {});
    const rootPath = getUploadFolderPath(rootFolder);
    removeJunk(rootPath);

    const nested = listFiles(rootPath).filter(file => NESTED_ARCHIVE_REGEX.test(file));
    if (nested.length > 0 && depth < MAX_NESTING) {
        const parts = [];
        let index = 0;
        for (const file of nested.slice(0, MAX_PARTS)) {
            const folder = newPartFolder(rootFolder, index++);
            const source = path.join(rootPath, file);
            try {
                await extractComics(source, path.extname(file).slice(1), folder);
                invalidateComicAssets(folder);
                const inner = await planComicParts(folder, path.posix.basename(file), options, depth + 1);
                for (const part of inner.parts) {
                    parts.push({ folder: part.folder, label: part.label || cleanLabel(file) });
                }
            } catch (error) {
                log(`Skipping ${file} inside ${archiveName}: ${error.message}`);
                fs.rmSync(getUploadFolderPath(folder), { recursive: true, force: true });
            } finally {
                fs.rmSync(source, { force: true });
            }
        }
        // Pages lying next to the archives (rare) stay a comic of their own.
        const leftover = listFiles(rootPath).filter(file => IMAGE_FILE_REGEX.test(file));
        if (leftover.length >= MIN_PAGES) {
            parts.unshift({ folder: rootFolder, label: cleanLabel(archiveName) });
            invalidateComicAssets(rootFolder);
        } else {
            fs.rmSync(rootPath, { recursive: true, force: true });
            invalidateComicAssets(rootFolder);
        }
        if (parts.length === 0) {
            throw new Error('None of the comic files inside this archive could be opened.');
        }
        return { parts, bundle: parts.length > 1, reason: `${nested.length} comic file(s) inside the archive` };
    }

    const groups = findImageGroups(rootPath);
    const bigGroups = groups.filter(group => group.pages >= MIN_PAGES);
    if (groups.length < 2 || bigGroups.length < 2) {
        return { parts: [{ folder: rootFolder, label: '' }], bundle: false, reason: 'one comic' };
    }

    const summary = groups.map(group => ({ label: group.label || '(top level)', pages: group.pages }));
    let isBundle = null;
    let reason = '';
    if (options.decide) {
        try {
            const decision = await options.decide({ archiveName, groups: summary });
            if (decision && typeof decision.isBundle === 'boolean') {
                isBundle = decision.isBundle;
                reason = `AI (${decision.model}) p=${Number(decision.probability).toFixed(2)}`;
            }
        } catch (error) {
            log('Bundle decision failed, using file names: ' + error.message);
        }
    }
    if (isBundle === null) {
        isBundle = heuristicIsBundle(archiveName, groups);
        reason = 'file names';
    }
    log(`${archiveName}: ${groups.length} groups (${summary.map(g => `${g.label}:${g.pages}`).join(', ')}) -> ${isBundle ? 'bundle' : 'one comic'} by ${reason}`);
    if (!isBundle) {
        return { parts: [{ folder: rootFolder, label: '' }], bundle: false, reason };
    }
    const parts = splitGroups(rootFolder, groups);
    return { parts, bundle: parts.length > 1, reason };
}

module.exports = {
    MIN_PAGES,
    cleanLabel,
    hasIssueRange,
    heuristicIsBundle,
    pageGroupKey,
    planComicParts
};
