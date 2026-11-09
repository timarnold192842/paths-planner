// Chart time window: presets are whole calendar years; nudges move the end by a day/week/month/year.
import { parseYMD, addDays, addMonths, addYears, daysBetween } from '../engine/dates.js';

// The chart window starts at the plan's as-of date and runs `years` forward. Whole numbers are
// calendar years (presets); nudged windows are stored as days / 365.25.
export function windowDays(years, startYMD) {
  const start = parseYMD(startYMD);
  if (Number.isInteger(years) && start) return daysBetween(start, addYears(start, years));
  return Math.round(years * 365.25);
}

const STEP = { d: e => addDays(e, 1), w: e => addDays(e, 7), m: e => addMonths(e, 1), y: e => addYears(e, 1) };
const BACK = { d: e => addDays(e, -1), w: e => addDays(e, -7), m: e => addMonths(e, -1), y: e => addYears(e, -1) };

// Move the window's end by a calendar day / week / month / year, kept within 1 day … maxDays.
export function nudgeWindow(years, startYMD, unit, dir, maxDays) {
  const start = parseYMD(startYMD);
  const cur = Math.min(maxDays, windowDays(years, startYMD));
  const next = (dir > 0 ? STEP : BACK)[unit](addDays(start, cur));
  const days = Math.max(1, Math.min(maxDays, daysBetween(start, next)));
  return days === cur ? years : days / 365.25;
}

// "10 years", "10 yrs 1 mo", "3 mo 2 wks", "5 days"
export function durationLabel(years, startYMD) {
  const start = parseYMD(startYMD);
  if (!start) return `${Math.round(years * 10) / 10} years`;
  if (Number.isInteger(years)) return `${years} year${years === 1 ? '' : 's'}`;
  const end = addDays(start, windowDays(years, startYMD));
  let y = end.getUTCFullYear() - start.getUTCFullYear();
  if (addYears(start, y) > end) y--;
  const a = addYears(start, y);
  let m = (end.getUTCFullYear() - a.getUTCFullYear()) * 12 + end.getUTCMonth() - a.getUTCMonth();
  if (addMonths(a, m, start.getUTCDate()) > end) m--;
  const rest = daysBetween(addMonths(a, m, start.getUTCDate()), end);
  const w = Math.floor(rest / 7);
  const d = rest % 7;
  const parts = [];
  if (y) parts.push(`${y} yr${y === 1 ? '' : 's'}`);
  if (m) parts.push(`${m} mo`);
  if (w) parts.push(`${w} wk${w === 1 ? '' : 's'}`);
  if (d) parts.push(`${d} day${d === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' ') : '0 days';
}
