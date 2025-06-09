const Sequelize = require('sequelize');
const db = require('../config/database');

const UploadJob = db.define("upload_jobs", {
    jobId: {
        type: Sequelize.STRING(100),
        allowNull: false,
        unique: true
    },
    userId: {
        type: Sequelize.INTEGER,
        allowNull: false
    },
    status: {
        type: Sequelize.ENUM('pending', 'processing', 'completed', 'failed'),
        defaultValue: 'pending'
    },
    comicFolderId: {
        type: Sequelize.STRING(100),
        allowNull: false
    },
    comicId: {
        type: Sequelize.INTEGER,
        allowNull: true
    },
    fileName: {
        type: Sequelize.STRING(500),
        allowNull: false
    },
    tempFilePath: {
        type: Sequelize.STRING(1000),
        allowNull: false
    },
    extension: {
        type: Sequelize.STRING(10),
        allowNull: false
    },
    errorMessage: {
        type: Sequelize.TEXT,
        allowNull: true
    },
    progress: {
        type: Sequelize.INTEGER,
        defaultValue: 0
    }
});

module.exports = UploadJob; 