const router = require('express').Router();
const {updateLastPage,fetchComic,fetchReadingList} = require("../controller/c_ajax")
const {getUploadStatusAPI, getActiveJobs} = require("../controller/c_comic")


router.put("/lastpage/update/:comicId/:pageNumber",updateLastPage)
router.patch("/lastpage/update/:comicId/:pageNumber",updateLastPage)
router.get("/upload/status/:jobId", getUploadStatusAPI);
router.get("/upload/active", getActiveJobs);
router.get("/comic/:offset",fetchComic)
router.get("/onread/:offset",fetchReadingList);

module.exports = router;