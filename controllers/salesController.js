const prisma = require('../prisma/client');

const {
  asyncHandler,
  badRequest,
  notFound,
  unprocessable,
} = require('../utils/errors');

const {
  parseUnits,
  unitsToString,
  toNumber,
  MAX_QUANTITY_UNITS,
  MAX_AMOUNT_UNITS,
} = require('../utils/decimal');

const { isValidDateStr, toDbDate, fromDbDate } = require('../utils/dates');

const {
  calculateAmountFromBreakdown,
  applyPartnerRates,
  loadRules,
} = require('../services/pricingService');

const { parseId: parseShopId } = require('./shopController');

const include = {
  shop: { select: { name: true } },
  deliveryPartner: { select: { name: true } },
};

const serialize = (s) => ({
  id: s.id,
  shopId: s.shopId,
  shopName: s.shop ? s.shop.name : undefined,
  saleDate: fromDbDate(s.saleDate),
  quantity: toNumber(s.quantity),
  amount: toNumber(s.amount),
  deliveryPartnerId: s.deliveryPartnerId,
  deliveryPartnerName: s.deliveryPartner ? s.deliveryPartner.name : undefined,
  deliveryCharge: toNumber(s.deliveryCharge),
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

function parseSaleId(raw) {
  if (
    !/^\d+$/.test(String(raw)) ||
    Number(raw) <= 0 ||
    Number(raw) > 2147483647
  ) {
    throw badRequest('Invalid sale ID.');
  }
  return Number(raw);
}

function requireDate(raw, message = 'Invalid date.') {
  if (!isValidDateStr(raw)) throw badRequest(message);
  return raw;
}

/* =========================================================
   QUANTITY BREAKDOWN
========================================================= */

function inferQuantityBreakdown(quantityUnits) {
  const denominations = [100, 75, 50];
  let remaining = quantityUnits;
  const result = [];

  for (const units of denominations) {
    const count = Math.floor(remaining / units);
    if (count > 0) {
      result.push({ quantityUnits: units, count });
      remaining -= count * units;
    }
  }

  if (remaining !== 0) {
    throw unprocessable(
      'This quantity cannot be made using 1 KG, 3/4 KG and 1/2 KG denominations.'
    );
  }

  return result;
}

function parseQuantityBreakdown(raw, quantityUnits) {
  if (raw === undefined || raw === null) {
    return inferQuantityBreakdown(quantityUnits);
  }

  if (!Array.isArray(raw) && typeof raw === 'object') {
    raw = Object.entries(raw).map(([quantity, count]) => ({ quantity, count }));
  }

  if (!Array.isArray(raw)) {
    throw badRequest('Quantity breakdown is required.');
  }

  const allowed = new Set([100, 75, 50]);
  const result = [];
  const seen = new Set();

  for (const item of raw) {
    const quantity = parseUnits(item && item.quantity);

    if (quantity.error || quantity.units <= 0 || !allowed.has(quantity.units)) {
      throw badRequest('Invalid quantity denomination.');
    }

    const count = Number(item && item.count);

    if (!Number.isInteger(count) || count < 0) {
      throw badRequest('Quantity count must be a non-negative integer.');
    }

    if (count === 0) continue;

    if (seen.has(quantity.units)) {
      throw badRequest('Duplicate quantity denomination.');
    }
    seen.add(quantity.units);

    result.push({ quantityUnits: quantity.units, count });
  }

  if (!result.length) {
    throw badRequest('At least one quantity denomination is required.');
  }

  return result;
}

/* =========================================================
   DELIVERY PARTNER + CHARGE
========================================================= */

async function loadPartner(raw) {
  if (raw === undefined || raw === null || raw === '') return null;

  const id = Number(raw);

  if (!Number.isInteger(id) || id <= 0) {
    throw badRequest('Invalid delivery partner.');
  }

  const partner = await prisma.deliveryPartner.findUnique({
    where: { id },
    include: { prices: true },
  });

  if (!partner) throw badRequest('Delivery partner not found.');

  return partner;
}

function calculateDeliveryChargeUnits(partner, breakdown) {
  if (!partner) return 0;

  let total = 0;

  for (const item of breakdown) {
    const row = partner.prices.find(
      (p) => parseUnits(p.quantity.toString()).units === item.quantityUnits
    );

    if (!row) {
      throw unprocessable(
        `No delivery price is configured for ${item.quantityUnits / 100} KG for ${partner.name}.`
      );
    }

    total += parseUnits(row.price.toString()).units * item.count;
  }

  return total;
}

/* =========================================================
   VALIDATE SALE
========================================================= */

async function validateSaleBody(body) {
  if (!body || typeof body !== 'object') {
    throw badRequest('Request body is required.');
  }

  /* Shop */
  if (body.shopId === undefined || body.shopId === null || body.shopId === '') {
    throw badRequest('Please select a shop.');
  }

  const shopId = parseShopId(body.shopId);

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { id: true },
  });

  if (!shop) throw badRequest('Shop not found.');

  /* Date */
  const saleDate = requireDate(body.saleDate);

  /* Quantity */
  const q = parseUnits(body.quantity);

  if (q.error === 'malformed') {
    throw badRequest('Quantity must be a number with up to 2 decimal places.');
  }
  if (q.error || q.units <= 0) {
    throw badRequest('Quantity must be greater than 0.');
  }
  if (q.units > MAX_QUANTITY_UNITS) {
    throw badRequest('Quantity is too large.');
  }

  /* Breakdown */
  const breakdown = parseQuantityBreakdown(
    body.quantityBreakdown ?? body.denominationCounts,
    q.units
  );

  const breakdownUnits = breakdown.reduce(
    (total, item) => total + item.quantityUnits * item.count,
    0
  );

  if (breakdownUnits !== q.units) {
    throw badRequest('Quantity breakdown does not match total quantity.');
  }

  /* Delivery partner (also decides which product rates apply) */
  const partner = await loadPartner(body.deliveryPartnerId);

  const deliveryChargeUnits = calculateDeliveryChargeUnits(partner, breakdown);

  /* Product amount */
  let amountUnits;

  const hasAmount =
    body.amount !== undefined && body.amount !== null && body.amount !== '';

  if (hasAmount) {
    const a = parseUnits(body.amount);

    if (a.error === 'negative') throw badRequest('Amount cannot be negative.');
    if (a.error) {
      throw badRequest(
        'Amount must be a valid number with up to 2 decimal places.'
      );
    }
    if (a.units > MAX_AMOUNT_UNITS) throw badRequest('Amount is too large.');

    amountUnits = a.units;
  } else {
    // partner selected -> partner product rates, otherwise general rates
    const rules = applyPartnerRates(
      await loadRules(),
      partner ? partner.prices : null
    );

    const calculated = calculateAmountFromBreakdown(breakdown, rules);

    if (calculated === null) {
      throw unprocessable(
        'No price is configured for this quantity. Add a matching pricing denomination in Settings, or enter the amount manually.'
      );
    }

    amountUnits = calculated;
  }

  return {
    shopId,
    saleDate,
    quantityUnits: q.units,
    amountUnits,
    deliveryPartnerId: partner ? partner.id : null,
    deliveryChargeUnits,
  };
}

function saleData(v) {
  return {
    shopId: v.shopId,
    saleDate: toDbDate(v.saleDate),
    quantity: unitsToString(v.quantityUnits),
    amount: unitsToString(v.amountUnits),
    deliveryPartnerId: v.deliveryPartnerId,
    deliveryCharge: unitsToString(v.deliveryChargeUnits),
  };
}

/* =========================================================
   LIST HELPERS
========================================================= */

function buildDateRange(fromDate, toDate) {
  if (fromDate !== undefined) requireDate(fromDate);
  if (toDate !== undefined) requireDate(toDate);

  if (fromDate && toDate && fromDate > toDate) {
    throw badRequest('From date must be on or before To date.');
  }

  if (!fromDate && !toDate) return null;

  const range = {};
  if (fromDate) range.gte = toDbDate(fromDate);
  if (toDate) range.lte = toDbDate(toDate);
  return range;
}

/* =========================================================
   LIST ALL
========================================================= */

exports.listAll = asyncHandler(async (req, res) => {
  const { fromDate, toDate, shopId } = req.query;
  const where = {};

  const range = buildDateRange(fromDate, toDate);
  if (range) where.saleDate = range;

  if (shopId !== undefined) where.shopId = parseShopId(shopId);

  const sales = await prisma.sale.findMany({
    where,
    include,
    orderBy: [{ saleDate: 'desc' }, { id: 'desc' }],
  });

  res.json(sales.map(serialize));
});

/* =========================================================
   BY DATE
========================================================= */

exports.listByDate = asyncHandler(async (req, res) => {
  const date = requireDate(req.params.date);
  const where = { saleDate: toDbDate(date) };

  const [sales, agg] = await Promise.all([
    prisma.sale.findMany({ where, include, orderBy: { id: 'asc' } }),
    prisma.sale.aggregate({
      where,
      _sum: { quantity: true, amount: true, deliveryCharge: true },
      _count: { _all: true },
    }),
  ]);

  res.json({
    date,
    sales: sales.map(serialize),
    totals: {
      quantity: toNumber(agg._sum.quantity),
      amount: toNumber(agg._sum.amount),
      deliveryCharge: toNumber(agg._sum.deliveryCharge),
      count: agg._count._all,
    },
  });
});

/* =========================================================
   BY SHOP
========================================================= */

exports.listByShop = asyncHandler(async (req, res) => {
  const shopId = parseShopId(req.params.shopId);
  const { fromDate, toDate } = req.query;

  const where = { shopId };

  const range = buildDateRange(fromDate, toDate);
  if (range) where.saleDate = range;

  const sales = await prisma.sale.findMany({
    where,
    include,
    orderBy: [{ saleDate: 'desc' }, { id: 'desc' }],
  });

  res.json(sales.map(serialize));
});

/* =========================================================
   CREATE
========================================================= */

exports.create = asyncHandler(async (req, res) => {
  const v = await validateSaleBody(req.body);

  const sale = await prisma.sale.create({ data: saleData(v), include });

  res.status(201).json(serialize(sale));
});

/* =========================================================
   UPDATE
========================================================= */

exports.update = asyncHandler(async (req, res) => {
  const id = parseSaleId(req.params.id);

  const existing = await prisma.sale.findUnique({
    where: { id },
    select: { id: true },
  });

  if (!existing) throw notFound('Sale not found.');

  const v = await validateSaleBody(req.body);

  const sale = await prisma.sale.update({
    where: { id },
    data: saleData(v),
    include,
  });

  res.json(serialize(sale));
});

/* =========================================================
   DELETE
========================================================= */

exports.remove = asyncHandler(async (req, res) => {
  const id = parseSaleId(req.params.id);

  const existing = await prisma.sale.findUnique({
    where: { id },
    select: { id: true },
  });

  if (!existing) throw notFound('Sale not found.');

  await prisma.sale.delete({ where: { id } });

  res.json({ success: true });
});