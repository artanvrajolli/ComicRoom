
const router = require('express').Router();
const {PostComicUpload ,UpdateComicDetails ,showcomic_id,showgallery_comic} = require('../controller/c_comic')


router.get("/",showgallery_comic)

router.get("/show/:id",showcomic_id)

function checkIfisOnline(req,res,next){
    if(typeof req.session.userData == 'undefined'){
        req.session.msg = "To Upload your comic you need to be logged-in"
        res.redirect("/login");
        return;
    }
    next();
}

router.get("/upload",checkIfisOnline,(req,res)=>{
    res.render("v_comicUpload",{ msg: req.session.msg , userData: req.session.userData });
    req.session.msg = "";
})

// comic upload post
router.post("/upload",PostComicUpload)

// comic details get
router.get("/:folderID/:id_db",(req,res)=>{
    res.render("v_comicDetails",{  userData: req.session.userData,msg: req.session.msg });
    req.session.msg = "";
})
// comic details post
router.post("/:folderID/:id_db",UpdateComicDetails)




module.exports = router;