const comic_table = require('../model/m_comic');
const extractComics = require('../utils/extractComic');
const fs = require('fs')
const router = require('express').Router();



router.get("/",(req,res,next)=>{
    comic_table.findAll().then((data)=>{
        res.send(data);
    }).catch((err)=>{
        res.send(err);
    })
})


router.get("/upload",(req,res,next)=>{
    res.render("v_comicUpload",{});
})

router.post("/upload",async (req,res)=>{
    var extension = req.files.fileToUpload.name.split(".").pop();
    if(!["cbz","cbr"].includes(extension)){
        res.send("extension should be .cbz or .cbr");
        return;
    }
    if(extension == "cbr"){
        fs.renameSync(req.files.fileToUpload.tempFilePath,req.files.fileToUpload.tempFilePath+".rar")
    }
    var comicFolder_Id = "comic_"+new Date().getTime();
    extractComics(req.files.fileToUpload.tempFilePath,extension,comicFolder_Id);
    res.redirect("/comic/"+comicFolder_Id)
})

router.get("/:id",(req,res)=>{
    // var comic_folder_id = req.params.id;
    // // req.body.title
    // // req.body.author
    // // req.body.description   
    // comic_table.create({
    //     savedFolder: comic_folder_id,
    //     uid: req.session.id
    // }).then((data)=>{
    //     console.log(data)
    //     res.render("v_comicDetails");
    // }).catch((err)=>{
    //     res.send(err)
    // })
    
})



module.exports = router;