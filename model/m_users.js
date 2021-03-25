const Sequelize = require('sequelize');
const db = require('../config/database');
const comic_table = require('./m_comic');

const Users_table = db.define("users",{
    username:{
        type:Sequelize.STRING(50),
        allowNull:false
    },
    email:{
        type:Sequelize.STRING(50),
        allowNull:false
    },
    password:{
        type:Sequelize.STRING(100),
        allowNull:false
    }

})



module.exports = Users_table;