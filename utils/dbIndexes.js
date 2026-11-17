const db = require('../config/database');

// Indexes that db.sync() (without alter) will not add to the existing tables,
// because the models do not declare them. Created idempotently at startup.
const LAST_PAGE_UNIQUE_INDEX = 'lastpages_user_comic_unique';
const LAST_PAGE_FALLBACK_INDEX = 'lastpages_user_comic';

const PLAIN_INDEXES = [
    { table: 'lastPages', name: 'lastpages_user_lastread', columns: ['userId', 'lastReadAt', 'id'] },
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

// db.sync() without alter never widens existing columns, so tables created by
// older versions can be narrower than the models (e.g. comics.coverImage was
// VARCHAR(100), which rejected long page paths with "Data too long").
// Widen any VARCHAR column that is shorter than its model (never narrows),
// and add nullable columns that the models gained since the table was made.
function syncedModels() {
    return [
        require('../model/m_comic'),
        require('../model/m_uploadJob'),
        require('../model/m_users'),
        require('../model/m_lastPage')
    ];
}

function modelStringLength(definition) {
    const type = definition && definition.type;
    if (!type || type.key !== 'STRING') return 0;
    return Number(type._length || (type.options && type.options.length) || 255);
}

async function ensureColumnWidths() {
    for (const model of syncedModels()) {
        const table = model.getTableName();
        let columns;
        try {
            [columns] = await db.query(
                'SELECT COLUMN_NAME AS name, DATA_TYPE AS type, CHARACTER_MAXIMUM_LENGTH AS len, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
                { replacements: [table] }
            );
        } catch (err) {
            console.error(`Could not read columns of ${table}:`, err.message);
            continue;
        }
        const byName = new Map(columns.map(column => [column.name, column]));
        // Add nullable columns that newer models declare (db.sync() never adds them).
        for (const [attribute, definition] of Object.entries(model.rawAttributes)) {
            const field = definition.field || attribute;
            if (byName.has(field) || definition.allowNull === false || definition.primaryKey) continue;
            try {
                await db.getQueryInterface().addColumn(table, field, { type: definition.type, allowNull: true });
                console.log(`Added column ${table}.${field}`);
                byName.set(field, { name: field, type: 'added' });
            } catch (err) {
                console.error(`Could not add column ${table}.${field}:`, err.message);
            }
        }
        for (const [attribute, definition] of Object.entries(model.rawAttributes)) {
            const wanted = modelStringLength(definition);
            const column = byName.get(definition.field || attribute);
            if (!wanted || !column || column.type !== 'varchar' || Number(column.len) >= wanted) continue;
            const nullability = column.nullable === 'YES' ? 'NULL' : 'NOT NULL';
            const defaultClause = column.def === null || column.def === undefined ? '' : ' DEFAULT ' + db.escape(column.def);
            try {
                await db.query(`ALTER TABLE \`${table}\` MODIFY \`${column.name}\` VARCHAR(${wanted}) ${nullability}${defaultClause}`);
                console.log(`Widened ${table}.${column.name} from VARCHAR(${column.len}) to VARCHAR(${wanted})`);
            } catch (err) {
                console.error(`Could not widen ${table}.${column.name}:`, err.message);
            }
        }
    }
}

// Never throws: a missing index only costs performance.
async function ensureIndexes() {
    await ensureColumnWidths();
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
    ensureColumnWidths,
    ensureIndexes,
    hasLastPageUniqueIndex
};
