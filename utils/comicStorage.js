const fs = require('fs');
const path = require('path');

const IMAGE_FILE_REGEX = /\.(?:apng|avif|gif|jpeg|png|svg|webp|jpg)$/i;
const PDF_FILE_REGEX = /\.pdf$/i;
const PAGE_MANAGER_TEMP_PREFIX = '__page_manager__';
const PDF_COVER_FILE_NAME = '__pdf_cover__.svg';
const ALLOWED_UPLOAD_EXTENSIONS = ['cbz', 'cbr', 'pdf'];
const TITLE_NOISE_WORDS = new Set([
    'annual',
    'book',
    'books',
    'c2c',
    'ch',
    'chapter',
    'chapters',
    'deluxe',
    'digital',
    'edition',
    'empire',
    'episode',
    'ep',
    'gnv',
    'graphic',
    'group',
    'hc',
    'issue',
    'issues',
    'one',
    'oneshot',
    'one-shot',
    'omnibus',
    'part',
    'pt',
    'retail',
    'scan',
    'scans',
    'scanlation',
    'sc',
    'series',
    'special',
    'the',
    'tpb',
    'volume',
    'vol',
    'v',
    'webtoon',
    'zone',
    'zone-empire'
]);

function toPosixPath(value) {
    return value.split(path.sep).join('/');
}

function getUploadFolderPath(savedFolder) {
    return path.join(process.cwd(), 'public', 'uploads', savedFolder);
}

function sanitizeUploadFileName(fileName) {
    return path.basename(String(fileName || '')).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
}

function isSupportedComicImageFile(fileName) {
    return IMAGE_FILE_REGEX.test(String(fileName || ''));
}

function collectRelativeFiles(basePath, currentPath = '') {
    const absolutePath = currentPath ? path.join(basePath, currentPath) : basePath;
    const entries = fs.readdirSync(absolutePath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }));
    const files = [];

    for (const entry of entries) {
        const entryRelativePath = currentPath ? path.join(currentPath, entry.name) : entry.name;
        if (entry.isDirectory()) {
            files.push(...collectRelativeFiles(basePath, entryRelativePath));
            continue;
        }
        files.push(toPosixPath(entryRelativePath));
    }

    return files;
}

function looksLikePersonName(value) {
    if (!value || /\d/.test(value)) {
        return false;
    }

    const words = value.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 4) {
        return false;
    }

    const reservedWords = ['vol', 'volume', 'issue', 'chapter', 'part', 'book', 'annual'];
    return words.every(word => {
        const loweredWord = word.toLowerCase();
        if (reservedWords.includes(loweredWord)) {
            return false;
        }
        return /^[A-Za-z][A-Za-z'’.\-]*$/.test(word);
    });
}

function cleanupTitle(value) {
    return value
        .replace(/[._]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripReleaseTags(value) {
    return cleanupTitle(String(value || '')
        .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
        .replace(/\b(?:19|20)\d{2}\b/g, ' ')
        .replace(/\b(?:vol(?:ume)?|v|issue|issues|chapter|chapters|ch|part|pt|book|books|episode|ep|annual|tpb|hc|sc|omnibus)\s*[-.:#]?\s*\d+[A-Za-z]?\b/ig, ' ')
        .replace(/#\s*\d+[A-Za-z]?\b/g, ' ')
        .replace(/\b(?:digital(?:-hd)?|retail|scan(?:s|lation)?|c2c|one[- ]shot|oneshot|deluxe|edition|zone[- ]?empire|empire|webtoon|gnv)\b/ig, ' '));
}

function normalizeTitleForMatching(value) {
    return cleanupTitle(String(value || '')
        .toLowerCase()
        .replace(/[’']/g, '')
        .replace(/[^a-z0-9\s-]+/g, ' '))
        .split(/\s+/)
        .filter(token => token && !TITLE_NOISE_WORDS.has(token) && !/^(?:19|20)\d{2}$/.test(token) && !/^\d+[a-z]?$/.test(token))
        .join(' ');
}

function buildBigrams(value) {
    const compactValue = String(value || '').replace(/\s+/g, '');
    if (!compactValue) {
        return [];
    }
    if (compactValue.length === 1) {
        return [compactValue];
    }

    const bigrams = [];
    for (let index = 0; index < compactValue.length - 1; index++) {
        bigrams.push(compactValue.slice(index, index + 2));
    }
    return bigrams;
}

function scoreTitleMatch(leftTitle, rightTitle) {
    const leftNormalized = normalizeTitleForMatching(leftTitle);
    const rightNormalized = normalizeTitleForMatching(rightTitle);

    if (!leftNormalized || !rightNormalized) {
        return 0;
    }
    if (leftNormalized === rightNormalized) {
        return 1;
    }

    const leftTokens = new Set(leftNormalized.split(' ').filter(Boolean));
    const rightTokens = new Set(rightNormalized.split(' ').filter(Boolean));
    let overlap = 0;
    leftTokens.forEach(token => {
        if (rightTokens.has(token)) {
            overlap++;
        }
    });

    const tokenScore = overlap / Math.max(leftTokens.size, rightTokens.size, 1);
    const leftBigrams = buildBigrams(leftNormalized);
    const rightBigrams = buildBigrams(rightNormalized);
    const rightBigramCounts = new Map();
    rightBigrams.forEach(bigram => {
        rightBigramCounts.set(bigram, (rightBigramCounts.get(bigram) || 0) + 1);
    });

    let bigramOverlap = 0;
    leftBigrams.forEach(bigram => {
        const availableCount = rightBigramCounts.get(bigram) || 0;
        if (availableCount > 0) {
            bigramOverlap++;
            rightBigramCounts.set(bigram, availableCount - 1);
        }
    });

    const bigramScore = (leftBigrams.length + rightBigrams.length) > 0
        ? (2 * bigramOverlap) / (leftBigrams.length + rightBigrams.length)
        : 0;
    const containmentBonus = leftNormalized.includes(rightNormalized) || rightNormalized.includes(leftNormalized) ? 0.12 : 0;

    return Math.min(1, (tokenScore * 0.7) + (bigramScore * 0.3) + containmentBonus);
}

function findBestKnownTitleMatch(candidateTitle, knownTitles) {
    const uniqueTitles = Array.from(new Set((knownTitles || []).map(title => cleanupTitle(String(title || ''))).filter(Boolean)));
    let bestMatch = {
        score: 0,
        title: ''
    };

    uniqueTitles.forEach(knownTitle => {
        const score = scoreTitleMatch(candidateTitle, knownTitle);
        if (score > bestMatch.score) {
            bestMatch = {
                score,
                title: knownTitle
            };
        }
    });

    return bestMatch;
}

function extractMetadataFromFilename(fileName, options = {}) {
    const safeName = sanitizeUploadFileName(fileName);
    const parsedName = path.parse(safeName).name;
    const rawTitle = cleanupTitle(parsedName);
    const strippedTitle = stripReleaseTags(rawTitle) || cleanupTitle(rawTitle.replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')) || rawTitle;

    let title = strippedTitle;
    let author = '';

    const byMatch = strippedTitle.match(/^(.+?)\s+by\s+(.+)$/i);
    if (byMatch) {
        title = cleanupTitle(byMatch[1]);
        author = cleanupTitle(byMatch[2]);
    } else {
        const segments = strippedTitle.split(/\s+-\s+/).map(segment => cleanupTitle(segment)).filter(Boolean);
        if (segments.length >= 2 && looksLikePersonName(segments[0])) {
            author = segments[0];
            title = cleanupTitle(segments.slice(1).join(' - '));
        }
    }

    const fuzzyMatch = findBestKnownTitleMatch(title, options.knownTitles);
    const shouldUseKnownTitle = fuzzyMatch.score >= 0.78;
    if (shouldUseKnownTitle) {
        title = fuzzyMatch.title;
    }

    return {
        title: title || rawTitle || safeName,
        author,
        confidence: shouldUseKnownTitle ? fuzzyMatch.score : 0,
        matchedExistingTitle: shouldUseKnownTitle ? fuzzyMatch.title : ''
    };
}

function escapeXml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function ensurePdfCover(savedFolder, title) {
    const uploadFolderPath = getUploadFolderPath(savedFolder);
    if (!fs.existsSync(uploadFolderPath)) {
        fs.mkdirSync(uploadFolderPath, { recursive: true });
    }

    const coverFilePath = path.join(uploadFolderPath, PDF_COVER_FILE_NAME);
    const safeTitle = escapeXml(title || 'PDF Upload');
    const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900"><rect width="600" height="900" rx="32" fill="#1f1f1f"/><rect x="48" y="48" width="504" height="804" rx="24" fill="#2d2d2d" stroke="#4b4b4b" stroke-width="4"/><rect x="120" y="120" width="360" height="140" rx="20" fill="#c92a2a"/><text x="300" y="205" text-anchor="middle" font-size="88" font-family="Arial, sans-serif" font-weight="700" fill="#ffffff">PDF</text><foreignObject x="90" y="320" width="420" height="420"><div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;height:420px;align-items:center;justify-content:center;text-align:center;color:white;font-family:Arial,sans-serif;font-size:34px;font-weight:600;line-height:1.35;padding:0 12px;word-break:break-word;">${safeTitle}</div></foreignObject></svg>`;
    fs.writeFileSync(coverFilePath, svgContent, 'utf8');

    return PDF_COVER_FILE_NAME;
}

function listComicPages(savedFolder) {
    const comicAssets = resolveComicAssets(savedFolder);
    if (comicAssets.viewerType !== 'image') {
        return [];
    }

    return comicAssets.images.map((relativePath, index) => ({
        index,
        number: index + 1,
        relativePath,
        fileName: path.posix.basename(relativePath)
    }));
}

function buildManagedPageFileName(pageNumber, originalFileName) {
    const safeFileName = sanitizeUploadFileName(originalFileName || `page-${pageNumber}`);
    const parsedFile = path.parse(safeFileName);
    const safeBaseName = (parsedFile.name || `page-${pageNumber}`).replace(/\s+/g, '-');
    return `${String(pageNumber).padStart(4, '0')}-${safeBaseName}${parsedFile.ext.toLowerCase()}`;
}

function removeEmptyDirectories(directoryPath, rootPath = directoryPath) {
    if (!fs.existsSync(directoryPath) || !fs.lstatSync(directoryPath).isDirectory()) {
        return;
    }

    const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }

        const childPath = path.join(directoryPath, entry.name);
        removeEmptyDirectories(childPath, rootPath);
        if (childPath !== rootPath && fs.existsSync(childPath) && fs.readdirSync(childPath).length === 0) {
            fs.rmdirSync(childPath);
        }
    }
}

function rebuildComicImagePages(savedFolder, pageEntries) {
    const uploadFolderPath = getUploadFolderPath(savedFolder);
    if (!fs.existsSync(uploadFolderPath) || !fs.lstatSync(uploadFolderPath).isDirectory()) {
        throw new Error('Comic folder does not exist.');
    }

    const normalizedEntries = Array.isArray(pageEntries) ? pageEntries : [];
    const tempDirectoryName = `${PAGE_MANAGER_TEMP_PREFIX}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tempDirectoryPath = path.join(uploadFolderPath, tempDirectoryName);
    fs.mkdirSync(tempDirectoryPath, { recursive: true });

    normalizedEntries.forEach((entry, index) => {
        const pageNumber = index + 1;
        const sourceFileName = entry.fileName || entry.relativePath || `page-${pageNumber}.png`;
        if (!isSupportedComicImageFile(sourceFileName)) {
            throw new Error('Only image pages can be managed here.');
        }

        const targetFileName = buildManagedPageFileName(pageNumber, sourceFileName);
        const targetFilePath = path.join(tempDirectoryPath, targetFileName);

        if (entry.type === 'existing') {
            const sourceFilePath = path.join(uploadFolderPath, entry.relativePath);
            if (!fs.existsSync(sourceFilePath)) {
                throw new Error(`Missing existing page: ${entry.relativePath}`);
            }
            fs.copyFileSync(sourceFilePath, targetFilePath);
            return;
        }

        if (entry.type === 'upload') {
            if (!entry.tempFilePath || !fs.existsSync(entry.tempFilePath)) {
                throw new Error(`Uploaded page could not be read: ${sourceFileName}`);
            }
            fs.copyFileSync(entry.tempFilePath, targetFilePath);
            return;
        }

        throw new Error('Unsupported page operation requested.');
    });

    const imageFiles = collectRelativeFiles(uploadFolderPath).filter(filePath => isSupportedComicImageFile(filePath) && !filePath.startsWith(`${tempDirectoryName}/`));
    imageFiles.forEach(relativePath => {
        const absolutePath = path.join(uploadFolderPath, relativePath);
        if (fs.existsSync(absolutePath)) {
            fs.unlinkSync(absolutePath);
        }
    });

    fs.readdirSync(tempDirectoryPath).forEach(fileName => {
        fs.renameSync(path.join(tempDirectoryPath, fileName), path.join(uploadFolderPath, fileName));
    });
    fs.rmdirSync(tempDirectoryPath);
    removeEmptyDirectories(uploadFolderPath);

    return resolveComicAssets(savedFolder);
}

function resolveComicAssets(savedFolder) {
    const uploadFolderPath = getUploadFolderPath(savedFolder);
    if (!fs.existsSync(uploadFolderPath) || !fs.lstatSync(uploadFolderPath).isDirectory()) {
        return {
            viewerType: 'unknown',
            coverImage: '',
            totalPages: 0,
            images: [],
            pdfFile: ''
        };
    }

    const allFiles = collectRelativeFiles(uploadFolderPath);
    const imageFiles = allFiles.filter(filePath => IMAGE_FILE_REGEX.test(filePath) && filePath !== PDF_COVER_FILE_NAME);
    const pdfFiles = allFiles.filter(filePath => PDF_FILE_REGEX.test(filePath));

    if (imageFiles.length > 0) {
        return {
            viewerType: 'image',
            coverImage: imageFiles[0],
            totalPages: imageFiles.length,
            images: imageFiles,
            pdfFile: ''
        };
    }

    if (pdfFiles.length > 0) {
        return {
            viewerType: 'pdf',
            coverImage: fs.existsSync(path.join(uploadFolderPath, PDF_COVER_FILE_NAME)) ? PDF_COVER_FILE_NAME : '',
            totalPages: 1,
            images: [],
            pdfFile: pdfFiles[0]
        };
    }

    return {
        viewerType: 'unknown',
        coverImage: '',
        totalPages: 0,
        images: [],
        pdfFile: ''
    };
}

module.exports = {
    ALLOWED_UPLOAD_EXTENSIONS,
    PDF_COVER_FILE_NAME,
    ensurePdfCover,
    extractMetadataFromFilename,
    getUploadFolderPath,
    isSupportedComicImageFile,
    listComicPages,
    rebuildComicImagePages,
    resolveComicAssets,
    sanitizeUploadFileName
};
