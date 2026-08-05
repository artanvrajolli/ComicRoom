const fs = require('fs')
const extractComics = require('../utils/extractComic')
const comic_table = require('../model/m_comic')
const Op = require('sequelize').Op;
const lastPage_table = require('../model/m_lastPage');
const crypto = require('crypto');
const jobProcessor = require('../utils/jobProcessor');
const UploadJob = require('../model/m_uploadJob');
const { ALLOWED_UPLOAD_EXTENSIONS, isSupportedComicImageFile, listComicPages, rebuildComicImagePages, resolveComicAssets, sanitizeUploadFileName } = require('../utils/comicStorage');

function checkIfisOnline(req,res,next){
    if(typeof req.session.userData == 'undefined'){
        req.session.msg = "To Upload your comic you need to be logged-in"
        res.redirect("/login");
        return;
    }
    next();
}

function getUploadInfo(fileName) {
    const safeFileName = sanitizeUploadFileName(fileName);
    const extension = safeFileName.includes('.') ? safeFileName.split('.').pop().toLowerCase() : "";
    return {
        safeFileName,
        extension
    };
}

const PostComicUpload = async (req,res)=>{
    console.log('PostComicUpload called');
    console.log('req.files:', req.files);
    console.log('req.session.userData:', req.session.userData);
    
    // Check if req.files exists first
    if(!req.files || typeof req.files.fileComicUpload == 'undefined' || req.files.fileComicUpload == null){
        console.log('No file uploaded');
        req.session.msg = "Empty file given!";
        res.redirect("/comic/upload")
        return;
    }
    if(Array.isArray(req.files.fileComicUpload)){
        console.log('Multiple files uploaded');
        req.session.msg = "More the one file has been given!";
        res.redirect("/comic/upload")
        return;
    }
    if(typeof req.session.userData == 'undefined'){
        console.log('User not logged in');
        req.session.msg = "You must be logged in to upload an image!"
        res.redirect("/login")
        return;
    }
    
    console.log('File details:', {
        name: req.files.fileComicUpload.name,
        size: req.files.fileComicUpload.size,
        tempFilePath: req.files.fileComicUpload.tempFilePath
    });
    const uploadInfo = getUploadInfo(req.files.fileComicUpload.name);
    if(!ALLOWED_UPLOAD_EXTENSIONS.includes(uploadInfo.extension)){
        console.log('Invalid file extension:', uploadInfo.extension);
        req.session.msg = "Extension should be .cbz, .cbr or .pdf";
        res.redirect("/comic/upload")
        return;
    }
    
    var comicFolder_Id = "comic_"+new Date().getTime();
    
    try {
        // Add job to processing queue instead of processing immediately
        const job = await jobProcessor.addJob({
            userId: req.session.userData.id,
            comicFolderId: comicFolder_Id,
            fileName: uploadInfo.safeFileName,
            tempFilePath: req.files.fileComicUpload.tempFilePath,
            extension: uploadInfo.extension
        });
        
        console.log('Job created successfully:', job.jobId);
        req.session.msg = "Upload started! Your comic is being processed. You will be redirected when ready.";
        req.session.uploadJobId = job.jobId; // Store job ID in session for notification tracking
        req.session.uploadFileName = uploadInfo.safeFileName;
        res.redirect("/comic/status/" + job.jobId);
    } catch (error) {
        console.error('Error starting upload job:', error);
        req.session.msg = "Error starting upload process. Please try again.";
        res.redirect("/comic/upload");
    }
}

function findMainFolderImages(fileOrDir){
    const savedFolder = String(fileOrDir || "").split("uploads/")[1] || "";
    const assets = resolveComicAssets(savedFolder);
    if(assets.viewerType === 'image' || assets.viewerType === 'pdf'){
        return savedFolder;
    }
    return "";
}

const findOwnedComic = async (req)=>{
    if(typeof req.session.userData == 'undefined'){
        return null;
    }
    return comic_table.findOne({
        where: {
            id: req.params.id_db,
            uid: req.session.userData.id,
            savedFolder: req.params.folderID
        }
    });
}

const updateComicAssetMetadata = async (comic)=>{
    const comicAssets = resolveComicAssets(comic.savedFolder);
    await comic_table.update({
        coverImage: comicAssets.coverImage,
        totalPages: comicAssets.totalPages
     }, {
     where: {
         id:comic.id,
         uid: comic.uid
     }
     });
    comic.coverImage = comicAssets.coverImage;
    comic.totalPages = comicAssets.totalPages;
    return comicAssets;
}

const getEditablePageEntries = (savedFolder)=>{
    return listComicPages(savedFolder).map((page)=>({
        type: 'existing',
        relativePath: page.relativePath,
        fileName: page.fileName
    }));
}

const normalizePageUploadFiles = (pageFiles)=>{
    if(typeof pageFiles == 'undefined' || pageFiles == null){
        return [];
    }
    if(Array.isArray(pageFiles)){
        return pageFiles.filter(Boolean);
    }
    return [pageFiles];
}

const updateComicDetailsRedirect = (comic)=>`/comic/${comic.savedFolder}/${comic.id}`;

const addComicPages = async (req,res)=>{
    try{
        const comic = await findOwnedComic(req);
        if(!comic){
            req.session.msg = "Comic details could not be found.";
            res.redirect("/comic");
            return;
        }

        const comicAssets = resolveComicAssets(comic.savedFolder);
        if(comicAssets.viewerType !== 'image'){
            req.session.msg = "Page management is available only for image-based comics.";
            res.redirect(updateComicDetailsRedirect(comic));
            return;
        }

        const uploadedFiles = normalizePageUploadFiles(req.files?.pageFiles);
        if(uploadedFiles.length === 0){
            req.session.msg = "Select at least one image page to upload.";
            res.redirect(updateComicDetailsRedirect(comic));
            return;
        }

        const hasUnsupportedFile = uploadedFiles.some((file)=>!isSupportedComicImageFile(file.name));
        if(hasUnsupportedFile){
            req.session.msg = "Only image files can be added as comic pages.";
            res.redirect(updateComicDetailsRedirect(comic));
            return;
        }

        const currentPages = getEditablePageEntries(comic.savedFolder);
        const insertAfter = Number.parseInt(req.body.insertAfter,10);
        const safeInsertAfter = Number.isInteger(insertAfter) && insertAfter >= 0 && insertAfter <= currentPages.length ? insertAfter : currentPages.length;
        const uploadedPages = uploadedFiles.map((file)=>({
            type: 'upload',
            fileName: file.name,
            tempFilePath: file.tempFilePath
        }));
        const nextPages = [
            ...currentPages.slice(0, safeInsertAfter),
            ...uploadedPages,
            ...currentPages.slice(safeInsertAfter)
        ];

        rebuildComicImagePages(comic.savedFolder, nextPages);
        await updateComicAssetMetadata(comic);

        req.session.msg = `${uploadedPages.length} page${uploadedPages.length === 1 ? '' : 's'} added successfully.`;
        res.redirect(updateComicDetailsRedirect(comic));
    }catch(error){
        console.error('Error adding comic pages:', error);
        req.session.msg = "Unable to add the selected pages.";
        res.redirect(`/comic/${req.params.folderID}/${req.params.id_db}`);
    }
}

const deleteComicPage = async (req,res)=>{
    try{
        const comic = await findOwnedComic(req);
        if(!comic){
            req.session.msg = "Comic details could not be found.";
            res.redirect("/comic");
            return;
        }

        const currentPages = getEditablePageEntries(comic.savedFolder);
        if(currentPages.length <= 1){
            req.session.msg = "At least one page must remain in the comic.";
            res.redirect(updateComicDetailsRedirect(comic));
            return;
        }

        const pageNumber = Number.parseInt(req.body.pageNumber,10);
        if(!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > currentPages.length){
            req.session.msg = "Invalid page selected for removal.";
            res.redirect(updateComicDetailsRedirect(comic));
            return;
        }

        const nextPages = currentPages.filter((page, index)=>index !== (pageNumber - 1));
        rebuildComicImagePages(comic.savedFolder, nextPages);
        await updateComicAssetMetadata(comic);

        req.session.msg = `Page ${pageNumber} removed successfully.`;
        res.redirect(updateComicDetailsRedirect(comic));
    }catch(error){
        console.error('Error deleting comic page:', error);
        req.session.msg = "Unable to remove the selected page.";
        res.redirect(`/comic/${req.params.folderID}/${req.params.id_db}`);
    }
}

const moveComicPage = async (req,res)=>{
    try{
        const comic = await findOwnedComic(req);
        if(!comic){
            req.session.msg = "Comic details could not be found.";
            res.redirect("/comic");
            return;
        }

        const currentPages = getEditablePageEntries(comic.savedFolder);
        const pageNumber = Number.parseInt(req.body.pageNumber,10);
        const targetPageNumber = Number.parseInt(req.body.targetPageNumber,10);
        if(!Number.isInteger(pageNumber) || !Number.isInteger(targetPageNumber) || pageNumber < 1 || targetPageNumber < 1 || pageNumber > currentPages.length || targetPageNumber > currentPages.length){
            req.session.msg = "Invalid page move request.";
            res.redirect(updateComicDetailsRedirect(comic));
            return;
        }

        if(pageNumber === targetPageNumber){
            res.redirect(updateComicDetailsRedirect(comic));
            return;
        }

        const nextPages = [...currentPages];
        const [movedPage] = nextPages.splice(pageNumber - 1, 1);
        nextPages.splice(targetPageNumber - 1, 0, movedPage);
        rebuildComicImagePages(comic.savedFolder, nextPages);
        await updateComicAssetMetadata(comic);

        req.session.msg = `Page ${pageNumber} moved to position ${targetPageNumber}.`;
        res.redirect(updateComicDetailsRedirect(comic));
    }catch(error){
        console.error('Error moving comic page:', error);
        req.session.msg = "Unable to move the selected page.";
        res.redirect(`/comic/${req.params.folderID}/${req.params.id_db}`);
    }
}

const getUpdateComicDetails = async (req,res)=>{
    req.session.myComic = crypto.createHash('md5').update(req.params.folderID+"|"+req.params.id_db).digest("hex");
    var msg = req.session.msg;
    req.session.msg = "";
    const comic = await findOwnedComic(req);
    if(!comic){
        req.session.msg = "Comic details could not be found.";
        res.redirect("/comic");
        return;
    }
    const comicAssets = await updateComicAssetMetadata(comic);
    const comicPages = listComicPages(comic.savedFolder);
    res.render("v_comicDetails",{  userData: req.session.userData,msg, comic, comicPages, viewerType: comicAssets.viewerType});
}

const UpdateComicDetails =async (req,res)=>{
    var comic_folder_id = req.params.folderID;
    var comic_id = req.params.id_db;
    if(typeof req.body.title == 'undefined' || req.body.title == ""){
        req.session.msg = "Empty title has been given!"
        res.redirect("/comic/"+comic_folder_id+"/"+comic_id);
        return;
    }
    if(req.session.myComic != crypto.createHash('md5').update(comic_folder_id+"|"+comic_id).digest("hex")){
        req.session.msg = "Incorrect user Comic!"
        res.redirect("/comic/"+comic_folder_id+"/"+comic_id);
        return;
    }

    const comicAssets = resolveComicAssets(comic_folder_id);
    if(comicAssets.viewerType !== 'image' && comicAssets.viewerType !== 'pdf'){
        req.session.msg = "No supported content was found for this upload.";
        res.redirect("/comic/"+comic_folder_id+"/"+comic_id);
        return;
    }

    await comic_table.update({
        coverImage: comicAssets.coverImage,
        totalPages: comicAssets.totalPages,
        title:req.body.title,
        author:req.body.author || "",
        description:req.body.description || "",
        savedFolder:comic_folder_id
     }, {
     where: {
         id:comic_id,
         uid: req.session.userData.id
     }
     });

     res.redirect("/comic");
}


const showcomic_id = async (req,res)=>{
    var comic_id = req.params.id;

    comic_table.findOne({
        where:{
            id:comic_id
        }
    }).then(async (data)=>{
        if(!data){
            res.status(404);
            res.render("v_404", {
                msg: "Comic not found",
                userData: req.session.userData
            });
            return;
        }
        const comicAssets = resolveComicAssets(data.savedFolder);
        if(typeof req.session.userData != 'undefined'){
            var pageNumber = await fetchPage(comic_id,req.session.userData.id);
        }else{
            var pageNumber = 0;
        }
        const canEditComic = typeof req.session.userData != 'undefined' && req.session.userData.id === data.uid;
        if(comicAssets.viewerType === 'pdf' && comicAssets.pdfFile){
            res.render("pdfView",{ userData:req.session.userData , savedFolder:data.savedFolder, pdfFile: comicAssets.pdfFile, comicTitle:data.title,comic_Field:data, canEditComic})
            return;
        }
        if(comicAssets.viewerType !== 'image' || comicAssets.images.length === 0){
            req.session.msg = "This upload does not contain any supported pages.";
            res.redirect("/comic");
            return;
        }
        res.render("comicView",{ userData:req.session.userData , comicImages:comicAssets.images , savedFolder:data.savedFolder,comicTitle:data.title,comic_Field:data,pageNumber: pageNumber, canEditComic})
    }).catch((err)=>{
        console.log(err);
    })
}

const showgallery_comic = async (req,res)=>{
    var searchKeywords = req.query.keyword || "";
    comic_table.findAll({
        attributes:["id","title","coverImage","description","totalPages","savedFolder"],
        where:{
            [Op.not]:{
                [Op.or]:{
                    title:null,
                    coverImage: ""
                }
            },
            [Op.or]:{
                title: {[Op.like]: '%'+searchKeywords+'%'},
                description:{[Op.like]: '%'+searchKeywords+'%'},
                author:{[Op.like]: '%'+searchKeywords+'%'},
            }
            
        },
        order: [
            ['id', 'DESC'],
        ],
        limit:12
    }).then((data)=>{
        if(data.length == 0 && searchKeywords != ""){
            res.status(404)
            res.render("v_404",{
                msg: "NOTHING JUST SPACE HERE",
                userData: req.session.userData ,
                searchKeywords:searchKeywords
            });
            return;
        }
        res.render("v_comicGallery",{ comics:data, userData: req.session.userData , searchKeywords:searchKeywords })

    }).catch((err)=>{
        res.send(err);
    })
}

const fetchPage = async (id_comic,userId)=>{
    if(typeof userId == 'undefined'){
        return 0;
    }
    var data = await lastPage_table.findOne({
        where:{
            comicId: id_comic,
            userId: userId
        }
    })
    if(!data){
        return 0;
    }
    return data.pageNumber;
}

const getUploadStatus = async (req, res) => {
    const jobId = req.params.jobId;
    
    try {
        const job = await jobProcessor.getJobStatus(jobId);
        
        if (!job) {
            req.session.msg = "Upload job not found.";
            res.redirect("/comic");
            return;
        }
        
        // Check if user owns this job
        if (req.session.userData && job.userId !== req.session.userData.id) {
            req.session.msg = "Access denied.";
            res.redirect("/comic");
            return;
        }
        
        var msg = req.session.msg;
        req.session.msg = "";
        
        res.render("v_uploadStatus", {
            userData: req.session.userData,
            job: job,
            msg: msg
        });
        
    } catch (error) {
        console.error('Error getting upload status:', error);
        req.session.msg = "Error checking upload status.";
        res.redirect("/comic");
    }
}

const getUploadStatusAPI = async (req, res) => {
    const jobId = req.params.jobId;
    console.log(`API: Checking status for job ${jobId}`);
    
    try {
        const job = await jobProcessor.getJobStatus(jobId);
        
        if (!job) {
            console.log(`API: Job ${jobId} not found`);
            return res.status(404).json({ error: "Job not found" });
        }
        
        // Check if user owns this job
        if (req.session.userData && job.userId !== req.session.userData.id) {
            console.log(`API: Access denied for job ${jobId}, user ${req.session.userData.id} vs job user ${job.userId}`);
            return res.status(403).json({ error: "Access denied" });
        }
        
        const response = {
            status: job.status,
            progress: job.progress,
            comicId: job.comicId,
            comicFolderId: job.comicFolderId,
            errorMessage: job.errorMessage,
            fileName: job.fileName
        };
        
        console.log(`API: Returning status for job ${jobId}:`, response);
        res.json(response);
        
    } catch (error) {
        console.error('Error getting upload status via API:', error);
        res.status(500).json({ error: "Internal server error" });
    }
}

const getActiveJobs = async (req, res) => {
    console.log('API: Getting active jobs for user:', req.session.userData?.id);
    
    if (!req.session.userData) {
        console.log('API: User not authenticated');
        return res.status(401).json({ error: "Not authenticated" });
    }
    
    try {
        const activeJobs = await UploadJob.findAll({
            where: {
                userId: req.session.userData.id,
                status: {
                    [Op.in]: ['pending', 'processing']
                }
            },
            attributes: ['jobId', 'fileName', 'status', 'progress', 'createdAt']
        });
        
        console.log(`API: Found ${activeJobs.length} active jobs for user ${req.session.userData.id}`);
        res.json({ jobs: activeJobs });
    } catch (error) {
        console.error('Error getting active jobs:', error);
        res.status(500).json({ error: "Internal server error" });
    }
}

const PostChunkedUpload = async (req, res) => {
    try {
        console.log('Chunked upload received:', {
            chunkIndex: req.body.chunkIndex,
            totalChunks: req.body.totalChunks,
            fileName: req.body.fileName,
            uploadId: req.body.uploadId
        });

        // Check authentication
        if (!req.session.userData) {
            return res.status(401).json({ error: "Authentication required" });
        }

        const { chunkIndex, totalChunks, fileName, uploadId } = req.body;
        const chunk = req.files?.chunk;

        if (!chunk || !uploadId || chunkIndex === undefined || !totalChunks || !fileName) {
            return res.status(400).json({ error: "Missing required parameters" });
        }

        // Validate file extension
        const uploadInfo = getUploadInfo(fileName);
        if (!ALLOWED_UPLOAD_EXTENSIONS.includes(uploadInfo.extension)) {
            return res.status(400).json({ error: "Only .cbz, .cbr and .pdf files are allowed" });
        }

        // Create chunks directory if it doesn't exist
        const chunksDir = process.cwd() + `/public/tmp/chunks/${uploadId}`;
        if (!fs.existsSync(chunksDir)) {
            fs.mkdirSync(chunksDir, { recursive: true });
        }

        // Save the chunk
        const chunkPath = `${chunksDir}/chunk_${chunkIndex}`;
        await chunk.mv(chunkPath);

        console.log(`Chunk ${chunkIndex}/${totalChunks - 1} saved for upload ${uploadId}`);

        // Check if all chunks are received
        const chunkFiles = fs.readdirSync(chunksDir);
        if (chunkFiles.length === parseInt(totalChunks)) {
            console.log(`All chunks received for upload ${uploadId}, assembling file...`);

            // Assemble the file
            const finalFilePath = process.cwd() + `/public/tmp/${uploadId}_${uploadInfo.safeFileName}`;
            const writeStream = fs.createWriteStream(finalFilePath);

            for (let i = 0; i < totalChunks; i++) {
                const chunkPath = `${chunksDir}/chunk_${i}`;
                if (fs.existsSync(chunkPath)) {
                    const chunkData = fs.readFileSync(chunkPath);
                    writeStream.write(chunkData);
                    fs.unlinkSync(chunkPath); // Clean up chunk
                }
            }

            writeStream.end();

            // Wait for the write stream to finish
            await new Promise((resolve, reject) => {
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
            });

            // Clean up chunks directory
            fs.rmdirSync(chunksDir);

            // Create a job for processing
            const comicFolderId = "comic_" + new Date().getTime();
            const job = await jobProcessor.addJob({
                userId: req.session.userData.id,
                comicFolderId: comicFolderId,
                fileName: uploadInfo.safeFileName,
                tempFilePath: finalFilePath,
                extension: uploadInfo.extension
            });

            return res.json({
                status: 'complete',
                jobId: job.jobId,
                message: 'File uploaded successfully and processing started'
            });
        } else {
            return res.json({
                status: 'chunk_received',
                chunkIndex: chunkIndex,
                totalReceived: chunkFiles.length,
                totalExpected: totalChunks
            });
        }

    } catch (error) {
        console.error('Chunked upload error:', error);
        res.status(500).json({ error: 'Server error during upload' });
    }
};

module.exports = {  
    addComicPages,
    deleteComicPage,
    PostComicUpload, 
    findMainFolderImages, 
    moveComicPage,
    UpdateComicDetails,
    showcomic_id,
    showgallery_comic,
    checkIfisOnline,
    getUpdateComicDetails,
    getUploadStatus,
    getUploadStatusAPI,
    getActiveJobs,
    PostChunkedUpload
}