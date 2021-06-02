const router = require('express').Router();

router.use("/login",require("./r_login"));
router.use(["/comic","/"],require("./r_comic"));
router.use("/register",require("./r_register"));
router.use("/ajax",require("./r_ajax"));
router.use('/readinglist',require('./r_readinglist'))
// Destroy current Session for the user
router.use("/logout",(req,res)=>{ req.session.destroy(); res.redirect("/comic");}) 

module.exports = router;