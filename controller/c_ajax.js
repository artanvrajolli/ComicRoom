const lastPage_table = require('../model/m_lastPage');
const comic_table = require("../model/m_comic");
const Op = require('sequelize').Op

async function updateOrCreate (req) { 
    var numerLastPages = req.params.pageNumber
    var userId_input =  req.session.userData.id;
    var comic_input = req.params.comicId;
   const foundItem = await lastPage_table.findOne({where:{
        comicId: comic_input,
        userId: userId_input
   }});
    if (!foundItem) {
        const item = await lastPage_table.create({
            comicId: comic_input,
            userId: userId_input,
            pageNumber:numerLastPages
        })
        return true;
    }  
    const item = await lastPage_table.update({
        pageNumber:numerLastPages
    }, {where:{
        comicId: comic_input,
        userId: userId_input
    }});
    return true
}

const updateLastPage = async (req,res)=>{
    if(typeof req.session.userData != 'undefined' && await updateOrCreate(req)){
        res.send("Updated");
    }else{
        res.send("NotUpdated");
    }
}


const fetchComic = (req,res)=>{

    var offset_parma = req.params.offset;

    comic_table.findAndCountAll({
        attributes:["id","title","coverImage","description","totalPages","savedFolder"],
        where:{
            [Op.not]:{
                [Op.or]:{
                    title:null,
                    coverImage: ""
                }
            }
            
        },
        order: [
            ['id', 'DESC'],
        ],
        offset : parseInt(offset_parma),
        limit:12
    }).then((data)=>{
        if(data.length != 0){
            res.send(data.rows);
            return;
        }
        res.send(""); 
       
    }).catch((err)=>{
        res.send(err);
    })

}

module.exports = {updateLastPage,fetchComic}