const router = require('express').Router();
const Users_table = require('../model/m_users');
const {CheckerBody} = require('../controller/c_register');
const bcrypt = require("bcrypt")

// check if is loged in user
router.use((req,res,next)=>{
    if(req.session.userdata != null){
        res.redirect("/comic");
        req.session.msg = ""
    }else{
        next();
    }
})

router.get("/",(req,res)=>{
    res.render("v_register",{ 
        msg:req.session.msg , 
        username:"" , 
        email:"" ,
        password:"" });
    req.session.msg = "";
})
router.post("/",CheckerBody,(req,res)=>{

   Users_table.create({
       username:req.body.username,
       email:   req.body.email,
       password: bcrypt.hashSync(req.body.password,10)
   }).then((data)=>{
        req.session.userData = data;
        res.redirect("/comic");
        req.session.msg = "";
   })
})




module.exports = router;