const router =
  require('express').Router();

const c =
  require('../controllers/settingsController');

router.get(
  '/pricing',
  c.getPricing
);

router.put(
  '/pricing',
  c.updatePricing
);

router.get(
  '/delivery-partners',
  c.getDeliveryPartners
);

router.post(
  '/delivery-partners',
  c.createDeliveryPartner
);

router.put(
  '/delivery-partners/:id',
  c.updateDeliveryPartner
);

router.delete(
  '/delivery-partners/:id',
  c.deleteDeliveryPartner
);

module.exports = router;