const prisma = require('../prisma/client');
const { toUnits } = require('../utils/decimal');

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Legacy: product amount from a total quantity (re-splits the quantity itself).
 * Kept because other modules may still use it.
 */
function calculateAmountUnits(qtyUnits, rules) {
  const coins = rules
    .filter((r) => r.qtyUnits > 0 && r.priceUnits >= 0)
    .sort((a, b) => b.qtyUnits - a.qtyUnits);

  if (!coins.length || !Number.isInteger(qtyUnits) || qtyUnits <= 0) {
    return null;
  }

  const step = coins.reduce((g, r) => gcd(g, r.qtyUnits), 0);
  if (qtyUnits % step !== 0) return null;

  const target = qtyUnits / step;
  const items = coins.map((r) => ({ q: r.qtyUnits / step, p: r.priceUnits }));

  const reach = new Array(items.length + 1);
  reach[items.length] = new Uint8Array(target + 1);
  reach[items.length][0] = 1;

  for (let k = items.length - 1; k >= 0; k--) {
    const cur = new Uint8Array(target + 1);
    const next = reach[k + 1];
    const q = items[k].q;
    for (let x = 0; x <= target; x++) {
      cur[x] = next[x] || (x >= q && cur[x - q]) ? 1 : 0;
    }
    reach[k] = cur;
  }

  if (!reach[0][target]) return null;

  let remaining = target;
  let total = 0;

  for (let k = 0; k < items.length; k++) {
    const { q, p } = items[k];
    let count = Math.floor(remaining / q);
    while (count > 0 && !reach[k + 1][remaining - count * q]) count--;
    total += count * p;
    remaining -= count * q;
  }

  return total;
}

/** General product pricing -> [{ id, qtyUnits, priceUnits }] */
async function loadRules(client = prisma) {
  const rows = await client.pricingRule.findMany({
    orderBy: { quantity: 'desc' },
  });

  return rows.map((r) => ({
    id: r.id,
    qtyUnits: toUnits(r.quantity),
    priceUnits: toUnits(r.price),
  }));
}

/**
 * Overlay a delivery partner's product selling rates on the general rules.
 * partnerPrices: DeliveryPartnerPrice rows. Rows with productPrice = null
 * (or missing denominations) fall back to the general price.
 */
function applyPartnerRates(rules, partnerPrices) {
  if (!partnerPrices || !partnerPrices.length) return rules;

  return rules.map((rule) => {
    const override = partnerPrices.find(
      (p) =>
        p.productPrice !== null &&
        p.productPrice !== undefined &&
        toUnits(p.quantity) === rule.qtyUnits
    );

    return override
      ? { ...rule, priceUnits: toUnits(override.productPrice) }
      : rule;
  });
}

/**
 * Product amount from the denomination breakdown:
 * sum(count x price of that denomination). Returns null if a used
 * denomination has no price.
 *
 * breakdown: [{ quantityUnits, count }]
 */
function calculateAmountFromBreakdown(breakdown, rules) {
  let total = 0;

  for (const item of breakdown) {
    const rule = rules.find((r) => r.qtyUnits === item.quantityUnits);
    if (!rule) return null;
    total += rule.priceUnits * item.count;
  }

  return total;
}

module.exports = {
  calculateAmountUnits,
  calculateAmountFromBreakdown,
  applyPartnerRates,
  loadRules,
};