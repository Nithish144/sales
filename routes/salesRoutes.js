const router = require('express').Router();

const c = require('../controllers/salesController');

router.get(
  '/',
  c.listAll
);

router.get(
  '/date/:date',
  c.listByDate
);

router.get(
  '/shop/:shopId',
  c.listByShop
);

router.post(
  '/',
  c.create
);

router.put(
  '/:id',
  c.update
);

router.delete(
  '/:id',
  c.remove
);

module.exports = router;