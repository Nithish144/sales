/**
 * Integration tests: run the real Express app against the real database in DATABASE_URL.
 * WARNING: it creates and removes its own "ZZTEST" shops/sales, and temporarily changes pricing
 * (restored at the end). Use a development database.   Run:  npm test
 */
const assert = require('assert');
const XLSX = require('xlsx');
const app = require('../server');
const prisma = require('../prisma/client');
const { calculateAmountUnits } = require('../services/pricingService');
const { todayStr } = require('../utils/dates');

let passed = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); passed += 1; results.push(`  ok   ${name}`); }
  catch (e) { results.push(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

(async () => {
  const server = app.listen(0);
  const base = `http://localhost:${server.address().port}/api`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
  };

  const originalPricing = (await call('GET', '/settings/pricing')).body.rules.map(({ quantity, price }) => ({ quantity, price }));
  const createdShopIds = [];

  // ---- pure pricing --------------------------------------------------------
  const rules = [{ qtyUnits: 100, priceUnits: 3700 }, { qtyUnits: 75, priceUnits: 2800 }, { qtyUnits: 50, priceUnits: 1900 }];
  await t('pricing: examples from the brief', () => {
    const p = (kg) => calculateAmountUnits(Math.round(kg * 100), rules) / 100;
    assert.strictEqual(p(0.5), 19); assert.strictEqual(p(0.75), 28); assert.strictEqual(p(1), 37);
    assert.strictEqual(p(2), 74); assert.strictEqual(p(2.5), 93); assert.strictEqual(p(3), 111);
    assert.strictEqual(p(3.5), 130); assert.strictEqual(p(7), 259); assert.strictEqual(p(6), 222);
  });
  await t('pricing: 0.25 KG is not representable (no guessing)', () => {
    assert.strictEqual(calculateAmountUnits(25, rules), null);
    assert.strictEqual(calculateAmountUnits(110, rules), null);
  });
  await t('pricing: 6.25 KG with the 3 configured denominations', () => {
    assert.strictEqual(calculateAmountUnits(625, rules) / 100, 232);
  });
  await t('pricing: 6.25 KG = 231 once a 0.25 KG denomination (Rs 9) exists', () => {
    assert.strictEqual(calculateAmountUnits(625, [...rules, { qtyUnits: 25, priceUnits: 900 }]) / 100, 231);
  });

  // ---- shops ---------------------------------------------------------------
  let shopA;
  await t('shops: create', async () => {
    const r = await call('POST', '/shops', { name: '  zztest   alpha ' });
    assert.strictEqual(r.status, 201); assert.strictEqual(r.body.name, 'zztest alpha');
    shopA = r.body; createdShopIds.push(shopA.id);
  });
  await t('shops: duplicate (case-insensitive) rejected', async () => {
    const r = await call('POST', '/shops', { name: 'ZZTEST ALPHA' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'Shop already exists.');
  });
  await t('shops: empty name rejected', async () => {
    assert.strictEqual((await call('POST', '/shops', { name: '   ' })).status, 400);
    assert.strictEqual((await call('POST', '/shops', {})).status, 400);
  });
  let shopB;
  await t('shops: edit + duplicate-on-edit', async () => {
    shopB = (await call('POST', '/shops', { name: 'ZZTEST BETA' })).body; createdShopIds.push(shopB.id);
    const ok = await call('PUT', `/shops/${shopB.id}`, { name: 'ZZTEST BETA 2' });
    assert.strictEqual(ok.status, 200); assert.strictEqual(ok.body.name, 'ZZTEST BETA 2');
    const dup = await call('PUT', `/shops/${shopB.id}`, { name: 'zztest alpha' });
    assert.strictEqual(dup.status, 409);
    assert.strictEqual((await call('PUT', `/shops/${shopB.id}`, { name: 'zztest beta 2' })).status, 200); // same shop, other case: allowed
  });
  await t('shops: invalid / unknown id', async () => {
    assert.strictEqual((await call('DELETE', '/shops/abc')).status, 400);
    assert.strictEqual((await call('DELETE', '/shops/999999')).status, 404);
  });
  await t('shops: list includes salesCount', async () => {
    const r = await call('GET', '/shops');
    assert.ok(r.body.find((s) => s.id === shopA.id && s.salesCount === 0));
  });

  // ---- sales ---------------------------------------------------------------
  const D = '2031-03-14'; // far-future date so it never mixes with seed data
  let s1; let s2;
  await t('sales: create computes amount on the backend (2.5 KG -> 93)', async () => {
    const r = await call('POST', '/sales', { shopId: shopA.id, saleDate: D, quantity: 2.5 });
    assert.strictEqual(r.status, 201); assert.strictEqual(r.body.amount, 93); assert.strictEqual(r.body.quantity, 2.5);
    assert.strictEqual(r.body.saleDate, D); s1 = r.body;
  });
  await t('sales: manual amount override is stored as entered', async () => {
    const r = await call('POST', '/sales', { shopId: shopA.id, saleDate: D, quantity: '2.5', amount: '100' });
    assert.strictEqual(r.status, 201); assert.strictEqual(r.body.amount, 100); s2 = r.body;
  });
  await t('sales: unrepresentable quantity is rejected', async () => {
    const bad = await call('POST', '/sales', { shopId: shopA.id, saleDate: D, quantity: 0.25 });
    assert.strictEqual(bad.status, 422); assert.ok(/cannot be made using/.test(bad.body.error));
    const alsoBad = await call('POST', '/sales', { shopId: shopA.id, saleDate: D, quantity: 0.25, amount: 10 });
    assert.strictEqual(alsoBad.status, 422);
  });
  await t('sales: validation messages', async () => {
    const post = (b) => call('POST', '/sales', { shopId: shopA.id, saleDate: D, quantity: 1, ...b });
    let r = await call('POST', '/sales', { saleDate: D, quantity: 1 }); assert.strictEqual(r.body.error, 'Please select a shop.');
    r = await post({ quantity: 0 }); assert.strictEqual(r.body.error, 'Quantity must be greater than 0.');
    r = await post({ quantity: -1 }); assert.strictEqual(r.body.error, 'Quantity must be greater than 0.');
    r = await post({ quantity: 'abc' }); assert.strictEqual(r.status, 400);
    r = await post({ quantity: 1.234 }); assert.strictEqual(r.status, 400);
    r = await post({ amount: -5 }); assert.strictEqual(r.body.error, 'Amount cannot be negative.');
    r = await post({ amount: 'x1' }); assert.strictEqual(r.status, 400);
    r = await post({ saleDate: '2026-02-30' }); assert.strictEqual(r.body.error, 'Invalid date.');
    r = await post({ saleDate: 'nope' }); assert.strictEqual(r.body.error, 'Invalid date.');
    r = await post({ shopId: 'abc' }); assert.strictEqual(r.status, 400);
    r = await post({ shopId: 999999 }); assert.strictEqual(r.status, 400);
  });
  await t('sales: by date returns rows + DB totals', async () => {
    const r = await call('GET', `/sales/date/${D}`);
    assert.strictEqual(r.body.sales.length, 2); assert.strictEqual(r.body.totals.quantity, 5); assert.strictEqual(r.body.totals.amount, 193);
    assert.strictEqual((await call('GET', '/sales/date/2026-13-01')).status, 400);
    const empty = await call('GET', '/sales/date/2031-03-15'); assert.strictEqual(empty.body.sales.length, 0); assert.strictEqual(empty.body.totals.amount, 0);
  });
  await t('sales: by shop and filtered list', async () => {
    assert.strictEqual((await call('GET', `/sales/shop/${shopA.id}`)).body.length, 2);
    assert.strictEqual((await call('GET', `/sales?fromDate=${D}&toDate=${D}&shopId=${shopA.id}`)).body.length, 2);
    assert.strictEqual((await call('GET', `/sales?fromDate=${D}&toDate=2031-01-01`)).status, 400);
  });
  await t('sales: edit (and amount recalculated when not supplied)', async () => {
    const r = await call('PUT', `/sales/${s1.id}`, { shopId: shopA.id, saleDate: D, quantity: 3.5 });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.amount, 130);
    assert.strictEqual((await call('PUT', '/sales/999999', { shopId: shopA.id, saleDate: D, quantity: 1 })).status, 404);
  });
  await t('shops: delete blocked when shop has sales', async () => {
    const r = await call('DELETE', `/shops/${shopA.id}`);
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.error, 'This shop has existing sales and cannot be deleted.');
  });
  await t('date does not shift (stored/returned as the same calendar day)', async () => {
    const rows = await prisma.$queryRaw`SELECT "saleDate"::text AS d FROM sales WHERE id = ${s1.id}`;
    assert.strictEqual(rows[0].d, D);
  });

  // ---- delivery partners --------------------------------------------------
  await t('delivery partners: CRUD and sale charge calculation', async () => {
    const payload = {
      name: 'ZZTEST Delivery',
      prices: [{ quantity: 1, price: 5 }, { quantity: 0.75, price: 4 }, { quantity: 0.5, price: 3 }],
    };
    const created = await call('POST', '/settings/delivery-partners', payload);
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.body.partner.prices.find((p) => p.quantity === 1).price, 5);
    const partnerId = created.body.partner.id;

    const dup = await call('POST', '/settings/delivery-partners', { ...payload, name: 'zztest delivery' });
    assert.strictEqual(dup.status, 400);

    const sale = await call('POST', '/sales', {
      shopId: shopA.id,
      saleDate: D,
      quantity: 8,
      amount: 298,
      deliveryPartnerId: partnerId,
      denominationCounts: { '1': 5, '0.75': 2, '0.5': 3 },
    });
    assert.strictEqual(sale.status, 201);
    assert.strictEqual(sale.body.deliveryPartnerName, 'ZZTEST Delivery');
    assert.strictEqual(sale.body.deliveryCharge, 42);

    const blockedDelete = await call('DELETE', `/settings/delivery-partners/${partnerId}`);
    assert.strictEqual(blockedDelete.status, 400);

    await call('DELETE', `/sales/${sale.body.id}`);
    assert.strictEqual((await call('DELETE', `/settings/delivery-partners/${partnerId}`)).status, 200);
  });

  // ---- pricing settings: history is not rewritten -----------------------------
  await t('settings: price change affects future sales only', async () => {
    const before = (await call('GET', `/sales/date/${D}`)).body.totals.amount;
    const put = await call('PUT', '/settings/pricing', { rules: [{ quantity: 1, price: 40 }, { quantity: 0.75, price: 30 }, { quantity: 0.5, price: 20 }] });
    assert.strictEqual(put.status, 200); assert.strictEqual(put.body.rules.length, 3);
    assert.strictEqual((await call('GET', `/sales/date/${D}`)).body.totals.amount, before);
    const r = await call('POST', '/sales', { shopId: shopA.id, saleDate: D, quantity: 2.5 });
    assert.strictEqual(r.body.amount, 100);
    await call('DELETE', `/sales/${r.body.id}`);
  });
  await t('settings: validation', async () => {
    assert.strictEqual((await call('PUT', '/settings/pricing', { rules: [] })).status, 400);
    assert.strictEqual((await call('PUT', '/settings/pricing', { rules: [{ quantity: 1, price: -1 }] })).status, 400);
    assert.strictEqual((await call('PUT', '/settings/pricing', { rules: [{ quantity: 0, price: 1 }] })).status, 400);
    assert.strictEqual((await call('PUT', '/settings/pricing', { rules: [{ quantity: 1, price: 1 }, { quantity: '1.0', price: 2 }] })).status, 400);
    assert.strictEqual((await call('PUT', '/settings/pricing', { rules: [{ quantity: 1, price: 1 }, { quantity: 0.75, price: 2 }] })).status, 400);
  });
  await call('PUT', '/settings/pricing', { rules: originalPricing });

  // ---- dashboard -----------------------------------------------------------
  const today = todayStr();
  await t('dashboard: today matches database aggregates', async () => {
    const r = await call('GET', '/dashboard/today');
    const [row] = await prisma.$queryRaw`SELECT COALESCE(SUM(amount),0)::float8 AS rev, COALESCE(SUM(quantity),0)::float8 AS qty FROM sales WHERE "saleDate" = ${today}::date`;
    const [mrow] = await prisma.$queryRaw`SELECT COALESCE(SUM(amount),0)::float8 AS rev FROM sales WHERE to_char("saleDate",'YYYY-MM') = ${today.slice(0, 7)}`;
    assert.strictEqual(r.body.todayRevenue, row.rev); assert.strictEqual(r.body.todayQuantity, row.qty);
    assert.strictEqual(r.body.monthRevenue, mrow.rev);
    assert.strictEqual(r.body.totalShops, await prisma.shop.count());
    if (row.rev > 0) assert.ok(r.body.topShop && r.body.topShop.shopName);
    else assert.strictEqual(r.body.topShop, null);
  });
  await t('dashboard: monthly revenue (12 filled months, matches DB)', async () => {
    const r = await call('GET', '/dashboard/monthly-revenue');
    assert.strictEqual(r.body.length, 12);
    const last = r.body[11];
    const [row] = await prisma.$queryRaw`SELECT COALESCE(SUM(amount),0)::float8 AS rev FROM sales WHERE to_char("saleDate",'YYYY-MM') = ${last.monthKey}`;
    assert.strictEqual(last.revenue, row.rev);
    assert.strictEqual((await call('GET', '/dashboard/monthly-revenue?months=0')).status, 400);
  });
  await t('dashboard: month comparison math', async () => {
    const r = (await call('GET', '/dashboard/month-comparison')).body;
    assert.strictEqual(r.difference, Math.round((r.currentMonth.revenue - r.previousMonth.revenue) * 100) / 100);
    const expected = Math.round(((r.currentMonth.revenue - r.previousMonth.revenue) / r.previousMonth.revenue) * 10000) / 100;
    assert.strictEqual(r.percentage, expected);
    const zero = (await call('GET', '/dashboard/month-comparison?month=2031-03')).body; // previous month (Feb 2031) has no sales
    assert.strictEqual(zero.previousMonth.revenue, 0); assert.strictEqual(zero.percentage, null);
    assert.strictEqual((await call('GET', '/dashboard/month-comparison?month=2031-13')).status, 400);
  });
  await t('dashboard: top shops sorted by revenue desc', async () => {
    const r = (await call('GET', '/dashboard/top-shops')).body;
    for (let i = 1; i < r.shops.length; i += 1) assert.ok(r.shops[i - 1].revenue >= r.shops[i].revenue);
    assert.strictEqual(r.topShop.shopId, r.shops[0].shopId);
    const m = (await call('GET', `/dashboard/top-shops?month=${today.slice(0, 7)}`)).body;
    assert.ok(Array.isArray(m.shops));
  });
  await t('dashboard: shop performance', async () => {
    const r = (await call('GET', `/dashboard/shop-performance/${shopA.id}`)).body;
    assert.strictEqual(r.salesCount, 2); assert.strictEqual(r.totalRevenue, 230); assert.strictEqual(r.totalQuantity, 6);
    assert.strictEqual(r.bestMonth.key, '2031-03'); assert.strictEqual(r.monthlyTrend.length, 12);
    assert.strictEqual((await call('GET', '/dashboard/shop-performance/999999')).status, 404);
    assert.strictEqual((await call('GET', '/dashboard/shop-performance/x')).status, 400);
  });

  // ---- reports + excel -----------------------------------------------------
  await t('reports: monthly summary and month list', async () => {
    const r = (await call('GET', `/reports/monthly?month=2031-03`)).body;
    assert.strictEqual(r.totalRevenue, 230); assert.strictEqual(r.daysWithSales, 1); assert.strictEqual(r.averageDailyRevenue, 230);
    assert.strictEqual(r.shops[0].rank, 1); assert.strictEqual(r.label, 'March 2031');
    const months = (await call('GET', '/reports/months')).body;
    assert.ok(months.find((m) => m.key === '2031-03')); assert.ok(months.find((m) => m.key === today.slice(0, 7)));
    assert.strictEqual((await call('GET', '/reports/monthly?month=bad')).status, 400);
  });
  const readSheet = (buf) => {
    const wb = XLSX.read(buf, { type: 'buffer' });
    assert.deepStrictEqual(wb.SheetNames, ['Sales Report']);
    return XLSX.utils.sheet_to_json(wb.Sheets['Sales Report'], { header: 1, defval: '' });
  };
  await t('excel: selected shop + date range', async () => {
    const r = await call('GET', `/reports/export?fromDate=2031-03-01&toDate=2031-03-31&shopId=${shopA.id}`);
    assert.strictEqual(r.status, 200);
    assert.ok(/sales-report-2031-03-01-to-2031-03-31\.xlsx/.test(r.headers.get('content-disposition')));
    const rows = readSheet(r.body);
    assert.deepStrictEqual(rows[0], ['Date', 'Shop', 'Quantity', 'Amount', 'Delivery Partner', 'Delivery Charge']);
    assert.deepStrictEqual(rows[1], ['14-03-2031', 'zztest alpha', 3.5, 130, '', 0]);
    assert.deepStrictEqual(rows[2], ['14-03-2031', 'zztest alpha', 2.5, 100, '', 0]);
    assert.deepStrictEqual(rows[4], ['Total Quantity', '', 6, '', '', '']);
    assert.deepStrictEqual(rows[5], ['Total Revenue', '', '', 230, '', '']);
    assert.deepStrictEqual(rows[6], ['Total Delivery Charge', '', '', '', '', 0]);
  });
  await t('excel: all shops + validation', async () => {
    const wholeMonth = today.slice(0, 7);
    const r = await call('GET', `/reports/export?fromDate=${wholeMonth}-01&toDate=${today}&shopId=all`);
    const rows = readSheet(r.body);
    const [agg] = await prisma.$queryRaw`SELECT COUNT(*)::int AS n, SUM(amount)::float8 AS rev, COALESCE(SUM("deliveryCharge"),0)::float8 AS delivery FROM sales WHERE "saleDate" BETWEEN ${wholeMonth + '-01'}::date AND ${today}::date`;
    assert.strictEqual(rows.length, agg.n + 5);
    assert.strictEqual(rows[rows.length - 2][3], agg.rev ?? '');
    assert.strictEqual(rows[rows.length - 1][5], agg.delivery);
    assert.strictEqual((await call('GET', '/reports/export?fromDate=2031-03-10&toDate=2031-03-01')).status, 400);
    assert.strictEqual((await call('GET', '/reports/export?fromDate=bad&toDate=2031-03-01')).status, 400);
    assert.strictEqual((await call('GET', '/reports/export?fromDate=2031-03-01&toDate=2031-03-02&shopId=999999')).status, 404);
  });

  // ---- cleanup + delete flows ------------------------------------------------
  await t('sales: delete', async () => {
    assert.strictEqual((await call('DELETE', `/sales/${s1.id}`)).status, 200);
    assert.strictEqual((await call('DELETE', `/sales/${s2.id}`)).status, 200);
    assert.strictEqual((await call('DELETE', `/sales/${s2.id}`)).status, 404);
  });
  await t('shops: delete works once it has no sales', async () => {
    for (const id of createdShopIds) assert.strictEqual((await call('DELETE', `/shops/${id}`)).status, 200);
  });
  await t('errors: unknown route and malformed JSON are JSON, no stack', async () => {
    const r = await call('GET', '/nope'); assert.strictEqual(r.status, 404); assert.ok(!JSON.stringify(r.body).includes('at '));
    const res = await fetch(base + '/shops', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    assert.strictEqual(res.status, 400); assert.ok(!(await res.text()).includes('node_modules'));
  });

  console.log(results.join('\n'));
  console.log(`\n${passed}/${results.length} passed`);
  server.close(); await prisma.$disconnect();
})();
