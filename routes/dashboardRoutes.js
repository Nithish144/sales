const router = require('express').Router();
const c = require('../controllers/dashboardController');

router.get('/today', c.today);
router.get('/monthly-revenue', c.monthlyRevenue);
router.get('/month-comparison', c.monthComparison);
router.get('/top-shops', c.topShops);
router.get('/shop-performance/:shopId', c.shopPerformance);

module.exports = router;
