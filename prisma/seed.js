/**
 * Development seed data.
 *  - Shops and default pricing are real starting configuration.
 *  - The SAMPLE SALES are fake development data so the dashboard has something to show.
 *    Skip them with:  SEED_SAMPLE_SALES=false npx prisma db seed
 * Safe to run more than once: shops/pricing are upserted and sample sales are only
 * created when the sales table is empty.
 */
const prisma = require('./client');
const { todayStr, addMonths, monthRange, toDbDate } = require('../utils/dates');
const { unitsToString } = require('../utils/decimal');
const { calculateAmountUnits, loadRules } = require('../services/pricingService');

const SHOPS = ['NILIYUR', 'OM', 'AIYANAR', 'GANESH', 'BRO'];
const PRICING = [
  { quantity: '1.00', price: '37.00' },
  { quantity: '0.75', price: '28.00' },
  { quantity: '0.50', price: '19.00' },
];
// Relative popularity of each shop, so rankings look realistic.
const WEIGHTS = { NILIYUR: 1.0, OM: 0.8, AIYANAR: 0.6, GANESH: 0.5, BRO: 0.3 };
const QUANTITIES = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8];

// Small deterministic PRNG so the seed produces the same data every time.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  for (const name of SHOPS) {
    const existing = await prisma.shop.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (!existing) await prisma.shop.create({ data: { name } });
  }
  for (const p of PRICING) {
    await prisma.pricingRule.upsert({ where: { quantity: p.quantity }, update: {}, create: p });
  }
  console.log('Seeded shops and default pricing (1 KG = 37, 3/4 KG = 28, 1/2 KG = 19).');

  if (process.env.SEED_SAMPLE_SALES === 'false') {
    console.log('Skipping sample sales (SEED_SAMPLE_SALES=false).');
    return;
  }
  if ((await prisma.sale.count()) > 0) {
    console.log('Sales table already has data - not adding sample sales.');
    return;
  }

  console.log('*** DEVELOPMENT SEED DATA: creating sample sales for the last 4 months. Not real data. ***');
  const rules = await loadRules();
  const shops = await prisma.shop.findMany();
  const rand = mulberry32(2026);
  const today = todayStr();
  const startMonth = addMonths(today.slice(0, 7), -3);
  const startDate = monthRange(startMonth).from;

  const rows = [];
  for (let d = new Date(`${startDate}T00:00:00Z`); d.toISOString().slice(0, 10) <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    for (const shop of shops) {
      if (rand() > 0.55 + 0.4 * (WEIGHTS[shop.name] || 0.5)) continue; // some shops skip some days
      const qty = QUANTITIES[Math.floor(rand() * QUANTITIES.length)];
      const qtyUnits = Math.round(qty * 100);
      const amountUnits = calculateAmountUnits(qtyUnits, rules);
      rows.push({
        shopId: shop.id,
        saleDate: toDbDate(dateStr),
        quantity: unitsToString(qtyUnits),
        amount: unitsToString(amountUnits),
      });
    }
  }
  await prisma.sale.createMany({ data: rows });
  console.log(`Created ${rows.length} sample sales.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
