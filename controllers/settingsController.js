const prisma = require('../prisma/client');
const { asyncHandler, badRequest, notFound } = require('../utils/errors');

const {
  parseUnits,
  unitsToString,
  unitsToNumber,
  toNumber,
} = require('../utils/decimal');

const { loadRules } = require('../services/pricingService');

const DENOMINATIONS = [
  { value: 1, label: '1 KG' },
  { value: 0.75, label: '3/4 KG' },
  { value: 0.5, label: '1/2 KG' },
];

const DENOMINATION_UNITS = {
  1: 100,
  0.75: 75,
  0.5: 50,
};

function assertValidDenominationRows(rows, label) {
  const allowed = new Set(DENOMINATIONS.map((d) => d.value));
  const seen = new Set();

  for (const row of rows) {
    const quantity = Number(row && row.quantity);

    if (!allowed.has(quantity)) {
      throw badRequest(
        `Invalid ${label} denomination. Use 1 KG, 3/4 KG or 1/2 KG.`
      );
    }
    if (seen.has(quantity)) {
      throw badRequest(`Duplicate ${label} denomination.`);
    }
    seen.add(quantity);
  }
}

/* =========================================================
   PRODUCT PRICING (general)
========================================================= */

function serializeRules(rules) {
  return DENOMINATIONS.map((d) => {
    const units = DENOMINATION_UNITS[d.value];
    const rule = rules.find((r) => r.qtyUnits === units);

    return {
      id: rule ? rule.id : null,
      quantity: d.value,
      price: rule ? unitsToNumber(rule.priceUnits) : 0,
    };
  });
}

exports.getPricing = asyncHandler(async (req, res) => {
  const rules = await loadRules();
  res.json({ rules: serializeRules(rules) });
});

exports.updatePricing = asyncHandler(async (req, res) => {
  const incoming = req.body && req.body.rules;

  if (!Array.isArray(incoming)) {
    throw badRequest('Pricing rules are required.');
  }

  assertValidDenominationRows(incoming, 'pricing');

  const data = DENOMINATIONS.map((d) => {
    const item = incoming.find((r) => Number(r && r.quantity) === d.value);

    if (!item) throw badRequest(`${d.label} price is required.`);

    const price = parseUnits(item.price);

    if (price.error === 'negative') {
      throw badRequest(`${d.label} price cannot be negative.`);
    }
    if (price.error) {
      throw badRequest(`${d.label} price is invalid.`);
    }

    return {
      quantity: unitsToString(DENOMINATION_UNITS[d.value]),
      price: unitsToString(price.units),
    };
  });

  await prisma.$transaction(async (tx) => {
    // removes old invalid rules (e.g. a stray 500 KG); sales are untouched
    await tx.pricingRule.deleteMany({});
    await tx.pricingRule.createMany({ data });
  });

  const rules = await loadRules();
  res.json({ rules: serializeRules(rules) });
});

/* =========================================================
   DELIVERY PARTNERS
========================================================= */

function parsePartnerId(raw) {
  const id = Number(raw);

  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest('Invalid delivery partner ID.');
  }
  return id;
}

function parsePartnerName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';

  if (!name) throw badRequest('Delivery partner name is required.');
  if (name.length > 100) {
    throw badRequest('Delivery partner name is too long.');
  }
  return name;
}

/**
 * Each row: { quantity, price (delivery charge), productPrice? (selling rate) }
 * productPrice empty / null  => partner uses the general product price.
 */
function parsePartnerPrices(rawPrices) {
  if (!Array.isArray(rawPrices)) {
    throw badRequest('Delivery partner prices are required.');
  }

  assertValidDenominationRows(rawPrices, 'delivery price');

  return DENOMINATIONS.map((d) => {
    const item = rawPrices.find((p) => Number(p && p.quantity) === d.value);

    if (!item) throw badRequest(`${d.label} delivery price is required.`);

    const price = parseUnits(item.price);

    if (price.error === 'negative') {
      throw badRequest(`${d.label} delivery price cannot be negative.`);
    }
    if (price.error) {
      throw badRequest(`${d.label} delivery price is invalid.`);
    }

    let productPrice = null;
    const rawProduct = item.productPrice;

    if (
      rawProduct !== undefined &&
      rawProduct !== null &&
      String(rawProduct).trim() !== ''
    ) {
      const pp = parseUnits(rawProduct);

      if (pp.error === 'negative') {
        throw badRequest(`${d.label} product price cannot be negative.`);
      }
      if (pp.error) {
        throw badRequest(`${d.label} product price is invalid.`);
      }
      productPrice = unitsToString(pp.units);
    }

    return {
      quantity: unitsToString(DENOMINATION_UNITS[d.value]),
      price: unitsToString(price.units),
      productPrice,
    };
  });
}

function serializePartner(partner) {
  return {
    id: partner.id,
    name: partner.name,

    prices: DENOMINATIONS.map((d) => {
      const row = partner.prices.find((p) => toNumber(p.quantity) === d.value);

      return {
        id: row ? row.id : null,
        quantity: d.value,
        price: row ? toNumber(row.price) : 0,
        productPrice:
          row && row.productPrice !== null && row.productPrice !== undefined
            ? toNumber(row.productPrice)
            : null,
      };
    }),
  };
}

exports.getDeliveryPartners = asyncHandler(async (req, res) => {
  const partners = await prisma.deliveryPartner.findMany({
    include: { prices: true },
    orderBy: { id: 'asc' },
  });

  res.json({ partners: partners.map(serializePartner) });
});

exports.createDeliveryPartner = asyncHandler(async (req, res) => {
  const name = parsePartnerName(req.body && req.body.name);
  const prices = parsePartnerPrices(req.body && req.body.prices);

  const existing = await prisma.deliveryPartner.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
  });

  if (existing) {
    throw badRequest('A delivery partner with this name already exists.');
  }

  const partner = await prisma.deliveryPartner.create({
    data: { name, prices: { create: prices } },
    include: { prices: true },
  });

  res.status(201).json({ partner: serializePartner(partner) });
});

exports.updateDeliveryPartner = asyncHandler(async (req, res) => {
  const id = parsePartnerId(req.params.id);

  const existing = await prisma.deliveryPartner.findUnique({ where: { id } });
  if (!existing) throw notFound('Delivery partner not found.');

  const name = parsePartnerName(req.body && req.body.name);
  const prices = parsePartnerPrices(req.body && req.body.prices);

  const duplicate = await prisma.deliveryPartner.findFirst({
    where: {
      name: { equals: name, mode: 'insensitive' },
      NOT: { id },
    },
  });

  if (duplicate) {
    throw badRequest('A delivery partner with this name already exists.');
  }

  const partner = await prisma.$transaction(async (tx) => {
    await tx.deliveryPartnerPrice.deleteMany({ where: { partnerId: id } });

    return tx.deliveryPartner.update({
      where: { id },
      data: { name, prices: { create: prices } },
      include: { prices: true },
    });
  });

  res.json({ partner: serializePartner(partner) });
});

exports.deleteDeliveryPartner = asyncHandler(async (req, res) => {
  const id = parsePartnerId(req.params.id);

  const partner = await prisma.deliveryPartner.findUnique({
    where: { id },
    include: { _count: { select: { sales: true } } },
  });

  if (!partner) throw notFound('Delivery partner not found.');

  if (partner._count.sales > 0) {
    throw badRequest(
      'This delivery partner is already used in sales and cannot be deleted.'
    );
  }

  await prisma.deliveryPartner.delete({ where: { id } });

  res.json({ success: true });
});