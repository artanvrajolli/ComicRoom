const router = require('express').Router();
const {addComicPages, deleteComic, deleteComicPage, PostComicUpload ,UpdateComicDetails ,showcomic_id,showgallery_comic,serveComicCover, checkIfisOnline, getUpdateComicDetails, getComicAiMetadata, getUploadStatus, getUploadStatusAPI, moveComicPage, PostChunkedUpload, requireLoginJson, servePageThumbnail, getUploadsPage, dismissUploadJob, PostShareTarget} = require('../controller/c_comic')

//Show gallery
router.get("/",showgallery_comic)
//Show comic Page
router.get("/show/:id",showcomic_id)
// Cover thumbnail (must stay above the /:folderID/:id_db routes)
router.get("/cover/:id",serveComicCover)
// Page thumbnail: /page-thumb/:id?file=<page relativePath> (also above /:folderID/:id_db)
router.get("/page-thumb/:id",servePageThumbnail)

router.get("/upload",checkIfisOnline,(req,res)=>{
    var msg = req.session.msg;
    req.session.msg = "";
    res.render("v_comicUpload",{ msg, userData: req.session.userData });
})

// comic upload post
router.post("/upload",PostComicUpload)

// chunked upload endpoint
router.post("/upload-chunk", checkIfisOnline, PostChunkedUpload)

// upload status page
router.get("/status/:jobId", checkIfisOnline, getUploadStatus)

// the user's recent uploads
router.get("/uploads", checkIfisOnline, getUploadsPage)
router.post("/uploads/:jobId/dismiss", requireLoginJson, dismissUploadJob)

// Web Share Target (installed PWA): multipart, file field "comic"
router.post("/share-target", PostShareTarget)

// comic details get
router.get("/:folderID/:id_db",checkIfisOnline,getUpdateComicDetails)
// comic details post
router.post("/:folderID/:id_db",checkIfisOnline,UpdateComicDetails)
// fill title and author with AI
router.post("/:folderID/:id_db/ai-metadata",checkIfisOnline,getComicAiMetadata)
router.post("/:folderID/:id_db/pages/add",checkIfisOnline,addComicPages)
router.post("/:folderID/:id_db/pages/delete",checkIfisOnline,deleteComicPage)
router.post("/:folderID/:id_db/pages/move",checkIfisOnline,moveComicPage)
// delete the whole comic (uploader or admin)
router.post("/:folderID/:id_db/delete",checkIfisOnline,deleteComic)


module.exports = router;