const comic_table = require('../model/m_comic');
const extractComics = require('../utils/extractComic');
const Op = require('sequelize').Op
const fs = require('fs')
const router = require('express').Router();
const {PostComicUpload} = require('../controller/c_comic')


router.get("/",(req,res,next)=>{
    comic_table.findAll({
        attributes:["id","title","coverImage","description","totalPages","savedFolder"],
        where:{
            [Op.not]:{
                [Op.or]:{
                    title:null,
                    coverImage: ""
                }
            }
            
        },
        order: [
            ['id', 'DESC'],
        ],
        limit:12
    }).then((data)=>{
        /// comics -> "id","title","coverImage","description","totalPages"
        res.render("v_comicGallery",{ comics:data })
    }).catch((err)=>{
        res.send(err);
    })
})

// ajax load 
router.get("/ajax/:offset",(req,res)=>{

    var offset_parma = req.params.offset;
    comic_table.findAll({
        attributes:["id","title","coverImage","description","totalPages","savedFolder"],
        where:{
            [Op.not]:{
                [Op.or]:{
                    title:null,
                    coverImage: ""
                }
            }
            
        },
        order: [
            ['id', 'DESC'],
        ],
        offset : parseInt(offset_parma),
        limit:12
    }).then((data)=>{
        res.send(data);
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

// post upload
router.post("/upload",PostComicUpload)

router.get("/:id",(req,res)=>{
    var comic_folder_id = req.params.id;
    res.render("v_comicDetails");
})

router.post("/:id",(req,res)=>{
 // {"title":"asd","author":"asd","description":"asd","submit":"Finish"}
    var comic_folder_id = req.params.id;
    //console.log(fs.readdirSync(process.cwd()+"/public/uploads/"+comic_folder_id)); // dev
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