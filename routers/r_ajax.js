const router = require('express').Router();
const {updateLastPage,fetchComic} = require("../controller/c_ajax")


router.get("/lastpage/update/:comicId/:pageNumber",updateLastPage)

router.put("/comic/:offset",fetchComic)

module.exports = router;