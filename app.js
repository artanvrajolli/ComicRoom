const express = require('express')
const session = require('express-session')
const fileUpload = require('express-fileupload')
const compression = require('compression')
const app = express();
const db = require('./config/database');
const mainRouter = require('./routers/mainRouter')
const fs = require('fs');
const path = require('path');
const jobProcessor = require('./utils/jobProcessor');
const { isAdmin } = require('./utils/admin');
const SequelizeStore = require('connect-session-sequelize')(session.Store);
const dbIndexes = require('./utils/dbIndexes');
const thumbnails = require('./utils/thumbnails');
const comic_table = require('./model/m_comic');
const { serveComicCover, servePageThumbnail } = require('./controller/c_comic');

const PORT = process.env.PORT || 8082;
const DAY_MS = 24 * 60 * 60 * 1000;

app.disable('x-powered-by');
// cloudflared connects from localhost; only trust X-Forwarded-* from loopback.
// Cookies are not marked secure, so plain http on localhost keeps working.
app.set('trust proxy', 'loopback');

app.use(compression());

// ---- Static assets and covers: served before session/body/upload middleware so
// they never hit the MySQL session store. ----

// service worker
app.get('/sw.js', (req, res) => {
    res.type('application/javascript');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// cover thumbnails (same handler is also registered in routers/r_comic.js)
app.get(['/comic/cover/:id', '/cover/:id'], serveComicCover);
// page thumbnails (?file=<page relativePath>; also registered in routers/r_comic.js)
app.get(['/comic/page-thumb/:id', '/page-thumb/:id'], servePageThumbnail);

// upload temp files are never public
app.use('/public/tmp', (req, res) => res.status(404).end());

// comic pages: names only change through page add/delete/move (which renames files),
// so a moderate max-age plus ETag/Last-Modified revalidation is safe.
app.use('/public/uploads', express.static(path.join(__dirname, 'public', 'uploads'), {
    maxAge: DAY_MS,
    index: false,
    redirect: false,
    fallthrough: false // a miss is a plain 404, no second stat on the slow mount
}));

// css/script/icons/images/fonts: 7 days (frontend busts its own scripts with ?v=)
app.use('/public', express.static(path.join(__dirname, 'public'), {
    maxAge: 7 * DAY_MS,
    index: false,
    setHeaders: (res, filePath) => {
        if (/(?:\.html|\.webmanifest|[\\/]sw\.js)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));

const sessionStore = new SequelizeStore({
    db: db,
    tableName: 'sessions',
    expiration: 7 * 86400000,
    checkExpirationInterval: 15 * 60 * 1000
});

// session handler
app.use(session({
    secret: process.env.SESSION_SECRET || "ComicRoom_lambda",
    store: sessionStore,
    saveUninitialized: false,
    resave: false,
    cookie: { maxAge: 7 * 86400000 }
}))

app.use((req, res, next) => {
    res.locals.isAdminUser = isAdmin(req.session.userData);
    next();
})

// file upload handler
app.use(fileUpload({
    createParentPath: true,
    useTempFiles: true,
    tempFileDir: __dirname + '/public/tmp/',
    limits: { 
        fileSize: 2 * 1024 * 1024 * 1024 // 2GB limit
    },
    abortOnLimit: false,
    responseOnLimit: "File size limit has been reached",
    uploadTimeout: 10 * 60 * 1000, // 10 minutes timeout
    preserveExtension: true
}));

// set view engine to use .ejs files
app.set('view engine', 'ejs');

// body parser
app.use(express.urlencoded({ 
    extended: true,
    limit: '2gb',
    parameterLimit: 50000
}))
app.use(express.json({
    limit: '2gb'
}))

// Increase server timeout for large uploads
app.use((req, res, next) => {
    // Set longer timeout for upload endpoints
    if (req.url.includes('/upload') || req.url.includes('/share-target')) {
        req.setTimeout(15 * 60 * 1000); // 15 minutes
        res.setTimeout(15 * 60 * 1000); // 15 minutes
    }
    next();
});

// routers for all routers 
app.use('/', mainRouter)

// 404 error handler
app.use((req, res) => {
    res.status(404);
    var msg = req.session.msg;
    req.session.msg = "";
    res.render("v_404", {
        msg,
        userData: req.session.userData
    });
})

let server = null;

const startServer = async () => {
    try {
        await db.authenticate();
        console.log("Database [Online]");
        await db.sync();
        await sessionStore.sync();
        await dbIndexes.ensureIndexes();
        jobProcessor.start();
        server = app.listen(PORT, () => {
            console.log(`Server [Online] on port ${PORT}`);
            scheduleThumbnailPrewarm();
        });
        server.timeout = 15 * 60 * 1000;
        server.keepAliveTimeout = 16 * 60 * 1000;
        server.headersTimeout = 17 * 60 * 1000;
    } catch (err) {
        console.error(err, "Startup failed");
        process.exit(1);
    }
};

// Generate missing cover thumbnails in the background, one at a time.
const scheduleThumbnailPrewarm = () => {
    setTimeout(async () => {
        try {
            const comics = await comic_table.findAll({
                attributes: ['id', 'savedFolder', 'coverImage'],
                where: { coverImage: { [require('sequelize').Op.ne]: null } },
                order: [['id', 'DESC']]
            });
            const generated = await thumbnails.prewarmAll(comics);
            if (generated > 0) {
                console.log(`Cover thumbnails generated: ${generated}`);
            }
        } catch (err) {
            console.error('Cover thumbnail prewarm failed:', err.message);
        }
    }, 15 * 1000).unref();
};

startServer();

// clean tmp folder everytime on starup server
fs.readdir("public/tmp", (err, files) => {
    if (err) {
        files = [];
    }

    for (const file of files) {
        const filePath = process.cwd() + "/public/tmp/" + file;
        
        // Check if it's a directory (chunks folder)
        try {
            if (fs.lstatSync(filePath).isDirectory() && file === 'chunks') {
                // Clean up old chunk directories
                const chunkDirs = fs.readdirSync(filePath);
                for (const chunkDir of chunkDirs) {
                    const chunkDirPath = filePath + "/" + chunkDir;
                    try {
                        const chunkFiles = fs.readdirSync(chunkDirPath);
                        for (const chunkFile of chunkFiles) {
                            fs.unlinkSync(chunkDirPath + "/" + chunkFile);
                        }
                        fs.rmdirSync(chunkDirPath);
                    } catch (chunkErr) {
                        console.log('Error cleaning chunk directory:', chunkErr.message);
                    }
                }
            } else if (!fs.lstatSync(filePath).isDirectory()) {
                // Regular file cleanup
                fs.unlink(filePath, err => {
                    if (err) throw err;
                });
            }
        } catch (statErr) {
            // If stat fails, try to unlink as regular file
            fs.unlink(filePath, err => {
                if (err && err.code !== 'ENOENT') console.log('Error cleaning file:', err.message);
            });
        }
    }
    
    // Ensure chunks directory exists
    if (!fs.existsSync("public/tmp/chunks")) {
        fs.mkdirSync("public/tmp/chunks", { recursive: true });
    }
    
    fs.mkdir("public/uploads", (err) => { }); // create file uploads to allow upload comics
    console.log("TMP folder is clean")
});

const shutdown = () => {
    console.log('Shutting down gracefully...');
    jobProcessor.stop();
    require('./utils/thumbnails').stopWorker();
    if (sessionStore && typeof sessionStore.stopExpiringSessions === 'function') {
        sessionStore.stopExpiringSessions();
    }
    if (!server) {
        process.exit(0);
        return;
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

