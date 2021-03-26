const comic_table = require('../model/m_comic');
const extractComics = require('../utils/extractComic');
const Op = require('sequelize').Op
const fs = require('fs')
const router = require('express').Router();



router.get("/",(req,res,next)=>{
    comic_table.findAll({
        attributes:["id","title","coverImage","description","totalPages","savedFolder"],
        where:{
            [Op.not]:{
                title:null
            }
        }
    }).then((data)=>{
        /// comics -> "id","title","coverImage","description","totalPages"
        res.render("v_comicGallery",{ comics:data })
    }).catch((err)=>{
        res.send(err);
    })
})


router.get("/show/:id",(req,res)=>{
    var comic_id = req.params.id;


    comic_table.findOne({
        where:{
            id:comic_id
        }
    }).then((data)=>{
        var part_file = fs.readdirSync(process.cwd()+"/public/uploads/"+data.savedFolder).filter(item => {
        const regex = /(?:APNG|AVIF|GIF|JPEG|PNG|SVG|WebP|JPG)$/i; // The image file formats that are most commonly used on the web are listed
        return item.match(regex) == null ? false : true;
        });
        var payload = "";
        part_file.forEach(image=>{
            payload += `<img style="height:500px" src="/public/uploads/`+data.savedFolder+`/`+image+`">`
        })
        res.send(payload);
    }).catch((err)=>{
        console.log(err);
    })
})


router.get("/upload",(req,res,next)=>{
    
    var msg = req.session.msg
    req.session.msg = "";
    res.render("v_comicUpload",{ msg: msg});
})

router.post("/upload",async (req,res)=>{
    var extension = req.files.fileToUpload.name.split(".").pop();
    if(!["cbz","cbr"].includes(extension)){
        req.session.msg = "extension should be .cbz or .cbr";
        res.redirect("/comic/upload")
        return;
    }
    if(extension == "cbr"){
        fs.renameSync(req.files.fileToUpload.tempFilePath,req.files.fileToUpload.tempFilePath+".rar")
    }
    var comicFolder_Id = "comic_"+new Date().getTime();
    extractComics(req.files.fileToUpload.tempFilePath,extension,comicFolder_Id);
    comic_table.create({
        savedFolder: comicFolder_Id,
        uid: 1 // placeholder should be req.session.userData.id or something
    }).catch((err)=>{
        console.log(err);
    })
    
    res.redirect("/comic/"+comicFolder_Id)
})

router.get("/:id",(req,res)=>{
    var comic_folder_id = req.params.id;
    res.render("v_comicDetails");
})

router.post("/:id",(req,res)=>{
 // {"title":"asd","author":"asd","description":"asd","submit":"Finish"}
    var comic_folder_id = req.params.id;
    var part_file = fs.readdirSync(process.cwd()+"/public/uploads/"+comic_folder_id).filter(item => {
    const regex = /(?:APNG|AVIF|GIF|JPEG|PNG|SVG|WebP|JPG)$/i; // The image file formats that are most commonly used on the web are listed
    return item.match(regex) == null ? false : true;
    });
     comic_table.update({
        coverImage: part_file[0],
        totalPages: part_file.length,
        title:req.body.title,
        author:req.body.author,
        description:req.body.description
     }, {
     where: {
         savedFolder: comic_folder_id
     }
     }).catch((err)=>{
         console.log(err);
     });
    
    res.send(req.body);

})



module.exports = router;