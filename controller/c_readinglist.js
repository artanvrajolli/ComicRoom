const lastPage_table = require('../model/m_lastPage');
const comic_table = require('../model/m_comic');
const Op = require('sequelize').Op;
const { keywordWhere, normalizeKeyword } = require('../utils/queryHelpers');

const COMIC_CARD_ATTRIBUTES = ["id", "title", "author", "coverImage", "totalPages", "savedFolder"];
const LAST_PAGE_ATTRIBUTES = ["id", "pageNumber", "comicId", "userId"];

var getreadingList = (req, res) => {
    var searchKeywords = normalizeKeyword(req.query.keyword);
    lastPage_table.findAll({
        attributes: LAST_PAGE_ATTRIBUTES,
        include: {
            model: comic_table,
            attributes: COMIC_CARD_ATTRIBUTES,
            where: searchKeywords ? keywordWhere(searchKeywords) : { title: { [Op.ne]: null } }
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
        console.error('Error loading reading list:', err.message);
        res.status(500).send("Unable to load the reading list.");
    })


}

module.exports = {
    getreadingList
}
