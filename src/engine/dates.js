// Calendar-date helpers. Every date in the engine is a UTC midnight timestamp or a
// 'YYYY-MM-DD' string, so time zones can never move a payment to a different day.

export const DAY_MS = 86400000;
export const DAYS_PER_YEAR = 365.25;

export function parseYMD(s) {
  if (s instanceof Date) return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()));
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toYMD(d) {
  if (!d) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function todayYMD(now = new Date()) {
  return toYMD(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}

export function addDays(d, n) {
  return new Date(d.getTime() + n * DAY_MS);
}

export function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

// Same day-of-month n months later, clamped to the month's last day (Jan 31 + 1 month = Feb 28/29).
export function addMonths(d, n, dayOfMonth = d.getUTCDate()) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  return new Date(Date.UTC(ty, tm, Math.min(dayOfMonth, lastDayOfMonth(ty, tm))));
}

export function addYears(d, n) {
  return addMonths(d, n * 12);
}

export function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

export function yearsBetween(a, b) {
  return (b.getTime() - a.getTime()) / (DAY_MS * DAYS_PER_YEAR);
}

export function minDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

export function maxDate(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatMonthYear(d) {
  const x = typeof d === 'string' ? parseYMD(d) : d;
  return x ? `${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}` : '';
}

export function formatDate(d) {
  const x = typeof d === 'string' ? parseYMD(d) : d;
  return x ? `${MONTHS[x.getUTCMonth()]} ${x.getUTCDate()}, ${x.getUTCFullYear()}` : '';
}
