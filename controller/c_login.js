const Op = require('sequelize').Op
const Users_table = require('../model/m_users')
const bcrypt = require('bcrypt');

const loginPost = (req,res)=>{
    const identifier = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (identifier === '' || password === '') {
        req.session.msg = "Check username or password!";
        res.redirect("/login");
        return;
    }

    Users_table.findOne({
        where:{
            [Op.or]:{
                username: identifier,
                email: identifier
            }
        }
    }).then((data)=>{

    if(data && bcrypt.compareSync(password,data.password)){
        const sessionUser = { id: data.id, username: data.username, email: data.email };
        req.session.regenerate((regenerateError)=>{
            if(regenerateError){
                res.redirect("/login");
                return;
            }
            req.session.userData = sessionUser;
            req.session.msg = "";
            req.session.save(()=>{
                res.redirect("/comic");
            });
        });
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