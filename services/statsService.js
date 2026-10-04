const { Prisma } = require('@prisma/client');
const prisma = require('../prisma/client');
const { toNumber } = require('../utils/decimal');
const { monthRange, addMonths, monthName, monthLabel, monthShortLabel } = require('../utils/dates');

/** Sum of quantity/amount and number of sales for a date range and optional shop. */
async function totalsForRange({ from, to, shopId }) {
  const where = {};
  if (from || to) {
    where.saleDate = {};
    if (from) where.saleDate.gte = new Date(`${from}T00:00:00.000Z`);
    if (to) where.saleDate.lte = new Date(`${to}T00:00:00.000Z`);
  }
  if (shopId) where.shopId = shopId;
  const agg = await prisma.sale.aggregate({ where, _sum: { quantity: true, amount: true }, _count: { _all: true } });
  return {
    quantity: toNumber(agg._sum.quantity),
    revenue: toNumber(agg._sum.amount),
    salesCount: agg._count._all,
  };
}

/** Shops ranked by revenue (descending) for an optional date range. */
async function rankShops({ from, to } = {}) {
  const conds = [Prisma.sql`1 = 1`];
  if (from) conds.push(Prisma.sql`x."saleDate" >= ${from}::date`);
  if (to) conds.push(Prisma.sql`x."saleDate" <= ${to}::date`);
  const rows = await prisma.$queryRaw`
    SELECT s.id, s.name,
           SUM(x.quantity)::text AS quantity,
           SUM(x.amount)::text   AS revenue,
           COUNT(x.id)::int      AS "salesCount"
    FROM shops s
    JOIN sales x ON x."shopId" = s.id
    WHERE ${Prisma.join(conds, ' AND ')}
    GROUP BY s.id, s.name
    ORDER BY SUM(x.amount) DESC, s.name ASC`;
  return rows.map((r, i) => ({
    rank: i + 1,
    shopId: r.id,
    shopName: r.name,
    quantity: toNumber(r.quantity),
    revenue: toNumber(r.revenue),
    salesCount: Number(r.salesCount),
  }));
}

/** Per-month totals (from/to are YYYY-MM-DD, shopId optional). Only months that have sales. */
async function monthlyTotals({ from, to, shopId } = {}) {
  const conds = [Prisma.sql`1 = 1`];
  if (from) conds.push(Prisma.sql`"saleDate" >= ${from}::date`);
  if (to) conds.push(Prisma.sql`"saleDate" <= ${to}::date`);
  if (shopId) conds.push(Prisma.sql`"shopId" = ${shopId}`);
  const rows = await prisma.$queryRaw`
    SELECT to_char("saleDate", 'YYYY-MM') AS key,
           SUM(amount)::text   AS revenue,
           SUM(quantity)::text AS quantity,
           COUNT(*)::int       AS "salesCount"
    FROM sales
    WHERE ${Prisma.join(conds, ' AND ')}
    GROUP BY 1
    ORDER BY 1`;
  return rows.map((r) => ({
    key: r.key,
    revenue: toNumber(r.revenue),
    quantity: toNumber(r.quantity),
    salesCount: Number(r.salesCount),
  }));
}

/** Returns exactly `count` consecutive months ending at endKey, with zero for months without sales. */
function fillMonths(rows, endKey, count) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const key = addMonths(endKey, -i);
    const row = byKey.get(key);
    out.push({
      monthKey: key,
      month: monthName(key),
      label: monthShortLabel(key),
      revenue: row ? row.revenue : 0,
      quantity: row ? row.quantity : 0,
      salesCount: row ? row.salesCount : 0,
    });
  }
  return out;
}

module.exports = { totalsForRange, rankShops, monthlyTotals, fillMonths, monthRange, monthLabel };
