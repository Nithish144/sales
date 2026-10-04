/**
 * Date handling approach
 * ----------------------
 * A sale's date is a CALENDAR DATE ("2026-10-04"), not a moment in time.
 *  - PostgreSQL column type is DATE (no time, no timezone).
 *  - The API always exchanges dates as "YYYY-MM-DD" strings.
 *  - To talk to Prisma we use UTC midnight of that date, and we read it back with
 *    toISOString().slice(0, 10). Because we never apply a local-time conversion,
 *    a sale on 04-Oct can never drift to 03-Oct or 05-Oct.
 *  - "Today" is computed in APP_TIMEZONE (default Asia/Kolkata), not server-local time.
 */

const TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function todayStr() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const year = Number(s.slice(0, 4));
  if (year < 2000 || year > 2100) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const toDbDate = (s) => new Date(`${s}T00:00:00.000Z`);
const fromDbDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

function isValidMonthKey(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s) && Number(s.slice(0, 4)) >= 2000 && Number(s.slice(0, 4)) <= 2100;
}

const currentMonthKey = () => todayStr().slice(0, 7);

function addMonths(key, n) {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7)) - 1 + n;
  const year = y + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12;
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

function monthRange(key) {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${key}-01`, to: `${key}-${String(lastDay).padStart(2, '0')}`, daysInMonth: lastDay };
}

const monthName = (key) => MONTH_NAMES[Number(key.slice(5, 7)) - 1];
const monthLabel = (key) => `${monthName(key)} ${key.slice(0, 4)}`;
const monthShortLabel = (key) => `${monthName(key).slice(0, 3)} ${key.slice(2, 4)}`;

module.exports = {
  TZ,
  todayStr,
  isValidDateStr,
  toDbDate,
  fromDbDate,
  isValidMonthKey,
  currentMonthKey,
  addMonths,
  monthRange,
  monthName,
  monthLabel,
  monthShortLabel,
};
