const router = require('express').Router();
const c = require('../controllers/reportController');

router.get('/months', c.months);
router.get('/monthly', c.monthly);
router.get('/export', c.exportExcel);

module.exports = router;
