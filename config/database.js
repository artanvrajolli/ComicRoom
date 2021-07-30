const Sequelize = require('sequelize');
const db = new Sequelize('db_comicroom','root','',{
    host:'localhost',
    dialect:'mysql',
    logging: false
});
module.exports = db;