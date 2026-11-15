const router = require('express').Router();
const Users_table = require('../model/m_users');
const {CheckerBody} = require('../controller/c_register');
const bcrypt = require("bcrypt")

// check if is loged in user
router.use((req,res,next)=>{
    if(req.session.userData != null){
        res.redirect("/comic");
        return;
    }
    next();
})

router.get("/",(req,res)=>{
    msg = req.session.msg;
    req.session.msg = "";
    res.render("v_register",{ 
        msg, 
        username:"" , 
        email:"" ,
        password:"" });
})
router.post("/",CheckerBody,(req,res)=>{

   Users_table.create({
       username:req.body.username,
       email:   req.body.email,
       password: bcrypt.hashSync(req.body.password,10)
   }).then((data)=>{
        req.session.userData = { id: data.id, username: data.username, email: data.email };
        req.session.msg = "";
        res.redirect("/comic");
   })
})




module.exports = router;