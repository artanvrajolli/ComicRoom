const fs = require('fs');
const path = require('path');
const extractComics = require('./extractComic');
const comic_table = require('../model/m_comic');
const UploadJob = require('../model/m_uploadJob');
const { extractMetadataFromFilename, getUploadFolderPath, invalidateComicAssets, resolveComicAssets, sanitizeUploadFileName } = require('./comicStorage');
const thumbnails = require('./thumbnails');
const { detectComicMetadata } = require('./aiMetadata');

class JobProcessor {
    constructor() {
        this.isProcessing = false;
        this.processingInterval = null;
        this.cleanupInterval = null;
    }

    async getKnownTitles(userId) {
        const knownComics = await comic_table.findAll({
            attributes: ['title'],
            where: {
                uid: userId,
                title: {
                    [require('sequelize').Op.ne]: null
                }
            }
        });

        return knownComics
            .map(comic => String(comic.title || '').trim())
            .filter(Boolean);
    }

    start() {
        if (this.processingInterval) {
            return;
        }
        
        console.log('Starting job processor...');
        this.processingInterval = setInterval(() => {
            this.processNextJob();
        }, 5000); // Check for new jobs every 5 seconds
        
        // Hourly cleanup of abandoned chunked uploads and old failed jobs.
        this.cleanupInterval = setInterval(() => {
            this.cleanupStaleChunks();
        }, CHUNK_CLEANUP_INTERVAL_MS);
        this.cleanupInterval.unref();
    }

    stop() {
        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
        }
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        console.log('Job processor stopped');
    }

    async processNextJob() {
        if (this.isProcessing) {
            return;
        }

        let job = null;
        let workingFilePath = '';

        try {
            this.isProcessing = true;
            
            // Find the next pending job
            job = await UploadJob.findOne({
                where: { status: 'pending' },
                order: [['createdAt', 'ASC']]
            });

            if (!job) {
                this.isProcessing = false;
                return;
            }

            console.log(`Processing job ${job.jobId}...`);
            
            // Update job status to processing
            await job.update({ 
                status: 'processing',
                progress: 10,
                errorMessage: null
            });

            const uploadFolderPath = getUploadFolderPath(job.comicFolderId);
            const safeFileName = sanitizeUploadFileName(job.fileName);
            const knownTitles = await this.getKnownTitles(job.userId);
            const extractedMetadata = extractMetadataFromFilename(safeFileName, { knownTitles });
            workingFilePath = job.tempFilePath;

            if (!fs.existsSync(uploadFolderPath)) {
                fs.mkdirSync(uploadFolderPath, { recursive: true });
            }

            if (job.extension === "cbr") {
                const rarPath = job.tempFilePath + ".rar";
                if (fs.existsSync(job.tempFilePath)) {
                    fs.renameSync(job.tempFilePath, rarPath);
                }
                workingFilePath = rarPath;
            }

            await job.update({ progress: 30 });

            console.log(`Extracting comic for job ${job.jobId}...`);
            await extractComics(workingFilePath, job.extension, job.comicFolderId);

            invalidateComicAssets(job.comicFolderId);
            let comicAssets = resolveComicAssets(job.comicFolderId);

            if (comicAssets.viewerType !== 'image' && comicAssets.viewerType !== 'pdf') {
                throw new Error('No supported content was found in the uploaded file.');
            }

            await job.update({ progress: 85 });

            let aiMetadata = null;
            try {
                aiMetadata = await detectComicMetadata(job.comicFolderId, comicAssets.images);
            } catch (error) {
                console.error('AI metadata detection failed:', error.message);
            }

            if (aiMetadata) {
                const found = Array.isArray(aiMetadata.found) ? aiMetadata.found : [];
                console.log(`AI metadata for job ${job.id}: ${found.length ? 'found ' + found.join(', ') : 'nothing visible'}; using filename for anything missing`);
            }

            await job.update({ progress: 95 });

            const comicData = await comic_table.create({
                savedFolder: job.comicFolderId,
                uid: job.userId,
                title: (aiMetadata && aiMetadata.title) || extractedMetadata.title,
                author: (aiMetadata && aiMetadata.author) || extractedMetadata.author || '',
                description: (aiMetadata && aiMetadata.description) || '',
                coverImage: comicAssets.coverImage,
                totalPages: comicAssets.totalPages
            });

            await job.update({
                status: 'completed',
                progress: 100,
                comicId: comicData.id
            });

            try {
                if (workingFilePath && fs.existsSync(workingFilePath)) {
                    fs.unlinkSync(workingFilePath);
                }
                if (job.extension === "cbr" && fs.existsSync(job.tempFilePath)) {
                    fs.unlinkSync(job.tempFilePath);
                }
            } catch (cleanupError) {
                console.error('Error cleaning up temp files:', cleanupError);
            }

            console.log(`Job ${job.jobId} completed successfully`);
            thumbnails.warmThumbnail(comicData);

        } catch (error) {
            console.error('Error processing job:', error);
            
            if (job) {
                await job.update({
                    status: 'failed',
                    errorMessage: error.message
                });
            }
        } finally {
            this.isProcessing = false;
        }
    }

    async addJob(jobData) {
        const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        
        const job = await UploadJob.create({
            jobId: jobId,
            userId: jobData.userId,
            comicFolderId: jobData.comicFolderId,
            fileName: jobData.fileName,
            tempFilePath: jobData.tempFilePath,
            extension: jobData.extension,
            status: 'pending'
        });

        return job;
    }

    async getJobStatus(jobId) {
        return UploadJob.findOne({
            where: { jobId: jobId }
        });
    }

    // Removes public/tmp/chunks/<uploadId> directories untouched for 24h
    // (abandoned chunked uploads) and failed jobs older than 24h. Async fs only.
    async cleanupStaleChunks() {
        const now = Date.now();
        try {
            let chunkDirs = [];
            try {
                chunkDirs = await fs.promises.readdir(CHUNKS_DIR, { withFileTypes: true });
            } catch (err) {
                if (err.code !== 'ENOENT') throw err;
            }

            for (const entry of chunkDirs) {
                if (!entry.isDirectory()) continue;
                const chunkDirPath = path.join(CHUNKS_DIR, entry.name);
                try {
                    const stats = await fs.promises.stat(chunkDirPath);
                    if (now - stats.mtimeMs > STALE_CHUNK_MAX_AGE_MS) {
                        console.log(`Cleaning up stale chunk directory: ${entry.name}`);
                        await fs.promises.rm(chunkDirPath, { recursive: true, force: true });
                    }
                } catch (err) {
                    if (err.code !== 'ENOENT') {
                        console.error('Error cleaning chunk directory:', err.message);
                    }
                }
            }

            // Also clean up old failed upload jobs (and any temp file they left behind)
            const staleFailedJobs = await UploadJob.findAll({
                attributes: ['id', 'tempFilePath', 'extension'],
                where: {
                    status: 'failed',
                    createdAt: {
                        [require('sequelize').Op.lt]: new Date(now - 24 * 60 * 60 * 1000) // Older than 24 hours
                    }
                }
            });
            for (const job of staleFailedJobs) {
                await this.removeJobTempFiles(job);
            }
            if (staleFailedJobs.length > 0) {
                await UploadJob.destroy({ where: { id: staleFailedJobs.map(job => job.id) } });
            }
        } catch (error) {
            console.error('Error during cleanup:', error);
        }
    }

    // Deletes a job's leftover upload file (and the .rar copy made for cbr) when
    // it is a regular file directly inside public/tmp. Never touches anything else.
    async removeJobTempFiles(job) {
        if (!job || !job.tempFilePath) return;
        const candidates = [job.tempFilePath];
        if (job.extension === 'cbr') candidates.push(job.tempFilePath + '.rar');
        for (const candidate of candidates) {
            if (!isSafeTempUploadPath(candidate)) continue;
            try {
                const stats = await fs.promises.lstat(candidate);
                if (stats.isFile()) {
                    await fs.promises.unlink(candidate);
                }
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    console.error('Error removing job temp file:', err.message);
                }
            }
        }
    }
}

// Upload temp files live directly in public/tmp (express-fileupload temp files
// and assembled chunked uploads). The app may be started with cwd == app root,
// so accept either resolution of the tmp folder.
const TMP_ROOTS = Array.from(new Set([
    path.resolve(__dirname, '..', 'public', 'tmp'),
    path.resolve(process.cwd(), 'public', 'tmp')
]));
const CHUNKS_DIR = path.join(process.cwd(), 'public', 'tmp', 'chunks');
const STALE_CHUNK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CHUNK_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function isSafeTempUploadPath(filePath) {
    if (typeof filePath !== 'string' || filePath === '' || filePath.includes('\0')) {
        return false;
    }
    const resolved = path.resolve(filePath);
    return TMP_ROOTS.some(root => path.dirname(resolved) === root);
}

// Create a singleton instance
const jobProcessor = new JobProcessor();

module.exports = jobProcessor;
module.exports.isSafeTempUploadPath = isSafeTempUploadPath; 