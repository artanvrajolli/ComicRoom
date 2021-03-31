const comic_table = require('../model/m_comic');
const Op = require('sequelize').Op
const fs = require('fs')
const router = require('express').Router();
const {PostComicUpload ,UpdateComicDetails} = require('../controller/c_comic')


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
        res.render("v_comicGallery",{ comics:data, userData: req.session.userData })
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
        var images_file = fs.readdirSync(process.cwd()+"/public/uploads/"+data.savedFolder).filter(item => {
        const regex = /(?:APNG|AVIF|GIF|JPEG|PNG|SVG|WebP|JPG)$/i; // The image file formats that are most commonly used on the web are listed
        return item.match(regex) == null ? false : true;
        }).map((item)=> "\'"+item+"\'");
        // var payload = "";
        // part_file.forEach(image=>{
        //     payload += `<img style="height:500px" src="/public/uploads/`+data.savedFolder+`/`+image+`">`
        // })
        // res.send(payload);
        res.render("comicView",{ userData:req.session.userData , comicImages:images_file , savedFolder:data.savedFolder,comicTitle:data.title,comic_Field:data })
    }).catch((err)=>{
        console.log(err);
    })
})


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