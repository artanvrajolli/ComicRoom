const Users_table = require('../model/m_users');
const Op = require('sequelize').Op;
const router = require('express').Router();
const bcrypt = require('bcrypt');
const {loginPost,checkifOnline} = require('../controller/c_login');

router.use(checkifOnline);

router.get("/",(req,res)=>{
    var msg = req.session.msg;
    req.session.msg = ""
    res.render("v_login",{msg});
})

router.post("/",loginPost)



module.exports = router;