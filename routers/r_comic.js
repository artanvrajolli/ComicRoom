const comic_table = require('../model/m_comic');
const Op = require('sequelize').Op
const fs = require('fs')
const router = require('express').Router();
const {PostComicUpload ,UpdateComicDetails ,showcomic_id,showgallery_comic} = require('../controller/c_comic')
const lastPage_table = require('../model/m_lastPage')

router.get("/",showgallery_comic)
router.get("/show/:id",showcomic_id)


router.get("/upload",(req,res)=>{
    var msg = req.session.msg
    req.session.msg = "";
    res.render("v_comicUpload",{ msg: msg , userData: req.session.userData });
})

// comic upload post
router.post("/upload",PostComicUpload)

// comic details get
router.get("/:folderID/:id_db",(req,res)=>{
    res.render("v_comicDetails",{  userData: req.session.userData });
})
// comic details post
router.post("/:folderID/:id_db",UpdateComicDetails)




module.exports = router;