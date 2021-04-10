const router = require('express').Router();







router.get("/",(req,res)=>{

    res.render("v_comicMuList",{comics});
})




module.exports = router;