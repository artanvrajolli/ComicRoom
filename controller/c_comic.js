const fs = require('fs')
const extractComics = require('../utils/extractComic')
const comic_table = require('../model/m_comic')
const Op = require('sequelize').Op;
const lastPage_table = require('../model/m_lastPage');

const PostComicUpload = (req,res)=>{
    if(typeof req.files.fileComicUpload == 'undefined' || req.files.fileComicUpload == null){
        req.session.msg = "Empty file given!";
        res.redirect("/comic/upload")
        return;
    }
    if(Array.isArray(req.files.fileComicUpload)){
        req.session.msg = "More the one file has been given!";
        res.redirect("/comic/upload")
        return;
    }
    if(typeof req.session.userData == 'undefined'){
        req.session.msg = "You must be logged in to upload an image!"
        res.redirect("/login")
        return;
    }
    var extension = req.files.fileComicUpload.name.split(".").pop();
    if(!["cbz","cbr"].includes(extension)){
        req.session.msg = "Extension should be .cbz or .cbr";
        res.redirect("/comic/upload")
        return;
    }
    if(extension == "cbr"){
        fs.renameSync(req.files.fileComicUpload.tempFilePath,req.files.fileComicUpload.tempFilePath+".rar")
    }
    var comicFolder_Id = "comic_"+new Date().getTime();
    extractComics(req.files.fileComicUpload.tempFilePath,extension,comicFolder_Id);
    comic_table.create({
        savedFolder: comicFolder_Id,
        uid: req.session.userData.id
    }).then((data)=>{
        res.redirect("/comic/"+comicFolder_Id+"/"+data.id)
        req.session.msg = "";
    }).catch((err)=>{
        console.log(err);
    })
    
    
}

function findMainFolderImages(fileOrDir){

    if(fileOrDir.match(/\.(?:APNG|AVIF|GIF|JPEG|PNG|SVG|WebP|JPG)$/i)){
        const str = fileOrDir;
        const words = str.split(/\/|\\/);
        words.pop();
        return words.join("/").split("uploads/")[1];
    }
    if(fs.lstatSync(process.cwd()+fileOrDir).isDirectory()){
        var files = fs.readdirSync(process.cwd()+fileOrDir);
        for(var i=0;i<files.length;i++){
            if(findMainFolderImages(fileOrDir+"/"+files[i]) != ""){
                return (fileOrDir+"/"+files[i]).split("uploads/")[1];
            }
        }
    }

    return "";
    
}

const UpdateComicDetails =async (req,res)=>{

    var comic_folder_id = req.params.folderID;
    var comic_id = req.params.id_db;

    MainFolderCheck = findMainFolderImages("/public/uploads/"+comic_folder_id);
    
    if(MainFolderCheck.match(/(?:APNG|AVIF|GIF|JPEG|PNG|SVG|WebP|JPG)$/i) == null){
        comic_folder_id = MainFolderCheck;
        console.log(MainFolderCheck)
    }
    
    var part_file = fs.readdirSync(process.cwd()+"/public/uploads/"+comic_folder_id).filter(item => {
    const regex = /(?:APNG|AVIF|GIF|JPEG|PNG|SVG|WebP|JPG)$/i;
    return item.match(regex) == null ? false : true;
    });
    // fs.lstatSync(part_file[0]).isDirectory() 
    await comic_table.update({
        coverImage: part_file[0],
        totalPages: part_file.length,
        title:req.body.title,
        author:req.body.author,
        description:req.body.description,
        savedFolder:comic_folder_id
     }, {
     where: {
         //savedFolder: comic_folder_id
         id:comic_id
     }
     });

     res.redirect("/comic");
}


const showcomic_id = async (req,res)=>{
    var comic_id = req.params.id;

    comic_table.findOne({
        where:{
            id:comic_id
        }
    }).then(async (data)=>{
        var images_file = fs.readdirSync(process.cwd()+"/public/uploads/"+data.savedFolder).filter(item => {
        const regex = /(?:APNG|AVIF|GIF|JPEG|PNG|SVG|WebP|JPG)$/i;
        return item.match(regex) == null ? false : true;
        }).map((item)=> "\'"+escape(item)+"\'");
        if(typeof req.session.userData != 'undefined'){
            var pageNumber = await fetchPage(comic_id,req.session.userData.id);
        }else{
            var pageNumber = 0;
        }
        res.render("comicView",{ userData:req.session.userData , comicImages:images_file , savedFolder:data.savedFolder,comicTitle:data.title,comic_Field:data,pageNumber: pageNumber})
    }).catch((err)=>{
        console.log(err);
    })
}

const showgallery_comic = async (req,res)=>{
    var searchKeywords = req.query.keyword || "";
    comic_table.findAll({
        attributes:["id","title","coverImage","description","totalPages","savedFolder"],
        where:{
            [Op.not]:{
                [Op.or]:{
                    title:null,
                    coverImage: ""
                }
            },
            [Op.or]:{
                title: {[Op.like]: '%'+searchKeywords+'%'},
                description:{[Op.like]: '%'+searchKeywords+'%'},
                author:{[Op.like]: '%'+searchKeywords+'%'},
            }
            
        },
        order: [
            ['id', 'DESC'],
        ],
        limit:12
    }).then((data)=>{
        res.render("v_comicGallery",{ comics:data, userData: req.session.userData , searchKeywords:searchKeywords })
    }).catch((err)=>{
        res.send(err);
    })
}

const fetchPage = async (id_comic,userId)=>{
    if(typeof userId == 'undefined'){
        return 0;
    }
    var data = await lastPage_table.findOne({
        where:{
            comicId: id_comic,
            userId: userId
        }
    })
    if(!data){
        return 0;
    }
    return data.pageNumber;
}

module.exports = {  PostComicUpload , findMainFolderImages , UpdateComicDetails,showcomic_id ,showgallery_comic}