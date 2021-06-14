const router = require('express').Router();
const { isOnlineMode } = require('../services/serverResponse');
const { getreadingList } = require('../controller/c_readinglist');

router.get("/",isOnlineMode,getreadingList);
module.exports = router;