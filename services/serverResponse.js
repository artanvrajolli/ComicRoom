



var checkOnlineMode =(req,res,next)=>{
    if(req.session.userData){
        next();
    }else{
        res.status(404)
        res.redirect("/comic")
        return;
    }
}

module.exports = {
    checkOnlineMode
}