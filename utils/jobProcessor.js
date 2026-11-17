const fs = require('fs');
const path = require('path');
const comicProcessing = require('./comicProcessing');
const comic_table = require('../model/m_comic');
const UploadJob = require('../model/m_uploadJob');
const { invalidateComicAssets } = require('./comicStorage');
const thumbnails = require('./thumbnails');
const { refreshPrivateFolders } = require('./comicAccess');


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
        comicProcessing.stop();
    }

    async processNextJob() {
        if (this.isProcessing) {
            return;
        }

        let job = null;

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

            const knownTitles = await this.getKnownTitles(job.userId);
            const result = await comicProcessing.run({
                jobId: job.jobId,
                comicFolderId: job.comicFolderId,
                fileName: job.fileName,
                tempFilePath: job.tempFilePath,
                extension: job.extension,
                knownTitles
            }, progress => job.update({ progress }));
            invalidateComicAssets(job.comicFolderId);
            if (!result?.comics?.length) {
                throw new Error('No supported content was found in the uploaded file.');
            }

            const createdComics = [];
            for (const prepared of result.comics) {
                invalidateComicAssets(prepared.savedFolder);
                const comicData = await comic_table.create({
                    ...prepared,
                    uid: job.userId,
                    isPrivate: !!job.makePrivate
                });
                createdComics.push(comicData);
                await job.update({ progress: Math.min(99, 90 + Math.round(createdComics.length / result.comics.length * 9)) });
            }

            // Guard the new folders' page files before anyone is told the comic exists.
            if (job.makePrivate) {
                await refreshPrivateFolders().catch(err => console.error('Could not refresh private comics:', err.message));
            }
            await job.update({
                status: 'completed',
                progress: 100,
                comicId: createdComics[0].id,
                comicFolderId: createdComics[0].savedFolder,
                resultComicIds: createdComics.map(comic => comic.id).join(',')
            });

            await this.removeJobTempFiles(job);

            console.log(`Job ${job.jobId} completed successfully (${createdComics.length} comic${createdComics.length === 1 ? '' : 's'})`);
            createdComics.forEach(comic => thumbnails.warmThumbnail(comic));

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
            makePrivate: !!jobData.makePrivate,
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
