const Op = require('sequelize').Op
const Users_table = require('../model/m_users')
const bcrypt = require('bcrypt');

const loginPost = (req,res)=>{

    Users_table.findOne({
        where:{
            [Op.or]:{
                username: req.body.username,
                email: req.body.username
            }
        }
    }).then((data)=>{

    if(bcrypt.compareSync(req.body.password,data.password)){
        req.session.userData = data;
        req.session.msg = "";
        res.redirect("/comic");
        return;
    }

    req.session.msg = "Check username or password!";
    res.redirect("/login");
    
    }).catch((err)=>{
        req.session.msg = "Check username or password!";
        res.redirect("/login");
    })
}
const checkifOnline = (req,res,next)=>{
    // don't show login form if is already login
    if(req.session.userData != null){
        res.redirect("/comic");
        req.session.msg = "";
        return;
    }
    next(); 
}

module.exports = {loginPost,checkifOnline};