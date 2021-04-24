const router = require('express').Router();
const {updateLastPage,fetchComic} = require("../controller/c_ajax")


router.put("/lastpage/update/:comicId/:pageNumber",updateLastPage)
router.patch("/lastpage/update/:comicId/:pageNumber",updateLastPage)
router.get("/comic/:offset",fetchComic)

module.exports = router;