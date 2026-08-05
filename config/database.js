const Sequelize = require('sequelize');
const db = new Sequelize('comicroom','root','root',{
    host:'localhost',
    dialect:'mysql',
    logging: false
});
module.exports = db;