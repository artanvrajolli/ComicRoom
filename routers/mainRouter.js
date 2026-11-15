const router = require('express').Router();

router.use("/admin",require("./r_admin"));
router.use("/login",require("./r_login"));
router.use(["/comic","/"],require("./r_comic"));
router.use("/register",require("./r_register"));
router.use("/ajax",require("./r_ajax"));
router.use('/onread',require('./r_readinglist'))
// Destroy current Session for the user (GET kept for old links; POST for forms)
const SESSION_COOKIE_NAME = 'connect.sid'; // express-session default (app.js sets no name)
const logout = (req,res)=>{
    const done = ()=>{
        res.clearCookie(SESSION_COOKIE_NAME, { path: '/', httpOnly: true });
        res.redirect(req.method === 'POST' ? 303 : 302, "/comic");
    };
    if(!req.session){
        done();
        return;
    }
    req.session.destroy((err)=>{
        if(err){
            console.error('Logout failed to destroy session:', err.message);
        }
        done();
    });
};
router.get("/logout",logout);
router.post("/logout",logout);

module.exports = router;