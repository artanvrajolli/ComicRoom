const fs = require('fs')
const { pipeline } = require('stream/promises');
const extractComics = require('../utils/extractComic')
const comic_table = require('../model/m_comic')
const Op = require('sequelize').Op;
const lastPage_table = require('../model/m_lastPage');
const crypto = require('crypto');
const jobProcessor = require('../utils/jobProcessor');
const UploadJob = require('../model/m_uploadJob');
const path = require('path');
const { ALLOWED_UPLOAD_EXTENSIONS, getUploadFolderPath, invalidateComicAssets, isSupportedComicImageFile, listComicPages, rebuildComicImagePages, resolveComicAssets, sanitizeUploadFileName } = require('../utils/comicStorage');
const { isAdmin } = require('../utils/admin');
const { detectComicMetadata } = require('../utils/aiMetadata');
const thumbnails = require('../utils/thumbnails');
const { keywordWhere, normalizeKeyword } = require('../utils/queryHelpers');
const { canReadComic, refreshPrivateFolders, visibleComicsWhere } = require('../utils/comicAccess');
const { loadSessionUser } = require('../config/session');

const GALLERY_ATTRIBUTES = ["id","title","author","coverImage","totalPages","savedFolder","isPrivate"];

// Upload forms send private=1 when the uploader keeps the comic to themselves.
const wantsPrivate = (body)=>String(body && body.private || '') === '1';

function checkIfisOnline(req,res,next){
    if(typeof req.session.userData == 'undefined'){
        req.session.msg = "To Upload your comic you need to be logged-in"
        res.redirect("/login");
        return;
    }
    next();
}

// Same as checkIfisOnline, but for JSON endpoints.
function requireLoginJson(req,res,next){
    if(typeof req.session.userData == 'undefined'){
        res.status(401).json({ error: "Authentication required" });
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

// Creates the processing job for an upload file that has been fully received
// (form upload, the chunked upload's final step, Web Share Target).
// `uploadInfo` comes from getUploadInfo() and must already be validated.
const queueUploadJob = (userId, uploadInfo, tempFilePath, makePrivate = false)=>{
    return jobProcessor.addJob({
        userId: userId,
        makePrivate: !!makePrivate,
        comicFolderId: "comic_" + new Date().getTime(),
        fileName: uploadInfo.safeFileName,
        tempFilePath: tempFilePath,
        extension: uploadInfo.extension
    });
}

// Flash message + notification tracking for uploads that redirect to the status page.
const rememberStartedUpload = (req, job, uploadInfo)=>{
    req.session.msg = "Upload started! Your comic is being processed. You will be redirected when ready.";
    req.session.uploadJobId = job.jobId; // Store job ID in session for notification tracking
    req.session.uploadFileName = uploadInfo.safeFileName;
}

const removeUploadTempFile = (file)=>{
    if(file && file.tempFilePath && jobProcessor.isSafeTempUploadPath(file.tempFilePath)){
        fs.promises.unlink(file.tempFilePath).catch(()=>{});
    }
}

const PostComicUpload = async (req,res)=>{
    
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
        req.session.msg = "Extension should be .cbz, .cbr, .zip, .rar or .pdf";
        res.redirect("/comic/upload")
        return;
    }
    
    try {
        // Add job to processing queue instead of processing immediately
        const job = await queueUploadJob(req.session.userData.id, uploadInfo, req.files.fileComicUpload.tempFilePath, wantsPrivate(req.body));
        
        console.log('Job created successfully:', job.jobId);
        rememberStartedUpload(req, job, uploadInfo);
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

// The uploader and admins (ADMIN_USERNAMES) may edit and delete a comic.
// A private comic belongs to its uploader alone.
const canManageComic = (user, comic)=>{
    if(!user || !comic){
        return false;
    }
    if(comic.uid === user.id){
        return true;
    }
    return !comic.isPrivate && isAdmin(user);
}

const findManageableComic = async (req)=>{
    if(typeof req.session.userData == 'undefined'){
        return null;
    }
    const comic = await comic_table.findOne({
        where: {
            id: req.params.id_db,
            savedFolder: req.params.folderID
        }
    });
    return canManageComic(req.session.userData, comic) ? comic : null;
}

const updateComicAssetMetadata = async (comic)=>{
    const comicAssets = resolveComicAssets(comic.savedFolder);
    if(comic.coverImage === comicAssets.coverImage && comic.totalPages === comicAssets.totalPages){
        return comicAssets;
    }
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
    thumbnails.warmThumbnail(comic);
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
        const comic = await findManageableComic(req);
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
        thumbnails.removePageThumbs(comic.id);
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
        const comic = await findManageableComic(req);
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
        thumbnails.removePageThumbs(comic.id);
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
        const comic = await findManageableComic(req);
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
        thumbnails.removePageThumbs(comic.id);
        await updateComicAssetMetadata(comic);

        req.session.msg = `Page ${pageNumber} moved to position ${targetPageNumber}.`;
        res.redirect(updateComicDetailsRedirect(comic));
    }catch(error){
        console.error('Error moving comic page:', error);
        req.session.msg = "Unable to move the selected page.";
        res.redirect(`/comic/${req.params.folderID}/${req.params.id_db}`);
    }
}

// Every upload lives in one "comic_<digits>" directory under public/uploads.
// Older comics store a sub-path ("comic_123/Some Title"); the whole top folder
// belongs to that comic. Returns '' for anything else.
const getComicTopFolder = (savedFolder)=>{
    const match = /^(comic_[0-9]+)(?:\/|$)/.exec(String(savedFolder || ''));
    return match ? match[1] : '';
}

// POST /comic/:folderID/:id_db/delete  (uploader or admin)
const deleteComic = async (req,res)=>{
    let comic = null;
    try{
        comic = await findManageableComic(req);
        if(!comic){
            req.session.msg = "Comic could not be found, or you are not allowed to delete it.";
            res.redirect("/comic");
            return;
        }
        if(String(req.body.confirm || '') !== 'delete'){
            req.session.msg = "Please confirm before deleting the comic.";
            res.redirect(updateComicDetailsRedirect(comic));
            return;
        }

        const comicId = comic.id;
        const savedFolder = comic.savedFolder;
        const title = comic.title || 'Untitled comic';

        await lastPage_table.destroy({ where: { comicId } });
        await UploadJob.update({ comicId: null }, { where: { comicId } });
        await comic_table.destroy({ where: { id: comicId } });

        // Files last: if removing them fails, the comic is already gone from the app.
        const topFolder = getComicTopFolder(savedFolder);
        const sharedWith = topFolder ? await comic_table.count({
            where: { [Op.or]: [{ savedFolder: topFolder }, { savedFolder: { [Op.like]: topFolder + '/%' } }] }
        }) : 0;
        if(topFolder && sharedWith === 0){
            const folderPath = getUploadFolderPath(topFolder);
            const uploadsRoot = path.join(process.cwd(), 'public', 'uploads') + path.sep;
            if(folderPath.startsWith(uploadsRoot)){
                await fs.promises.rm(folderPath, { recursive: true, force: true }).catch((error)=>{
                    console.error(`Could not remove folder of deleted comic ${comicId}:`, error.message);
                });
            }
        }else{
            console.warn(`Deleted comic ${comicId}: files kept (folder ${savedFolder} is unexpected or shared)`);
        }
        invalidateComicAssets(savedFolder);
        thumbnails.removeComicThumbs(comicId).catch(()=>{});
        if(comic.isPrivate){
            refreshPrivateFolders().catch((error)=>console.error('Could not refresh private comics:', error.message));
        }

        console.log(`Comic ${comicId} (${savedFolder}) deleted by user ${req.session.userData.id}${comic.uid === req.session.userData.id ? '' : ' (admin)'}`);
        req.session.msg = `"${title}" was deleted.`;
        res.redirect("/comic");
    }catch(error){
        console.error('Error deleting comic:', error);
        req.session.msg = "Unable to delete the comic. Please try again.";
        res.redirect(comic ? updateComicDetailsRedirect(comic) : "/comic");
    }
}

const getUpdateComicDetails = async (req,res)=>{
    req.session.myComic = crypto.createHash('md5').update(req.params.folderID+"|"+req.params.id_db).digest("hex");
    var msg = req.session.msg;
    req.session.msg = "";
    const comic = await findManageableComic(req);
    if(!comic){
        req.session.msg = "Comic details could not be found.";
        res.redirect("/comic");
        return;
    }
    const comicAssets = await updateComicAssetMetadata(comic);
    const comicPages = listComicPages(comic.savedFolder);
    const isOwner = comic.uid === req.session.userData.id;
    let ownerName = '';
    if(!isOwner){
        const owner = await require('../model/m_users').findByPk(comic.uid, { attributes: ['username'] }).catch(()=>null);
        ownerName = owner ? owner.username : '';
    }
    res.render("v_comicDetails",{  userData: req.session.userData,msg, comic, comicPages, viewerType: comicAssets.viewerType, isOwner, ownerName});
}

const getComicAiMetadata = async (req,res)=>{
    try{
        const comic = await findManageableComic(req);
        if(!comic){
            res.status(404).json({ error: "Comic details could not be found." });
            return;
        }

        const comicAssets = resolveComicAssets(comic.savedFolder);
        if(!Array.isArray(comicAssets.images) || comicAssets.images.length === 0){
            res.status(400).json({ error: "No pages are available for analysis." });
            return;
        }

        const metadata = await detectComicMetadata(comic.savedFolder, comicAssets.images);
        if(!metadata){
            res.status(502).json({ error: "AI could not read this comic. Check the AI configuration and try again." });
            return;
        }

        res.json(metadata);
    }catch(error){
        console.error('AI metadata request failed:', error.message);
        res.status(500).json({ error: "AI metadata request failed." });
    }
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

    const comic = await findManageableComic(req);
    if(!comic){
        req.session.msg = "Comic details could not be found.";
        res.redirect("/comic");
        return;
    }

    const comicAssets = resolveComicAssets(comic_folder_id);
    if(comicAssets.viewerType !== 'image' && comicAssets.viewerType !== 'pdf'){
        req.session.msg = "No supported content was found for this upload.";
        res.redirect("/comic/"+comic_folder_id+"/"+comic_id);
        return;
    }

    const changes = {
        coverImage: comicAssets.coverImage,
        totalPages: comicAssets.totalPages,
        title:req.body.title,
        author:req.body.author || "",
        description:String(req.body.description || "").slice(0, 5000),
        savedFolder:comic_folder_id
    };
    // Only the uploader sees the privacy switch (privacyField marks that it was on the form).
    const privacyChanged = comic.uid === req.session.userData.id && req.body.privacyField === '1'
        && wantsPrivate({ private: req.body.isPrivate }) !== !!comic.isPrivate;
    if(privacyChanged){
        changes.isPrivate = !comic.isPrivate;
    }
    await comic_table.update(changes, {
     where: {
         id:comic.id
     }
     });
    if(privacyChanged){
        await refreshPrivateFolders().catch((error)=>console.error('Could not refresh private comics:', error.message));
        req.session.msg = changes.isPrivate
            ? `"${changes.title}" is now private. Only you can see it.`
            : `"${changes.title}" is now visible to everyone.`;
    }

     res.redirect("/comic");
}


const showcomic_id = async (req,res)=>{
    var comic_id = req.params.id;

    comic_table.findOne({
        where:{
            id:comic_id
        }
    }).then(async (data)=>{
        if(!canReadComic(req.session.userData, data)){
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
        const canEditComic = canManageComic(req.session.userData, data);
        if(comicAssets.viewerType === 'pdf' && comicAssets.pdfFile){
            res.render("pdfView",{ userData:req.session.userData , savedFolder:data.savedFolder, pdfFile: comicAssets.pdfFile, comicTitle:data.title,comic_Field:data, canEditComic})
            return;
        }
        if(comicAssets.viewerType !== 'image' || comicAssets.images.length === 0){
            req.session.msg = "This upload does not contain any supported pages.";
            res.redirect("/comic");
            return;
        }
        // Next comic in gallery order (gallery lists newest first, so "next" is the next lower id).
        const nextComic = await comic_table.findOne({
            attributes: ["id","title"],
            where: {
                id: { [Op.lt]: data.id },
                title: { [Op.ne]: null },
                coverImage: { [Op.ne]: "" },
                [Op.and]: [visibleComicsWhere(req.session.userData)]
            },
            order: [["id","DESC"]]
        }).catch(()=>null);
        res.render("comicView",{ userData:req.session.userData , comicImages:comicAssets.images , savedFolder:data.savedFolder,comicTitle:data.title,comic_Field:data,pageNumber: pageNumber, canEditComic, nextComic: nextComic ? { id: nextComic.id, title: nextComic.title } : null})
    }).catch((err)=>{
        console.error('Error showing comic:', err);
        if(!res.headersSent){
            res.status(500).send("Unable to load this comic.");
        }
    })
}

const showgallery_comic = async (req,res)=>{
    var searchKeywords = normalizeKeyword(req.query.keyword);
    var msg = req.session.msg;
    req.session.msg = "";
    comic_table.findAll({
        attributes: GALLERY_ATTRIBUTES,
        where:{
            [Op.not]:{
                [Op.or]:{
                    title:null,
                    coverImage: ""
                }
            },
            [Op.and]: [visibleComicsWhere(req.session.userData), keywordWhere(searchKeywords)]
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
        res.render("v_comicGallery",{ comics:data, userData: req.session.userData , searchKeywords:searchKeywords, msg })

    }).catch((err)=>{
        console.error('Error loading gallery:', err);
        res.status(500).send("Unable to load comics.");
    })
}

// GET /comic/cover/:id -> resized cover thumbnail (WebP), cached on disk and in memory.
const serveComicCover = async (req,res)=>{
    const comicId = Number.parseInt(req.params.id, 10);
    if(!Number.isInteger(comicId) || comicId < 1 || String(comicId) !== req.params.id){
        res.status(404).end();
        return;
    }
    let comic = null;
    try{
        comic = await comic_table.findByPk(comicId, { attributes: ["id","savedFolder","coverImage","isPrivate","uid"] });
    }catch(err){
        console.error('Cover lookup failed:', err.message);
        res.status(500).end();
        return;
    }
    if(comic && comic.isPrivate && !canReadComic(await loadSessionUser(req, res), comic)){
        res.status(404).end();
        return;
    }
    const originalPath = thumbnails.resolveOriginalCoverPath(comic);
    if(!originalPath){
        res.status(404).end();
        return;
    }

    try{
        const thumb = await thumbnails.getThumbnail(comic);
        res.set({
            'Content-Type': 'image/webp',
            'Cache-Control': `${comic.isPrivate ? 'private' : 'public'}, max-age=${thumbnails.CACHE_MAX_AGE_SECONDS}`,
            'ETag': thumb.etag,
            'Last-Modified': thumb.lastModified.toUTCString()
        });
        if(req.fresh){
            res.status(304).end();
            return;
        }
        res.send(thumb.buffer);
        return;
    }catch(err){
        if(err && err.code === 'ENOENT'){
            res.status(404).end();
            return;
        }
        console.error(`Cover thumbnail failed for comic ${comicId}, serving original:`, err.message);
    }

    // Fallback: stream the original cover (send handles ETag/Last-Modified/304).
    if(comic.isPrivate){
        res.setHeader('Cache-Control', `private, max-age=${thumbnails.CACHE_MAX_AGE_SECONDS}`);
    }
    res.sendFile(originalPath, { maxAge: thumbnails.CACHE_MAX_AGE_SECONDS * 1000, dotfiles: 'allow' }, (err)=>{
        if(err && !res.headersSent){
            res.status(err.status === 404 || err.code === 'ENOENT' ? 404 : 500).end();
        }
    });
}

// GET /comic/page-thumb/:id?file=<page relativePath> -> ~320px WebP page thumbnail.
// `file` must be one of the comic's current pages (listComicPages().relativePath).
const servePageThumbnail = async (req,res)=>{
    const comicId = Number.parseInt(req.params.id, 10);
    if(!Number.isInteger(comicId) || comicId < 1 || String(comicId) !== req.params.id){
        res.status(404).end();
        return;
    }
    const file = req.query.file;
    if(typeof file !== 'string' || file === '' || file.length > 2000){
        res.status(400).end();
        return;
    }
    let comic = null;
    try{
        comic = await comic_table.findByPk(comicId, { attributes: ["id","savedFolder","isPrivate","uid"] });
    }catch(err){
        console.error('Page thumbnail lookup failed:', err.message);
        res.status(500).end();
        return;
    }
    if(!comic || !comic.savedFolder || (comic.isPrivate && !canReadComic(await loadSessionUser(req, res), comic))){
        res.status(404).end();
        return;
    }
    // Only the comic's current pages are served (no traversal, no arbitrary files).
    const isCurrentPage = listComicPages(comic.savedFolder).some((page)=>page.relativePath === file);
    const originalPath = isCurrentPage ? thumbnails.resolveOriginalPagePath(comic, file) : '';
    if(!originalPath){
        res.status(404).end();
        return;
    }

    try{
        const thumb = await thumbnails.getPageThumbnail(comic, file);
        res.set({
            'Content-Type': 'image/webp',
            'Cache-Control': `${comic.isPrivate ? 'private' : 'public'}, max-age=${thumbnails.CACHE_MAX_AGE_SECONDS}`,
            'ETag': thumb.etag,
            'Last-Modified': thumb.lastModified.toUTCString()
        });
        if(req.fresh){
            res.status(304).end();
            return;
        }
        res.send(thumb.buffer);
        return;
    }catch(err){
        if(err && err.code === 'ENOENT'){
            res.status(404).end();
            return;
        }
        console.error(`Page thumbnail failed for comic ${comicId} (${file}), serving original:`, err.message);
    }

    // Fallback: stream the original page (send handles ETag/Last-Modified/304).
    if(comic.isPrivate){
        res.setHeader('Cache-Control', `private, max-age=${thumbnails.CACHE_MAX_AGE_SECONDS}`);
    }
    res.sendFile(originalPath, { maxAge: thumbnails.CACHE_MAX_AGE_SECONDS * 1000, dotfiles: 'allow' }, (err)=>{
        if(err && !res.headersSent){
            res.status(err.status === 404 || err.code === 'ENOENT' ? 404 : 500).end();
        }
    });
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

// Ids of every comic an upload created, in order (bundles create several).
const jobComicIds = (job)=>{
    const ids = String(job && job.resultComicIds || '').split(',').map(Number).filter(Number.isInteger);
    if(ids.length === 0 && job && Number.isInteger(job.comicId)){
        ids.push(job.comicId);
    }
    return ids;
}

// [{ id, title, savedFolder }] for the comics of one upload that still exist.
const getJobComics = async (job)=>{
    const ids = jobComicIds(job);
    if(ids.length === 0){
        return [];
    }
    const rows = await comic_table.findAll({
        attributes: ['id','title','savedFolder'],
        where: { id: { [Op.in]: ids }, uid: job.userId }
    });
    const byId = new Map(rows.map((row)=>[row.id, { id: row.id, title: row.title, savedFolder: row.savedFolder }]));
    return ids.map((id)=>byId.get(id)).filter(Boolean);
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
        
        const comics = job.status === 'completed' ? await getJobComics(job) : [];
        res.render("v_uploadStatus", {
            userData: req.session.userData,
            job: job,
            comics: comics,
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
    
    try {
        const job = await jobProcessor.getJobStatus(jobId);
        
        if (!job) {
            return res.status(404).json({ error: "Job not found" });
        }
        
        // Check if user owns this job
        if (req.session.userData && job.userId !== req.session.userData.id) {
            return res.status(403).json({ error: "Access denied" });
        }
        
        const response = {
            status: job.status,
            progress: job.progress,
            comicId: job.comicId,
            comicFolderId: job.comicFolderId,
            errorMessage: job.errorMessage,
            fileName: job.fileName,
            comics: job.status === 'completed' ? await getJobComics(job) : []
        };
        
        res.json(response);
        
    } catch (error) {
        console.error('Error getting upload status via API:', error);
        res.status(500).json({ error: "Internal server error" });
    }
}

const getActiveJobs = async (req, res) => {
    if (!req.session.userData) {
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
        
        res.json({ jobs: activeJobs });
    } catch (error) {
        console.error('Error getting active jobs:', error);
        res.status(500).json({ error: "Internal server error" });
    }
}

const RECENT_UPLOADS_LIMIT = 50;
const DISMISSABLE_JOB_STATUSES = ['completed', 'failed'];

const toIsoString = (value)=>{
    if(!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Latest upload jobs of a user, newest first, as plain objects:
// { jobId, fileName, extension, status, progress, errorMessage, createdAt, updatedAt, comicId, comic }
// comic = { id, title, savedFolder } or null when it no longer exists.
const getRecentUploadJobs = async (userId)=>{
    const jobs = await UploadJob.findAll({
        attributes: ['jobId','userId','fileName','extension','status','progress','errorMessage','createdAt','updatedAt','comicId','resultComicIds'],
        where: { userId: userId },
        order: [['createdAt','DESC'],['id','DESC']],
        limit: RECENT_UPLOADS_LIMIT
    });
    const comicIds = Array.from(new Set(jobs.flatMap((job)=>jobComicIds(job))));
    const comics = comicIds.length === 0 ? [] : await comic_table.findAll({
        attributes: ['id','title','savedFolder'],
        where: { id: { [Op.in]: comicIds }, uid: userId }
    });
    const comicsById = new Map(comics.map((comic)=>[comic.id, { id: comic.id, title: comic.title, savedFolder: comic.savedFolder }]));
    return jobs.map((job)=>({
        jobId: job.jobId,
        fileName: job.fileName,
        extension: job.extension,
        status: job.status,
        progress: job.progress,
        errorMessage: job.errorMessage,
        createdAt: toIsoString(job.createdAt),
        updatedAt: toIsoString(job.updatedAt),
        comicId: job.comicId,
        comic: (job.comicId && comicsById.get(job.comicId)) || null,
        comics: jobComicIds(job).map((id)=>comicsById.get(id)).filter(Boolean)
    }));
}

// GET /comic/uploads
const getUploadsPage = async (req,res)=>{
    var msg = req.session.msg;
    req.session.msg = "";
    try{
        const jobs = await getRecentUploadJobs(req.session.userData.id);
        res.render("v_uploads", { userData: req.session.userData, msg, jobs });
    }catch(error){
        console.error('Error loading uploads:', error);
        if(!res.headersSent){
            res.status(500).send("Unable to load your uploads.");
        }
    }
}

// GET /ajax/upload/recent
const getRecentUploadsAPI = async (req,res)=>{
    if(!req.session.userData){
        return res.status(401).json({ error: "Not authenticated" });
    }
    try{
        res.json(await getRecentUploadJobs(req.session.userData.id));
    }catch(error){
        console.error('Error getting recent uploads:', error);
        res.status(500).json({ error: "Internal server error" });
    }
}

// POST /comic/uploads/:jobId/dismiss -> removes a finished job row (never the comic).
const dismissUploadJob = async (req,res)=>{
    try{
        const jobId = String(req.params.jobId || '');
        if(jobId === '' || jobId.length > 100){
            return res.status(404).json({ error: "Upload job not found." });
        }
        const job = await UploadJob.findOne({ where: { jobId: jobId } });
        if(!job){
            return res.status(404).json({ error: "Upload job not found." });
        }
        if(job.userId !== req.session.userData.id){
            return res.status(403).json({ error: "Access denied." });
        }
        if(!DISMISSABLE_JOB_STATUSES.includes(job.status)){
            return res.status(409).json({ error: "Only completed or failed uploads can be dismissed." });
        }
        await jobProcessor.removeJobTempFiles(job);
        await job.destroy();
        res.json({ ok: true });
    }catch(error){
        console.error('Error dismissing upload job:', error);
        res.status(500).json({ error: "Unable to dismiss this upload." });
    }
}

// POST /comic/share-target (Web Share Target, multipart field "comic").
const PostShareTarget = async (req,res)=>{
    const received = req.files ? req.files.comic : undefined;
    const files = Array.isArray(received) ? received : (received ? [received] : []);
    const file = files[0];
    files.slice(1).forEach(removeUploadTempFile);

    if(typeof req.session.userData == 'undefined'){
        removeUploadTempFile(file);
        req.session.msg = "Log in to ComicRoom, then share the comic again to upload it.";
        res.redirect(303, "/login");
        return;
    }

    const fail = (message)=>{
        removeUploadTempFile(file);
        req.session.msg = message;
        res.redirect(303, "/comic/upload");
    };

    if(!file || !file.tempFilePath){
        fail("No file was shared. Choose a .cbz, .cbr, .zip, .rar or .pdf file.");
        return;
    }
    if(file.truncated){
        fail("The shared file is larger than the 2 GB upload limit.");
        return;
    }
    if(!file.size){
        fail("The shared file was empty.");
        return;
    }
    const uploadInfo = getUploadInfo(file.name);
    if(!ALLOWED_UPLOAD_EXTENSIONS.includes(uploadInfo.extension)){
        fail("Extension should be .cbz, .cbr, .zip, .rar or .pdf");
        return;
    }

    try{
        const job = await queueUploadJob(req.session.userData.id, uploadInfo, file.tempFilePath);
        console.log('Share target job created:', job.jobId);
        rememberStartedUpload(req, job, uploadInfo);
        res.redirect(303, "/comic/status/" + job.jobId);
    }catch(error){
        console.error('Error starting shared upload job:', error);
        fail("Error starting upload process. Please try again.");
    }
}

// ---------- chunked uploads ----------
// The browser sends a file in parts (public/script/uploadManager.js). Parts land in
// public/tmp/chunks/<uploadId>/chunk_<n>; a ".owner" file records the user. The
// browser may leave and come back (it continues on any page), so it can ask which
// parts arrived, and a repeated final part must not start a second job.
const UPLOAD_ID_REGEX = /^[A-Za-z0-9_-]{1,100}$/;
const CHUNK_PREFIX = 'chunk_';
const assemblingUploads = new Set();

const chunksDirFor = (uploadId)=>path.join(process.cwd(), 'public', 'tmp', 'chunks', uploadId);

// The job created for an upload that was already assembled (tempFilePath starts with the uploadId).
const findJobForUpload = async (userId, uploadId)=>{
    const prefix = path.join(process.cwd(), 'public', 'tmp', uploadId + '_');
    return UploadJob.findOne({
        attributes: ['jobId'],
        where: { userId, tempFilePath: { [Op.like]: prefix.replace(/[\\%_]/g, '\\$&') + '%' } },
        order: [['id','DESC']]
    });
}

const readChunkOwner = async (chunksDir)=>{
    try{
        return Number.parseInt(await fs.promises.readFile(path.join(chunksDir, '.owner'), 'utf8'), 10);
    }catch(error){
        return null;
    }
}

const listReceivedChunks = async (chunksDir)=>{
    let names = [];
    try{ names = await fs.promises.readdir(chunksDir); }catch(error){ return []; }
    const chunks = [];
    for(const name of names){
        if(!name.startsWith(CHUNK_PREFIX)) continue;
        const index = Number.parseInt(name.slice(CHUNK_PREFIX.length), 10);
        if(!Number.isInteger(index)) continue;
        try{
            const stats = await fs.promises.stat(path.join(chunksDir, name));
            chunks.push({ index, size: stats.size });
        }catch(error){}
    }
    return chunks.sort((a, b)=>a.index - b.index);
}

// GET /comic/upload-chunk/:uploadId -> { status: 'complete', jobId } | { status: 'assembling' }
//                                     | { status: 'partial', received: [{index, size}] } | { status: 'none' }
const getChunkedUploadStatus = async (req, res)=>{
    try{
        const uploadId = String(req.params.uploadId || '');
        if(!UPLOAD_ID_REGEX.test(uploadId)){
            return res.status(400).json({ error: "Invalid upload id" });
        }
        const userId = req.session.userData.id;
        if(assemblingUploads.has(uploadId)){
            return res.json({ status: 'assembling' });
        }
        const job = await findJobForUpload(userId, uploadId);
        if(job){
            return res.json({ status: 'complete', jobId: job.jobId });
        }
        const chunksDir = chunksDirFor(uploadId);
        const owner = await readChunkOwner(chunksDir);
        if(owner !== null && owner !== userId){
            return res.status(403).json({ error: "Access denied" });
        }
        const received = await listReceivedChunks(chunksDir);
        res.json(received.length ? { status: 'partial', received } : { status: 'none' });
    }catch(error){
        console.error('Chunk status error:', error);
        res.status(500).json({ error: 'Server error' });
    }
}

// POST /comic/upload-chunk/:uploadId/cancel -> removes the parts received so far
const cancelChunkedUpload = async (req, res)=>{
    try{
        const uploadId = String(req.params.uploadId || '');
        if(!UPLOAD_ID_REGEX.test(uploadId)){
            return res.status(400).json({ error: "Invalid upload id" });
        }
        const chunksDir = chunksDirFor(uploadId);
        const owner = await readChunkOwner(chunksDir);
        if(owner !== null && owner !== req.session.userData.id){
            return res.status(403).json({ error: "Access denied" });
        }
        if(!assemblingUploads.has(uploadId)){
            await fs.promises.rm(chunksDir, { recursive: true, force: true });
        }
        res.json({ ok: true });
    }catch(error){
        console.error('Chunk cancel error:', error);
        res.status(500).json({ error: 'Server error' });
    }
}

const PostChunkedUpload = async (req, res) => {
    try {
        // Check authentication
        if (!req.session.userData) {
            return res.status(401).json({ error: "Authentication required" });
        }
        const userId = req.session.userData.id;

        const { chunkIndex, totalChunks, fileName, uploadId } = req.body;
        const chunk = req.files?.chunk;

        if (!chunk || !uploadId || chunkIndex === undefined || !totalChunks || !fileName) {
            return res.status(400).json({ error: "Missing required parameters" });
        }

        const chunkNumber = Number.parseInt(chunkIndex, 10);
        const chunkTotal = Number.parseInt(totalChunks, 10);
        if (!UPLOAD_ID_REGEX.test(String(uploadId)) || !Number.isInteger(chunkTotal) || chunkTotal < 1 || chunkTotal > 100000 || !Number.isInteger(chunkNumber) || chunkNumber < 0 || chunkNumber >= chunkTotal) {
            return res.status(400).json({ error: "Invalid upload parameters" });
        }

        // Validate file extension
        const uploadInfo = getUploadInfo(fileName);
        if (!ALLOWED_UPLOAD_EXTENSIONS.includes(uploadInfo.extension)) {
            return res.status(400).json({ error: "Only .cbz, .cbr, .zip, .rar and .pdf files are allowed" });
        }

        // A part repeated after the file was already put together (the answer to
        // the last part got lost on the way back): report the existing job.
        if (assemblingUploads.has(uploadId)) {
            return res.json({ status: 'assembling' });
        }
        const existingJob = await findJobForUpload(userId, uploadId);
        if (existingJob) {
            return res.json({ status: 'complete', jobId: existingJob.jobId, message: 'File already uploaded' });
        }

        const chunksDir = chunksDirFor(uploadId);
        await fs.promises.mkdir(chunksDir, { recursive: true });
        const owner = await readChunkOwner(chunksDir);
        if (owner === null) {
            await fs.promises.writeFile(path.join(chunksDir, '.owner'), String(userId));
        } else if (owner !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Save the chunk
        const chunkPath = path.join(chunksDir, CHUNK_PREFIX + chunkNumber);
        await chunk.mv(chunkPath);

        // Check if all chunks are received
        const received = await listReceivedChunks(chunksDir);
        const allThere = received.length === chunkTotal && received.every((part, index)=>part.index === index);
        if (allThere && !assemblingUploads.has(uploadId)) {
            assemblingUploads.add(uploadId);
            try {
                console.log(`All chunks received for upload ${uploadId}, assembling file...`);

                // Assemble the file by streaming each chunk (no sync reads on the request path)
                const finalFilePath = path.join(process.cwd(), 'public', 'tmp', `${uploadId}_${uploadInfo.safeFileName}`);
                const writeStream = fs.createWriteStream(finalFilePath);
                try {
                    for (let i = 0; i < chunkTotal; i++) {
                        await pipeline(fs.createReadStream(path.join(chunksDir, CHUNK_PREFIX + i)), writeStream, { end: false });
                    }
                } finally {
                    writeStream.end();
                }
                if (!writeStream.writableFinished) {
                    await new Promise((resolve, reject) => {
                        writeStream.once('finish', resolve);
                        writeStream.once('error', reject);
                    });
                }

                await fs.promises.rm(chunksDir, { recursive: true, force: true });

                // Create a job for processing
                const job = await queueUploadJob(userId, uploadInfo, finalFilePath, wantsPrivate(req.body));

                return res.json({
                    status: 'complete',
                    jobId: job.jobId,
                    message: 'File uploaded successfully and processing started'
                });
            } finally {
                assemblingUploads.delete(uploadId);
            }
        }
        return res.json({
            status: 'chunk_received',
            chunkIndex: chunkNumber,
            totalReceived: received.length,
            totalExpected: chunkTotal
        });

    } catch (error) {
        console.error('Chunked upload error:', error);
        res.status(500).json({ error: 'Server error during upload' });
    }
};

module.exports = {  
    addComicPages,
    canManageComic,
    deleteComic,
    deleteComicPage,
    PostComicUpload, 
    findMainFolderImages, 
    moveComicPage,
    UpdateComicDetails,
    showcomic_id,
    showgallery_comic,
    serveComicCover,
    checkIfisOnline,
    getUpdateComicDetails,
    getComicAiMetadata,
    getUploadStatus,
    getUploadStatusAPI,
    getActiveJobs,
    PostChunkedUpload,
    getChunkedUploadStatus,
    cancelChunkedUpload,
    requireLoginJson,
    servePageThumbnail,
    getUploadsPage,
    getRecentUploadsAPI,
    dismissUploadJob,
    PostShareTarget
}