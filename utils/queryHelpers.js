const Op = require('sequelize').Op;

// Escape LIKE wildcards so user input is matched literally (MySQL default escape char is "\").
function escapeLike(value) {
    return String(value || '').replace(/[\\%_]/g, '\\$&');
}

// Parse a pagination offset; anything invalid becomes 0.
function parseOffset(value, max = 100000) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return 0;
    }
    return Math.min(parsed, max);
}

function normalizeKeyword(value) {
    return String(typeof value === 'string' ? value : '').trim().slice(0, 200);
}

// WHERE fragment matching the keyword in title, description or author.
// Returns {} for an empty keyword so no LIKE scan is added at all.
function keywordWhere(keyword) {
    if (!keyword) {
        return {};
    }
    const pattern = `%${escapeLike(keyword)}%`;
    return {
        [Op.or]: {
            title: { [Op.like]: pattern },
            description: { [Op.like]: pattern },
            author: { [Op.like]: pattern }
        }
    };
}

module.exports = {
    escapeLike,
    keywordWhere,
    normalizeKeyword,
    parseOffset
};
