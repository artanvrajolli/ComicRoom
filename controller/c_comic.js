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
    }).catch((err)=>{
        console.log(err);
    })
    
    res.redirect("/comic/"+comicFolder_Id)
}

module.exports = {PostComicUpload}