const router = require('express').Router();
const {PostComicUpload ,UpdateComicDetails ,showcomic_id,showgallery_comic, checkIfisOnline, getUpdateComicDetails, getUploadStatus, getUploadStatusAPI, PostChunkedUpload} = require('../controller/c_comic')

//Show gallery
router.get("/",showgallery_comic)
//Show comic Page
router.get("/show/:id",showcomic_id)

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

// comic details get
router.get("/:folderID/:id_db",getUpdateComicDetails)
// comic details post
router.post("/:folderID/:id_db",UpdateComicDetails)




module.exports = router;