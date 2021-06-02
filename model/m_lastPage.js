const Sequelize = require('sequelize');
const db = require("../config/database");
const comic_table = require('./m_comic');
const Users_table = require('./m_users');


var lastPage_table = db.define("lastPage",{
    pageNumber:{
        type:Sequelize.INTEGER
    }
},{
    timestamps:false
})

lastPage_table.belongsTo(comic_table, {
    foreignKey: 'comicId'
})
comic_table.hasMany(lastPage_table);




lastPage_table.belongsTo(Users_table, {
    foreignKey: 'userId'
})
Users_table.hasMany(lastPage_table);


module.exports = lastPage_table;