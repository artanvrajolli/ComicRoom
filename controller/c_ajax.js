const lastPage_table = require('../model/m_lastPage');
const comic_table = require("../model/m_comic");
const Op = require('sequelize').Op
const { visibleComicsWhere } = require('../utils/comicAccess');
const { keywordWhere, normalizeKeyword, parseOffset } = require('../utils/queryHelpers');
const dbIndexes = require('../utils/dbIndexes');

const PAGE_SIZE = 12;
const COMIC_CARD_ATTRIBUTES = ["id", "title", "author", "coverImage", "totalPages", "savedFolder", "isPrivate"];
const LAST_PAGE_ATTRIBUTES = ["id", "pageNumber", "comicId", "userId"];

async function updateOrCreate(req) {
    const pageNumber = Number.parseInt(req.params.pageNumber, 10);
    const comicId = Number.parseInt(req.params.comicId, 10);
    const userId = req.session.userData.id;
    if (!Number.isInteger(pageNumber) || pageNumber < 0 || !Number.isInteger(comicId) || comicId < 1) {
        return false;
    }

    // Single INSERT ... ON DUPLICATE KEY UPDATE when the (userId, comicId) unique index exists.
    if (dbIndexes.hasLastPageUniqueIndex()) {
        await lastPage_table.upsert({
            comicId,
            userId,
            pageNumber
        }, {
            fields: ['pageNumber'],
            returning: false
        });
        return true;
    }

    const [affected] = await lastPage_table.update({ pageNumber }, {
        where: { comicId, userId }
    });
    if (affected === 0) {
        const existing = await lastPage_table.findOne({
            attributes: ['id'],
            where: { comicId, userId }
        });
        if (!existing) {
            await lastPage_table.create({ comicId, userId, pageNumber });
        }
    }
    return true;
}

const updateLastPage = async (req, res) => {
    try {
        if (typeof req.session.userData != 'undefined' && await updateOrCreate(req)) {
            res.send("Updated");
        } else {
            res.send("NotUpdated");
        }
    } catch (err) {
        console.error('Error updating last page:', err.message);
        res.status(500).send("NotUpdated");
    }
}


const fetchComic = (req, res) => {
    const offset = parseOffset(req.params.offset);
    const searchKeywords = normalizeKeyword(req.query.keyword);
    comic_table.findAll({
        attributes: COMIC_CARD_ATTRIBUTES,
        where: {
            [Op.not]: {
                [Op.or]: {
                    title: null,
                    coverImage: ""
                }
            },
            [Op.and]: [visibleComicsWhere(req.session.userData), keywordWhere(searchKeywords)]
        },
        order: [
            ['id', 'DESC'],
        ],
        offset,
        limit: PAGE_SIZE
    }).then((rows) => {
        res.send(rows);
    }).catch((err) => {
        console.error('Error fetching comics:', err.message);
        res.status(500).json({ error: "Unable to load comics" });
    })

}

const fetchReadingList = (req, res) => {
    if (!req.session.userData) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }
    const offset = parseOffset(req.params.offset);
    const searchKeywords = normalizeKeyword(req.query.keyword);
    lastPage_table.findAll({
        attributes: LAST_PAGE_ATTRIBUTES,
        include: {
            model: comic_table,
            attributes: COMIC_CARD_ATTRIBUTES,
            // comics made private by someone else drop out of the list
            where: {
                [Op.and]: [
                    searchKeywords ? keywordWhere(searchKeywords) : { title: { [Op.ne]: null } },
                    visibleComicsWhere(req.session.userData)
                ]
            }
        },
        where: {
            userId: req.session.userData.id,
            pageNumber: {
                [Op.gt]: 1
            }
        },
        // same ordering as the first page rendered by c_readinglist.js
        order: [['id', 'DESC']],
        offset,
        limit: PAGE_SIZE
    }).then((rows) => {
        res.send(rows);
    }).catch((err) => {
        console.error('Error fetching reading list:', err.message);
        res.status(500).json({ error: "Unable to load reading list" });
    })

}

module.exports = {
    updateLastPage,
    fetchComic,
    fetchReadingList
}
