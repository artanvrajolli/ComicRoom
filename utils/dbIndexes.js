const db = require('../config/database');

// Indexes that db.sync() (without alter) will not add to the existing tables,
// because the models do not declare them. Created idempotently at startup.
const LAST_PAGE_UNIQUE_INDEX = 'lastpages_user_comic_unique';
const LAST_PAGE_FALLBACK_INDEX = 'lastpages_user_comic';

const PLAIN_INDEXES = [
    { table: 'comics', name: 'comics_uid', columns: ['uid'] },
    { table: 'upload_jobs', name: 'upload_jobs_status_created', columns: ['status', 'createdAt'] },
    { table: 'upload_jobs', name: 'upload_jobs_user_status', columns: ['userId', 'status'] }
];

let lastPageUniqueIndex = false;

async function getIndexNames(table) {
    const [rows] = await db.query(
        'SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        { replacements: [table] }
    );
    return new Set(rows.map(row => row.name));
}

function quoteColumns(columns) {
    return columns.map(column => `\`${column}\``).join(', ');
}

async function ensureIndex(table, name, columns, unique = false) {
    const existing = await getIndexNames(table);
    if (existing.has(name)) {
        return false;
    }
    await db.query(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX \`${name}\` ON \`${table}\` (${quoteColumns(columns)})`);
    console.log(`Created index ${name} on ${table}`);
    return true;
}

async function ensureLastPageIndex() {
    const existing = await getIndexNames('lastPages');
    if (existing.has(LAST_PAGE_UNIQUE_INDEX)) {
        lastPageUniqueIndex = true;
        return;
    }

    // Rows with a NULL comicId/userId never conflict in a MySQL unique index,
    // so only real (userId, comicId) duplicates block it.
    const [duplicates] = await db.query(
        'SELECT userId, comicId, COUNT(*) AS total FROM lastPages WHERE userId IS NOT NULL AND comicId IS NOT NULL GROUP BY userId, comicId HAVING COUNT(*) > 1 LIMIT 5'
    );
    if (duplicates.length > 0) {
        console.warn(`lastPages has duplicate (userId, comicId) rows, using a non-unique index instead:`, duplicates);
        await ensureIndex('lastPages', LAST_PAGE_FALLBACK_INDEX, ['userId', 'comicId']);
        lastPageUniqueIndex = false;
        return;
    }

    await ensureIndex('lastPages', LAST_PAGE_UNIQUE_INDEX, ['userId', 'comicId'], true);
    lastPageUniqueIndex = true;
}

// Never throws: a missing index only costs performance.
async function ensureIndexes() {
    try {
        await ensureLastPageIndex();
    } catch (err) {
        lastPageUniqueIndex = false;
        console.error('Could not ensure lastPages index:', err.message);
    }
    for (const index of PLAIN_INDEXES) {
        try {
            await ensureIndex(index.table, index.name, index.columns);
        } catch (err) {
            console.error(`Could not ensure index ${index.name}:`, err.message);
        }
    }
}

function hasLastPageUniqueIndex() {
    return lastPageUniqueIndex;
}

module.exports = {
    ensureIndexes,
    hasLastPageUniqueIndex
};
