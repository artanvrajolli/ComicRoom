const fs = require('fs');
const extractComics = require('./extractComic');
const comic_table = require('../model/m_comic');
const UploadJob = require('../model/m_uploadJob');

class JobProcessor {
    constructor() {
        this.isProcessing = false;
        this.processingInterval = null;
        this.cleanupInterval = null;
    }

    start() {
        if (this.processingInterval) {
            return;
        }
        
        console.log('Starting job processor...');
        this.processingInterval = setInterval(() => {
            this.processNextJob();
        }, 5000); // Check for new jobs every 5 seconds
        
        // Start cleanup interval for stale chunks (every 30 minutes)
        this.cleanupInterval = setInterval(() => {
            this.cleanupStaleChunks();
        }, 30 * 60 * 1000);
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

        try {
            this.isProcessing = true;
            
            // Find the next pending job
            const job = await UploadJob.findOne({
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
                progress: 10
            });

            // Prepare file path for extraction
            let tempFilePath = job.tempFilePath;
            if (job.extension === "cbr") {
                const rarPath = job.tempFilePath + ".rar";
                if (fs.existsSync(job.tempFilePath)) {
                    fs.renameSync(job.tempFilePath, rarPath);
                }
                tempFilePath = rarPath;
            }

            // Update progress
            await job.update({ progress: 30 });

            // Extract the comic
            console.log(`Extracting comic for job ${job.jobId}...`);
            await extractComics(tempFilePath, job.extension, job.comicFolderId);

            // Update progress
            await job.update({ progress: 80 });

            // Create comic record in database
            const comicData = await comic_table.create({
                savedFolder: job.comicFolderId,
                uid: job.userId
            });

            // Update job with completion
            await job.update({
                status: 'completed',
                progress: 100,
                comicId: comicData.id
            });

            // Clean up temp file
            try {
                if (fs.existsSync(tempFilePath)) {
                    fs.unlinkSync(tempFilePath);
                }
                if (job.extension === "cbr" && fs.existsSync(job.tempFilePath)) {
                    fs.unlinkSync(job.tempFilePath);
                }
            } catch (cleanupError) {
                console.error('Error cleaning up temp files:', cleanupError);
            }

            console.log(`Job ${job.jobId} completed successfully`);

        } catch (error) {
            console.error('Error processing job:', error);
            
            // Update job with error status
            const job = await UploadJob.findOne({
                where: { status: 'processing' },
                order: [['updatedAt', 'DESC']]
            });
            
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
        console.log(`JobProcessor: Getting status for job ${jobId}`);
        const job = await UploadJob.findOne({
            where: { jobId: jobId }
        });
        
        if (job) {
            console.log(`JobProcessor: Found job ${jobId} with status ${job.status}, progress ${job.progress}%`);
        } else {
            console.log(`JobProcessor: Job ${jobId} not found in database`);
        }
        
        return job;
    }

    async cleanupStaleChunks() {
        try {
            const chunksBasePath = process.cwd() + '/public/tmp/chunks';
            if (!fs.existsSync(chunksBasePath)) {
                return;
            }

            const chunkDirs = fs.readdirSync(chunksBasePath);
            const now = Date.now();
            const maxAge = 2 * 60 * 60 * 1000; // 2 hours

            for (const chunkDir of chunkDirs) {
                const chunkDirPath = `${chunksBasePath}/${chunkDir}`;
                try {
                    const stats = fs.statSync(chunkDirPath);
                    if (now - stats.mtime.getTime() > maxAge) {
                        console.log(`Cleaning up stale chunk directory: ${chunkDir}`);
                        // Remove all chunk files
                        const chunkFiles = fs.readdirSync(chunkDirPath);
                        for (const chunkFile of chunkFiles) {
                            fs.unlinkSync(`${chunkDirPath}/${chunkFile}`);
                        }
                        fs.rmdirSync(chunkDirPath);
                    }
                } catch (err) {
                    console.error('Error cleaning chunk directory:', err.message);
                }
            }

            // Also cleanup old failed upload jobs
            await UploadJob.destroy({
                where: {
                    status: 'failed',
                    createdAt: {
                        [require('sequelize').Op.lt]: new Date(now - 24 * 60 * 60 * 1000) // Older than 24 hours
                    }
                }
            });

        } catch (error) {
            console.error('Error during cleanup:', error);
        }
    }
}

// Create a singleton instance
const jobProcessor = new JobProcessor();

module.exports = jobProcessor; 