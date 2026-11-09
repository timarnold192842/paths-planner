// Check-in: move the plan's "today" forward to a new date with actual balances.
//
// Rules (see docs/DESIGN.md, "Check-ins"):
// * Accounts, debts and prices listed in `actuals` take those values; asOf becomes `today`.
// * Anything dated between the old asOf and today that belongs to the reference scenario has
//   happened in real life and is reflected in the new balances — it is reported, not changed.
// * Scenario-only items (loans, sales, purchases… that the reference scenario doesn't include)
//   would otherwise silently drop out or turn into debt with no money behind it. By default
//   they are moved to tomorrow so the alternative still means "do it now".

import { addDays, parseYMD, toYMD } from './dates.js';
import { clone } from './model.js';
import { occurrences } from './schedule.js';
import { amountAt } from './payroll.js';
import { effectiveSelections, isActive } from './compile.js';

export function rebaseline(plan, actuals, today, opts = {}) {
  const { shiftScenarioOnly = true, referenceId = plan.scenarios[0]?.id, plannedNetWorth = null, actualNetWorth = null } = opts;
  const out = clone(plan);
  const from = plan.asOf;
  const tomorrow = toYMD(addDays(parseYMD(today), 1));
  const inGap = d => !!d && d > from && d <= today;
  const choices = effectiveSelections(plan, referenceId).choices;
  const inReference = item => isActive(item, choices, true);
  const passed = [];
  const shifted = [];

  for (const a of out.accounts) if (a.id in (actuals.balances || {})) a.balance = actuals.balances[a.id];
  for (const d of out.debts) if (d.id in (actuals.balances || {})) d.balance = actuals.balances[d.id];
  for (const u of out.units) if (u.id in (actuals.prices || {})) u.price = actuals.prices[u.id];

  for (const d of out.debts) {
    if (!inGap(d.start)) continue;
    if (inReference(d)) continue; // it started for real; its balance is now the actual one
    if (shiftScenarioOnly) { d.start = tomorrow; shifted.push({ kind: 'debt', id: d.id, name: d.name }); }
    else passed.push({ kind: 'debt', id: d.id, name: d.name, date: d.start });
  }
  for (const e of out.events) {
    if (!inGap(e.date)) continue;
    if (!inReference(e) && shiftScenarioOnly) {
      e.date = tomorrow;
      shifted.push({ kind: 'event', id: e.id, name: e.name || e.type });
    } else passed.push({ kind: 'event', id: e.id, name: e.name || e.type, date: e.date });
  }

  // Paychecks: roll "wages paid so far this year" forward so payroll caps stay right.
  const newYear = parseYMD(today).getUTCFullYear();
  const sameYear = newYear === parseYMD(from).getUTCFullYear();
  for (const f of out.flows) {
    if (!f.pay) continue;
    // Pay from scenario-only or disabled jobs never arrived in real life.
    if (!inReference(f) || f.enabled === false) { if (!sameYear) f.pay.ytdGross = 0; continue; }
    const price = f.unitId ? Number(out.units.find(u => u.id === f.unitId)?.price) || 0 : 1;
    let ytd = sameYear ? Number(f.pay.ytdGross) || 0 : 0;
    const since = sameYear ? addDays(parseYMD(from), 1) : new Date(Date.UTC(newYear, 0, 1));
    for (const d of occurrences(f.schedule, since, parseYMD(today))) ytd += amountAt(f, d) * price;
    f.pay.ytdGross = Math.round(ytd);
  }

  out.history = [...(out.history || []), { date: today, netWorth: actualNetWorth, plannedNetWorth, previousAsOf: from }];
  out.asOf = today;
  return { plan: out, passed, shifted };
}
