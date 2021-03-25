const Users_table = require('../model/m_users');
const Op = require('sequelize').Op
const router = require('express').Router();
const bcrypt = require('bcrypt');

router.use((req,res,next)=>{
    // don't show login form if is already login
    if(req.session.userData != null){
        res.redirect("/comic");
        return;
    }
    next(); 
})

router.get("/",(req,res)=>{

    res.render("v_login",{ 
        msg: req.session.msg, 
        username: ""
    });
    req.session.msg = "";
})

router.post("/",(req,res)=>{
    var msg = []
    Users_table.findOne({
        where:{
            username: req.body.username,
        }
    }).then((data)=>{
        if(data != null){
            req.session.userData = data;
           res.redirect("/comic")
        }else{
            req.session.msg = "You found nothing, Goodnight sir";
            res.redirect("/login");
        }
    }).catch((err)=>{
        res.send(err);
    })
    //res.send(req.body)
})



module.exports = router;