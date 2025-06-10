const lastPage_table = require('../model/m_lastPage');
const comic_table = require('../model/m_comic');
const Op = require('sequelize').Op;
var getreadingList = (req, res) => {
    var searchKeywords = req.query.keyword || "";
    lastPage_table.findAll({
        include: {
            model: comic_table,
            where: {
                [Op.or]: {
                    title: { [Op.like]: '%' + searchKeywords + '%' },
                    description: { [Op.like]: '%' + searchKeywords + '%' },
                    author: { [Op.like]: '%' + searchKeywords + '%' }
                }
            }
        },
        where: {
            userId: req.session.userData.id,
            pageNumber: {
                [Op.gt]: 1 // fetch 1 > pages saved
            }
        },
        order: [['id', 'DESC']],
        limit: 12
    }).then((data) => {
        if (data.length == 0) {
            res.status(404)
            res.render("v_404", {
                msg: "NOTHING JUST SPACE HERE",
                userData: req.session.userData,
                searchKeywords: searchKeywords
            });
            return;
        }
        res.render("v_comicReadingList", {
            data,
            userData: req.session.userData,
            searchKeywords: searchKeywords
        });
    }).catch((err) => {
        res.send(err);
    })


}

module.exports = {
    getreadingList
}