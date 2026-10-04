const prisma = require('../prisma/client');
const { asyncHandler, badRequest, notFound } = require('../utils/errors');
const {
  isValidDateStr, isValidMonthKey, currentMonthKey, monthRange, monthLabel, fromDbDate, toDbDate,
} = require('../utils/dates');
const { totalsForRange, rankShops } = require('../services/statsService');
const { buildSalesWorkbook } = require('../services/excelService');
const { parseId } = require('./shopController');

exports.months = asyncHandler(async (req, res) => {
  const rows = await prisma.$queryRaw`
    SELECT DISTINCT to_char("saleDate", 'YYYY-MM') AS key FROM sales ORDER BY 1 DESC`;
  const keys = new Set(rows.map((r) => r.key));
  keys.add(currentMonthKey());
  res.json([...keys].sort().reverse().map((key) => ({ key, label: monthLabel(key) })));
});

exports.monthly = asyncHandler(async (req, res) => {
  const month = req.query.month === undefined ? currentMonthKey() : req.query.month;
  if (!isValidMonthKey(month)) throw badRequest('Invalid month. Use YYYY-MM.');
  const { from, to } = monthRange(month);

  const [totals, ranking, totalShops, daysRows] = await Promise.all([
    totalsForRange({ from, to }),
    rankShops({ from, to }),
    prisma.shop.count(),
    prisma.$queryRaw`
      SELECT COUNT(DISTINCT "saleDate")::int AS days
      FROM sales WHERE "saleDate" >= ${from}::date AND "saleDate" <= ${to}::date`,
  ]);
  const daysWithSales = Number(daysRows[0].days);
  // Average over days that actually have sales, so a partly finished month is not understated.
  const averageDailyRevenue = daysWithSales ? Math.round((totals.revenue * 100) / daysWithSales) / 100 : 0;

  res.json({
    month,
    label: monthLabel(month),
    totalQuantity: totals.quantity,
    totalRevenue: totals.revenue,
    salesCount: totals.salesCount,
    totalShops,
    activeShops: ranking.length,
    daysWithSales,
    averageDailyRevenue,
    shops: ranking,
  });
});

exports.exportExcel = asyncHandler(async (req, res) => {
  const { fromDate, toDate, shopId } = req.query;
  if (!isValidDateStr(fromDate) || !isValidDateStr(toDate)) throw badRequest('Invalid date.');
  if (fromDate > toDate) throw badRequest('From date must be on or before To date.');

  const where = { saleDate: { gte: toDbDate(fromDate), lte: toDbDate(toDate) } };
  if (shopId !== undefined && shopId !== '' && shopId !== 'all') {
    const id = parseId(shopId);
    const shop = await prisma.shop.findUnique({ where: { id }, select: { id: true } });
    if (!shop) throw notFound('Shop not found.');
    where.shopId = id;
  }

  const sales = await prisma.sale.findMany({
    where,
    include: {
      shop: { select: { name: true } },
      deliveryPartner: { select: { name: true } },
    },
    orderBy: [{ saleDate: 'asc' }, { id: 'asc' }],
  });
  const buffer = buildSalesWorkbook(
    sales.map((s) => ({
      saleDate: fromDbDate(s.saleDate),
      shopName: s.shop.name,
      quantity: s.quantity,
      amount: s.amount,
      deliveryPartnerName: s.deliveryPartner ? s.deliveryPartner.name : '',
      deliveryCharge: s.deliveryCharge,
    }))
  );

  const filename = `sales-report-${fromDate}-to-${toDate}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});
