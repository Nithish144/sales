const XLSX = require('xlsx');
const { toNumber } = require('../utils/decimal');

const dmy = (iso) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

/**
 * rows: [{ saleDate: 'YYYY-MM-DD', shopName, quantity, amount, deliveryPartnerName, deliveryCharge }]
 * Returns a Buffer containing an .xlsx workbook with one sheet "Sales Report".
 */
function buildSalesWorkbook(rows) {
  const QTY_FMT = 'General" KG"';
  const AMT_FMT = '"₹"#,##0.00';

  const data = [['Date', 'Shop', 'Quantity', 'Amount', 'Delivery Partner', 'Delivery Charge']];
  let totalQty = 0;
  let totalAmt = 0;
  let totalDelivery = 0;
  for (const r of rows) {
    const q = toNumber(r.quantity);
    const a = toNumber(r.amount);
    const d = toNumber(r.deliveryCharge);
    totalQty += Math.round(q * 100);
    totalAmt += Math.round(a * 100);
    totalDelivery += Math.round(d * 100);
    data.push([dmy(r.saleDate), r.shopName, q, a, r.deliveryPartnerName || '', d]);
  }
  const totalQuantity = totalQty / 100;
  const totalRevenue = totalAmt / 100;
  const totalDeliveryCharge = totalDelivery / 100;

  data.push([]);
  data.push(['Total Quantity', '', totalQuantity, '', '', '']);
  data.push(['Total Revenue', '', '', totalRevenue, '', '']);
  data.push(['Total Delivery Charge', '', '', '', '', totalDeliveryCharge]);

  const ws = XLSX.utils.aoa_to_sheet(data);

  // Number formats: quantity shown as "7 KG" / "3.5 KG", amount as "₹259.00".
  const lastRow = data.length;
  for (let r = 2; r <= lastRow; r += 1) {
    const q = ws[`C${r}`];
    const a = ws[`D${r}`];
    const d = ws[`F${r}`];
    if (q && q.t === 'n') q.z = QTY_FMT;
    if (a && a.t === 'n') a.z = AMT_FMT;
    if (d && d.t === 'n') d.z = AMT_FMT;
  }

  // Auto-size columns from the longest rendered value.
  const rendered = data.map((row) =>
    row.map((cell, i) => {
      if (typeof cell === 'number') return i === 2 ? `${cell} KG` : `₹${cell.toFixed(2)}`;
      return cell === undefined ? '' : String(cell);
    })
  );
  ws['!cols'] = [0, 1, 2, 3, 4, 5].map((i) => ({
    wch: Math.max(10, ...rendered.map((row) => (row[i] || '').length)) + 2,
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sales Report');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildSalesWorkbook };
