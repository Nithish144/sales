const prisma = require('../prisma/client');
const { asyncHandler, badRequest, notFound } = require('../utils/errors');
const { todayStr, currentMonthKey, addMonths, isValidMonthKey, monthRange, monthLabel } = require('../utils/dates');
const { totalsForRange, rankShops, monthlyTotals, fillMonths } = require('../services/statsService');
const { parseId } = require('./shopController');

function monthParam(raw) {
  if (raw === undefined) return null;
  if (!isValidMonthKey(raw)) throw badRequest('Invalid month. Use YYYY-MM.');
  return raw;
}

exports.today = asyncHandler(async (req, res) => {
  const date = todayStr();
  const monthKey = date.slice(0, 7);
  const { from, to } = monthRange(monthKey);
  const [today, month, totalShops, ranking] = await Promise.all([
    totalsForRange({ from: date, to: date }),
    totalsForRange({ from, to }),
    prisma.shop.count(),
    rankShops({ from, to }),
  ]);
  res.json({
    date,
    month: monthKey,
    monthLabel: monthLabel(monthKey),
    todayRevenue: today.revenue,
    todayQuantity: today.quantity,
    monthRevenue: month.revenue,
    monthQuantity: month.quantity,
    totalShops,
    topShop: ranking.length ? ranking[0] : null,
  });
});

exports.monthlyRevenue = asyncHandler(async (req, res) => {
  let months = 12;
  if (req.query.months !== undefined) {
    months = Number(req.query.months);
    if (!Number.isInteger(months) || months < 1 || months > 36) throw badRequest('months must be between 1 and 36.');
  }
  const end = currentMonthKey();
  const start = addMonths(end, -(months - 1));
  const rows = await monthlyTotals({ from: monthRange(start).from, to: monthRange(end).to });
  res.json(fillMonths(rows, end, months));
});

exports.monthComparison = asyncHandler(async (req, res) => {
  const currentKey = monthParam(req.query.month) || currentMonthKey();
  const previousKey = addMonths(currentKey, -1);
  const [cur, prev] = await Promise.all([
    totalsForRange(monthRange(currentKey)),
    totalsForRange(monthRange(previousKey)),
  ]);
  const differenceUnits = Math.round(cur.revenue * 100) - Math.round(prev.revenue * 100);
  const difference = differenceUnits / 100;
  // Previous month = 0 -> percentage is undefined; return null instead of dividing by zero.
  const percentage = prev.revenue > 0 ? Math.round((differenceUnits / (prev.revenue * 100)) * 10000) / 100 : null;
  res.json({
    currentMonth: { key: currentKey, label: monthLabel(currentKey), revenue: cur.revenue, quantity: cur.quantity },
    previousMonth: { key: previousKey, label: monthLabel(previousKey), revenue: prev.revenue, quantity: prev.quantity },
    difference,
    percentage,
    direction: difference > 0 ? 'up' : difference < 0 ? 'down' : 'flat',
  });
});

exports.topShops = asyncHandler(async (req, res) => {
  const month = monthParam(req.query.month);
  const range = month ? monthRange(month) : {};
  const shops = await rankShops({ from: range.from, to: range.to });
  res.json({ month, label: month ? monthLabel(month) : 'All time', shops, topShop: shops[0] || null });
});

exports.shopPerformance = asyncHandler(async (req, res) => {
  const shopId = parseId(req.params.shopId);
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw notFound('Shop not found.');

  const [totals, allMonths] = await Promise.all([totalsForRange({ shopId }), monthlyTotals({ shopId })]);

  let bestMonth = null;
  for (const m of allMonths) {
    if (!bestMonth || m.revenue > bestMonth.revenue) bestMonth = m;
  }
  const averageMonthlyRevenue = allMonths.length
    ? Math.round((allMonths.reduce((s, m) => s + Math.round(m.revenue * 100), 0) / allMonths.length)) / 100
    : 0;

  res.json({
    shop: { id: shop.id, name: shop.name },
    totalQuantity: totals.quantity,
    totalRevenue: totals.revenue,
    salesCount: totals.salesCount,
    monthsWithSales: allMonths.length,
    averageMonthlyRevenue,
    bestMonth: bestMonth ? { key: bestMonth.key, label: monthLabel(bestMonth.key), revenue: bestMonth.revenue } : null,
    monthlyTrend: fillMonths(allMonths, currentMonthKey(), 12),
  });
});
