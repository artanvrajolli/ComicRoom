
const router = require('express').Router();
const {PostComicUpload ,UpdateComicDetails ,showcomic_id,showgallery_comic, checkIfisOnline} = require('../controller/c_comic')


router.get("/",showgallery_comic)

router.get("/show/:id",showcomic_id)



router.get("/upload",checkIfisOnline,(req,res)=>{
    var msg = req.session.msg;
    req.session.msg = "";
    res.render("v_comicUpload",{ msg, userData: req.session.userData });
})

// comic upload post
router.post("/upload",PostComicUpload)

// comic details get
router.get("/:folderID/:id_db",(req,res)=>{
    var msg = req.session.msg;
    req.session.msg = "";
    res.render("v_comicDetails",{  userData: req.session.userData,msg});
})
// comic details post
router.post("/:folderID/:id_db",UpdateComicDetails)




module.exports = router;