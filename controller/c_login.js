const Op = require('sequelize').Op
const Users_table = require('../model/m_users')

const loginPost = (req,res)=>{
    var msg = []
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
           res.redirect("/comic")
        }else{
            req.session.msg = "Check username or password!";
            res.redirect("/login");
        }
    }).catch((err)=>{
        res.send(err);
    })
}

module.exports = {loginPost};