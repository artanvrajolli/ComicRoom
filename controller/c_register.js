const Op = require('sequelize').Op
const Users_table = require("../model/m_users");




async function CheckerBody(req,res,next){
    var fail = false;
    var msg = [];
    const usernameRegex = /^[a-zA-Z0-9]+$/;
    if(!usernameRegex.test(req.body.username)){
        msg.push("Username Invalid");
        fail = true;
    }
    await Users_table.findOne({
        where:{
        username: req.body.username
        }
    }).then(row => {
        if(row != null){
        msg.push("This username already exist!")
        fail = true
        }
    });
    await Users_table.findOne({
        where:{
            email: req.body.email
            }
    }).then(row => {
        if(row != null){
        msg.push("This email already exist!")
        fail = true
        }
    });
   
    const re = /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;

    if(!re.test(String(req.body.email).toLowerCase())){
        msg.push("Invalid Email given");
        fail = true;
    }

    if(req.body.password.length < 6){
        msg.push("Password length is less than 6 must be more");
        fail = true;
    }
    
    // redirect to /register show msg
    if(fail){
        req.session.msg = msg;
        res.redirect("/register");
    }else{
    // all good 
    next();
    }
}
module.exports = { CheckerBody }