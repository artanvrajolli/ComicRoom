const fs = require('fs')
const extractComics = require('../utils/extractComic')
const comic_table = require('../model/m_comic')
const PostComicUpload = (req,res)=>{
    if(typeof req.files.fileComicUpload == 'undefined' || req.files.fileComicUpload == null){
        req.session.msg = "Empty file given!";
        res.redirect("/comic/upload")
        return;
    }
    var extension = req.files.fileComicUpload.name.split(".").pop();
    if(!["cbz","cbr"].includes(extension)){
        req.session.msg = "extension should be .cbz or .cbr";
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
        uid: 1 // placeholder should be req.session.userData.id or something
    }).then((data)=>{
        res.redirect("/comic/"+comicFolder_Id+"/"+data.id)
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

const UpdateComicDetails = (req,res)=>{

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
     comic_table.update({
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
     }).catch((err)=>{
         console.log(err);
     });
    
    res.send(req.body);

}

module.exports = {  PostComicUpload , findMainFolderImages , UpdateComicDetails }