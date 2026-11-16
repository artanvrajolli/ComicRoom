// Private comics: only the uploader can see and read them. Admins included.
const Op = require('sequelize').Op;
const comic_table = require('../model/m_comic');

// WHERE fragment for comics the user may see. Use it inside [Op.and], because
// keywordWhere() also uses a top-level [Op.or].
const visibleComicsWhere = (user) => {
    const conditions = [{ isPrivate: { [Op.not]: true } }]; // NULL counts as public
    if (user && Number.isInteger(user.id)) {
        conditions.push({ uid: user.id });
    }
    return { [Op.or]: conditions };
};

const canReadComic = (user, comic) => {
    if (!comic) return false;
    if (!comic.isPrivate) return true;
    return !!user && comic.uid === user.id;
};

// Top folders (comic_<digits>) of private comics -> owner id, so page files
// under /public/uploads can be checked without a query per request.
let privateFolders = new Map();

const topFolderOf = (savedFolder) => {
    const match = /^(comic_[0-9]+)(?:\/|$)/.exec(String(savedFolder || ''));
    return match ? match[1] : '';
};

const refreshPrivateFolders = async () => {
    const rows = await comic_table.findAll({
        attributes: ['savedFolder', 'uid'],
        where: { isPrivate: true }
    });
    const next = new Map();
    rows.forEach((row) => {
        const top = topFolderOf(row.savedFolder);
        if (top) next.set(top, row.uid);
    });
    privateFolders = next;
    return next.size;
};

// Owner id when the folder belongs to a private comic, otherwise undefined.
const privateFolderOwner = (topFolder) => privateFolders.get(topFolder);

module.exports = {
    canReadComic,
    privateFolderOwner,
    refreshPrivateFolders,
    topFolderOf,
    visibleComicsWhere
};
