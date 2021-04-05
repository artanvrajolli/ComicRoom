const Op = require('sequelize').Op
const Users_table = require('../model/m_users')

const loginPost = (req,res)=>{

    Users_table.findOne({
        where:{
            [Op.or]:{
                username: req.body.username,
                email: req.body.username
            }
        }
    }).then((data)=>{
        if(data != null){
            req.session.userData = data;
            res.redirect("/comic");
            req.session.msg = "";
        }else{
            req.session.msg = "Check username or password!";
            res.redirect("/login");
        }
    }).catch((err)=>{
        res.send(err);
    })
}

module.exports = {loginPost};