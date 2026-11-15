const router = require('express').Router();
const { requireAdmin, getAdminPage, postAdminSettings, postAdminTest } = require('../controller/c_admin');

router.use(requireAdmin);
router.get('/', getAdminPage);
router.post('/', postAdminSettings);
router.post('/test', postAdminTest);

module.exports = router;
