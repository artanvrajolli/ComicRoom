const Sequelize = require('sequelize');
const db = require('../config/database');
const Users_table = require('./m_users');

const comic_table = db.define("comics",{
    title:{
        type:Sequelize.STRING(1000),
        allowNull:true
    },
    author:{
        type:Sequelize.STRING(1000),
        allowNull:true
    },
    coverImage:{
        // Relative path of the cover page inside the comic folder; archives
        // often nest pages in long folder names.
        type:Sequelize.STRING(1000),
        allowNull:true
    },
    description:{
        type:Sequelize.STRING(5000),
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
    },
    // Private comics are visible to their uploader only (NULL = public).
    isPrivate:{
        type:Sequelize.BOOLEAN,
        allowNull:true,
        defaultValue:false
    }
})



module.exports = comic_table;