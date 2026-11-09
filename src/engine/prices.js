import { parseYMD, yearsBetween } from './dates.js';

// Price of one unit (e.g. one AUR share) in USD on a given date.
// unit: { price, growth (%/yr), paths: { [caseId]: [{ date, price }] } }
// With a path: linear from today's price to the first target, linear between targets, then
// compound growth after the last target. Without a path: compound growth from today.
export function pricePath(unit, caseId, asOf) {
  const base = Number(unit?.price) || 0;
  const g = (Number(unit?.growth) || 0) / 100;
  const t0 = parseYMD(asOf);
  const targets = ((unit?.paths || {})[caseId] || [])
    .map(t => ({ d: parseYMD(t.date), p: Number(t.price) }))
    .filter(t => t.d && Number.isFinite(t.p) && t.d > t0)
    .sort((a, b) => a.d - b.d);

  return function priceAt(date) {
    if (!targets.length) return g ? base * (1 + g) ** Math.max(0, yearsBetween(t0, date)) : base;
    if (date <= t0) return base;
    let prev = { d: t0, p: base };
    for (const t of targets) {
      if (date <= t.d) {
        const f = (date - prev.d) / (t.d - prev.d);
        return prev.p + (t.p - prev.p) * f;
      }
      prev = t;
    }
    return g ? prev.p * (1 + g) ** yearsBetween(prev.d, date) : prev.p;
  };
}
