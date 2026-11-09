import { parseYMD, toYMD, addDays, addMonths, lastDayOfMonth, minDate, maxDate } from './dates.js';

// A schedule describes when a cash flow happens:
//   { freq, start, end?, dayOfMonth?, days?, weekday?, month?, interval? }
// freq: once | daily | weekly | biweekly | semimonthly | monthly | quarterly | annual | everyNMonths
// Unless overridden, recurring schedules anchor on the start date (a monthly flow starting on the
// 15th recurs on the 15th; a weekly flow starting on a Friday recurs on Fridays).

export const FREQUENCIES = [
  { id: 'once', label: 'One time' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'biweekly', label: 'Every 2 weeks' },
  { id: 'semimonthly', label: 'Twice a month' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'quarterly', label: 'Quarterly' },
  { id: 'annual', label: 'Yearly' },
  { id: 'everyNMonths', label: 'Every N months' }
];

// Approximate occurrences per year, for "monthly equivalent" summaries.
export const PER_YEAR = { once: 0, daily: 365.25, weekly: 52.18, biweekly: 26.09, semimonthly: 24, monthly: 12, quarterly: 4, annual: 1 };

export function perYear(schedule) {
  if (!schedule) return 0;
  if (schedule.freq === 'everyNMonths') return 12 / Math.max(1, schedule.interval || 1);
  return PER_YEAR[schedule.freq] ?? 0;
}

// All occurrence dates (Date objects) of `schedule` that fall within [from, to], inclusive.
export function occurrences(schedule, from, to) {
  const out = [];
  if (!schedule) return out;
  const start = parseYMD(schedule.start);
  if (!start) return out;
  const end = minDate(parseYMD(schedule.end), to);
  const lo = maxDate(start, from);
  if (!end || lo > end) return out;
  const push = d => { if (d >= lo && d <= end) out.push(d); };

  switch (schedule.freq) {
    case 'once':
      push(start);
      break;
    case 'daily': {
      for (let d = lo; d <= end; d = addDays(d, 1)) out.push(d);
      break;
    }
    case 'weekly':
    case 'biweekly': {
      const step = schedule.freq === 'weekly' ? 7 : 14;
      let d = start;
      if (schedule.freq === 'weekly' && Number.isInteger(schedule.weekday)) {
        while (d.getUTCDay() !== schedule.weekday) d = addDays(d, 1);
      }
      if (d < lo) d = addDays(d, Math.ceil((lo - d) / (step * 86400000)) * step);
      for (; d <= end; d = addDays(d, step)) push(d);
      break;
    }
    case 'semimonthly': {
      const days = normalizeDays(schedule.days);
      let y = start.getUTCFullYear();
      let m = start.getUTCMonth();
      while (Date.UTC(y, m, 1) <= end.getTime()) {
        const last = lastDayOfMonth(y, m);
        const inMonth = [...new Set(days.map(x => (x === 'last' ? last : Math.min(x, last))))].sort((a, b) => a - b);
        for (const day of inMonth) push(new Date(Date.UTC(y, m, day)));
        m++;
        if (m > 11) { m = 0; y++; }
      }
      break;
    }
    case 'monthly':
    case 'quarterly':
    case 'everyNMonths':
    case 'annual': {
      const interval = schedule.freq === 'monthly' ? 1
        : schedule.freq === 'quarterly' ? 3
        : schedule.freq === 'annual' ? 12
        : Math.max(1, Math.round(schedule.interval || 1));
      const dom = schedule.dayOfMonth === 'last' ? 31 : (Number(schedule.dayOfMonth) || start.getUTCDate());
      let anchor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
      if (schedule.freq === 'annual' && Number.isInteger(schedule.month)) {
        anchor = new Date(Date.UTC(start.getUTCFullYear(), schedule.month - 1, 1));
        if (addMonths(anchor, 0, dom) < start) anchor = addMonths(anchor, 12, 1);
      }
      // Skip whole periods that end before the window to keep long horizons cheap.
      const monthsToLo = (lo.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (lo.getUTCMonth() - anchor.getUTCMonth());
      if (monthsToLo > interval) anchor = addMonths(anchor, Math.floor((monthsToLo - 1) / interval) * interval, 1);
      for (let a = anchor; a <= end; a = addMonths(a, interval, 1)) {
        push(new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), Math.min(dom, lastDayOfMonth(a.getUTCFullYear(), a.getUTCMonth())))));
      }
      break;
    }
    default:
      break;
  }
  return out;
}

function normalizeDays(days) {
  const list = Array.isArray(days) ? days : String(days || '1,15').split(',');
  const out = list
    .map(x => (String(x).trim().toLowerCase() === 'last' ? 'last' : parseInt(x, 10)))
    .filter(x => x === 'last' || (Number.isInteger(x) && x >= 1 && x <= 31));
  return out.length ? out : [1, 15];
}

export function describeSchedule(s) {
  if (!s) return '';
  const f = FREQUENCIES.find(x => x.id === s.freq);
  if (s.freq === 'once') return `On ${s.start}`;
  if (s.freq === 'everyNMonths') return `Every ${s.interval || 1} months`;
  if (s.freq === 'semimonthly') return `On days ${normalizeDays(s.days).join(' & ')}`;
  return f ? f.label : s.freq;
}

export { toYMD };
