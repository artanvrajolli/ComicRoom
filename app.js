const express = require('express')
const session = require('express-session')
const fileUpload = require('express-fileupload')
const app = express();
const db = require('./config/database');


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

// set view engine to use .ejs files
app.set('view engine','ejs');

app.use(express.urlencoded({ extended: true}))
app.use(express.json())

// public folder
app.use("/public",express.static(__dirname+"/public"));


// routers
// login router
app.use("/login",require("./routers/r_login"));
app.use("/comic",require("./routers/r_comic"));
app.use("/register",require("./routers/r_register"));


// begin test zone

// end Testing Zone


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


