const Users_table = require('../model/m_users');
const Op = require('sequelize').Op;
const router = require('express').Router();
const bcrypt = require('bcrypt');
const {loginPost} = require('../controller/c_login');

router.use((req,res,next)=>{
    // don't show login form if is already login
    if(req.session.userData != null){
        res.redirect("/comic");
        req.session.msg = "";
        return;
    }
    next(); 
})

router.get("/",(req,res)=>{

    res.render("v_login",{msg: req.session.msg});
    req.session.msg = ""; // clean msg
})

router.post("/",loginPost)



module.exports = router;