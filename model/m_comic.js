const Sequelize = require('sequelize');
const db = require('../config/database');
const Users_table = require('./m_users');

const comic_table = db.define("comics",{
    title:{
        type:Sequelize.STRING(50),
        allowNull:true
    },
    author:{
        type:Sequelize.STRING(50),
        allowNull:true
    },
    coverImage:{
        type:Sequelize.STRING(100),
        allowNull:true
    },
    description:{
        type:Sequelize.STRING(1000),
        allowNull:true
    },
    savedFolder:{
        type:Sequelize.STRING(1000),
        allowNull:true
    },
    totalPages:{
        type:Sequelize.INTEGER
    },
    uid:{
        type:Sequelize.INTEGER
    }
})


module.exports = comic_table;