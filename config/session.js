const session = require('express-session');
const SequelizeStore = require('connect-session-sequelize')(session.Store);
const db = require('./database');

const sessionStore = new SequelizeStore({
    db: db,
    tableName: 'sessions',
    expiration: 7 * 86400000,
    checkExpirationInterval: 15 * 60 * 1000
});

const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || "ComicRoom_lambda",
    store: sessionStore,
    saveUninitialized: false,
    resave: false,
    cookie: { maxAge: 7 * 86400000 }
});

// Loads the session for a request that skipped the global session middleware
// (covers, page files). Resolves with the signed-in user or null.
const loadSessionUser = (req, res) => new Promise((resolve) => {
    if (req.session) {
        resolve(req.session.userData || null);
        return;
    }
    sessionMiddleware(req, res, () => resolve(req.session && req.session.userData || null));
});

module.exports = { sessionStore, sessionMiddleware, loadSessionUser };
