const express = require('express')
const session = require('express-session')
const fileUpload = require('express-fileupload')
const app = express();
const db = require('./config/database');
const mainRouter = require('./routers/mainRouter')
const fs = require('fs');

// session handler
app.use(session({
    secret:"ComicRoom_lambda",
    saveUninitialized:false,
    resave:false,
    cookie: { maxAge: 7*86400000 }
    }))

// file upload handler
app.use(fileUpload({
    createParentPath: true,
    useTempFiles : true,
    tempFileDir : __dirname+'/public/tmp/'
}));
//
// set view engine to use .ejs files
app.set('view engine','ejs');

app.use(express.urlencoded({ extended: true}))
app.use(express.json())

// public folder
app.use("/public",express.static(__dirname+"/public"));


// routers for all routers 
app.use('/',mainRouter)





app.use((req,res)=>{
    // placeHolder for 404 error
    res.status(404);
    res.send("404 error");
})

// check if db is ready / authenticate
db.authenticate().then(()=>{
    console.log("Database [Online]")
}).catch((err)=>{
    console.log(err,"Database [Fail to Connect]")
})
// sync with database
db.sync();
//db.sync({ force: true })
// listen server port 8082
app.listen(8082,console.log("Server [Online]"))


// clean tmp folder everytime on starup server
fs.readdir("public/tmp", (err, files) => {
    if (err) throw err;
  
    for (const file of files) {
      fs.unlink(process.cwd()+"/public/tmp/"+file, err => {
        if (err) throw err;
      });
    }
  });

