const express = require('express')
const session = require('express-session')
const fileUpload = require('express-fileupload')
const app = express();
const db = require('./config/database');
const mainRouter = require('./routers/mainRouter')
const fs = require('fs');
const jobProcessor = require('./utils/jobProcessor');

// session handler
app.use(session({
    secret: "ComicRoom_lambda",
    saveUninitialized: false,
    resave: false,
    cookie: { maxAge: 7 * 86400000 }
}))

// file upload handler
app.use(fileUpload({
    createParentPath: true,
    useTempFiles: true,
    tempFileDir: __dirname + '/public/tmp/',
    debug: true,
    limits: { 
        fileSize: 2 * 1024 * 1024 * 1024 // 2GB limit
    },
    abortOnLimit: false,
    responseOnLimit: "File size limit has been reached",
    uploadTimeout: 10 * 60 * 1000, // 10 minutes timeout
    preserveExtension: true
}));

// Debug middleware to log file uploads
app.use((req, res, next) => {
    if (req.method === 'POST' && req.url === '/comic/upload') {
        console.log('=== File Upload Debug Info ===');
        console.log('Request method:', req.method);
        console.log('Request URL:', req.url);
        console.log('Content-Type:', req.headers['content-type']);
        console.log('req.files exists:', !!req.files);
        if (req.files) {
            console.log('req.files keys:', Object.keys(req.files));
            console.log('req.files:', req.files);
        }
        console.log('==============================');
    }
    next();
});

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
    if (req.url.includes('/upload')) {
        req.setTimeout(15 * 60 * 1000); // 15 minutes
        res.setTimeout(15 * 60 * 1000); // 15 minutes
    }
    next();
});

// public folder
app.use("/public", express.static(__dirname + "/public"));

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

// check if db is ready / authenticate
db.authenticate().then(() => {
    console.log("Database [Online]")
}).catch((err) => {
    console.log(err, "Database [Fail to Connect]")
})
// sync with database
db.sync();

// Start the background job processor
jobProcessor.start();

// listen server port 8082
const server = app.listen(8082, () => {
    console.log("Server [Online]");
});

// Set server timeouts for large uploads
server.timeout = 15 * 60 * 1000; // 15 minutes
server.keepAliveTimeout = 16 * 60 * 1000; // 16 minutes
server.headersTimeout = 17 * 60 * 1000; // 17 minutes

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

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    jobProcessor.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Shutting down gracefully...');
    jobProcessor.stop();
    process.exit(0);
});

