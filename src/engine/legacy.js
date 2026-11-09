// Import a plan exported from the old Forecast app (budget-pages).
// Returns { plan, report } where report lists everything that needs a human look.

import { parseYMD, toYMD, addDays, lastDayOfMonth, todayYMD } from './dates.js';
import { normalizePlan, newId, SCENARIO_COLORS } from './model.js';

const pctFromFactor = f => (f == null || f === '' ? 0 : Math.round((Number(f) - 1) * 100 * 10000) / 10000);

export function isLegacyForecast(json) {
  return json && typeof json === 'object' && Array.isArray(json.accounts) && Array.isArray(json.transactions) && !json.schema;
}

function guessKind(a, isUnit) {
  const n = `${a.name || ''}`.toLowerCase();
  const tags = `${a.tags || ''}`.toLowerCase();
  if (isUnit) return 'equity';
  if (n === 'cash' || /checking|savings/.test(n)) return 'cash';
  if (/real-estate|real estate|property/.test(tags)) return 'property';
  if (/roth/.test(n)) return 'roth';
  if (/401k|401\(k\)|traditional|trad ira|\bira\b/.test(n)) return 'traditional';
  if (/hsa/.test(n)) return 'hsa';
  if (/529/.test(n)) return 'education';
  if (/brokerage|taxable/.test(n + tags)) return 'brokerage';
  return 'other';
}

// Legacy loans store the original balance at start_date; walk payments to today (same method
// the old app used for its "current balance").
function legacyCurrentBalance(loan, asOf) {
  const startDate = parseYMD(loan.start_date);
  const today = parseYMD(asOf);
  let balance = Number(loan.initial_balance) || 0;
  if (!startDate || startDate >= today) return balance;
  const dailyRate = (Number(loan.interest_rate) || 0) / 365.25;
  const payment = Number(loan.monthly_payment) || 0;
  const dom = Number(loan.day_of_month) || 1;
  let d = startDate;
  while (d < today && balance > 0) {
    let y = d.getUTCFullYear();
    let m = d.getUTCMonth();
    let next = new Date(Date.UTC(y, m, Math.min(dom, lastDayOfMonth(y, m))));
    if (next <= d) {
      m += 1;
      if (m > 11) { m = 0; y += 1; }
      next = new Date(Date.UTC(y, m, Math.min(dom, lastDayOfMonth(y, m))));
    }
    const segEnd = next <= today ? next : today;
    const days = Math.max(0, Math.round((segEnd - d) / 86400000));
    if (days > 0 && dailyRate > 0) balance *= (1 + dailyRate) ** days;
    if (next <= today) { balance = Math.max(0, balance - payment); d = next; } else break;
  }
  return Math.max(0, balance);
}

function convertSchedule(t, report) {
  const start = t.start_date || todayYMD();
  const end = t.end_date || undefined;
  switch (t.type) {
    case 'OneTime': return { freq: 'once', start };
    case 'Daily': return { freq: 'daily', start, end };
    case 'Weekly': return { freq: 'weekly', start, end, weekday: Number.isInteger(t.day_of_week) ? t.day_of_week : undefined };
    case 'BiWeekly': {
      const days = String(t.days_of_month || '1,15').split(',').map(x => (x.trim() === 'last' ? 'last' : parseInt(x, 10))).filter(Boolean);
      return { freq: 'semimonthly', start, end, days };
    }
    case 'Monthly': return { freq: 'monthly', start, end, dayOfMonth: Number(t.day_of_month) || 1 };
    case 'Annual': return { freq: 'annual', start, end, month: Number(t.month_of_year) || 1, dayOfMonth: Number(t.day_of_month) || 1 };
    case 'Quarterly': {
      // Old quarterly = Jan/Apr/Jul/Oct 1. Re-anchor on the first quarter start on/after `start`.
      const s = parseYMD(start);
      let y = s.getUTCFullYear();
      let m = Math.ceil(s.getUTCMonth() / 3) * 3;
      if (s.getUTCDate() > 1 && s.getUTCMonth() % 3 === 0) m += 3;
      if (m > 9) { m -= 12; y += 1; }
      return { freq: 'quarterly', start: toYMD(new Date(Date.UTC(y, m, 1))), end, dayOfMonth: 1 };
    }
    default:
      report.push({ level: 'warn', message: `"${t.name}": unknown frequency "${t.type}" — imported as one-time.` });
      return { freq: 'once', start };
  }
}

export function importLegacy(json, opts = {}) {
  const report = [];
  const asOf = opts.asOf || todayYMD();
  const plan = normalizePlan({ name: opts.name || 'Imported plan', asOf, horizonYears: 30 });
  plan.scenarios = [{ id: 'baseline', name: 'Baseline', color: SCENARIO_COLORS[0], choices: {}, cases: {}, patches: [] }];

  // ---- units → price models + an assumption with one case per old price scenario ----
  const unitIdMap = new Map();
  for (const u of json.units || []) {
    if (u.isDefault || u.id === 'usd') continue;
    const id = newId('unit');
    unitIdMap.set(u.id, id);
    const cases = [...new Set((u.priceTargets || []).map(t => t.scenario || 'Base'))];
    const asmId = newId('asm');
    const unit = { id, name: u.name, symbol: u.symbol || u.name, price: Number(u.usdRate) || 0, growth: Number(u.growthRate) || 0, assumptionId: asmId, paths: {} };
    const asm = { id: asmId, name: `${u.name} price`, cases: [] };
    const flatId = newId('case');
    asm.cases.push({ id: flatId, name: "Flat (today's price)", patches: [{ id, field: 'growth', value: 0 }] });
    for (const c of cases) {
      const cid = newId('case');
      unit.paths[cid] = (u.priceTargets || []).filter(t => (t.scenario || 'Base') === c && t.date && Number.isFinite(Number(t.usdRate))).map(t => ({ date: t.date, price: Number(t.usdRate) }));
      asm.cases.push({ id: cid, name: c, patches: [] });
    }
    const active = asm.cases.find(c => c.name === (u.activeScenario || 'Base'));
    asm.defaultCase = u.growthEnabled && active ? active.id : flatId;
    if (!u.growthEnabled && cases.length) {
      report.push({ level: 'info', message: `${u.name}: price targets were switched off in the old app, so the default case is "Flat (today's price)". Bear/Mid/Bull are available as assumption cases for comparisons.` });
    }
    plan.units.push(unit);
    plan.assumptions.push(asm);
  }

  // ---- accounts ----
  const accByOldId = new Map();
  const accByName = new Map();
  for (const a of json.accounts || []) {
    const unitId = a.units && a.units !== 'usd' ? unitIdMap.get(a.units) : undefined;
    const kind = guessKind(a, !!unitId);
    const acc = {
      id: newId('acct'),
      name: a.name,
      kind,
      balance: Number(a.balance) || 0,
      unitId,
      growth: pctFromFactor(a.annual_growth),
      tags: String(a.tags || '').split(',').map(s => s.trim()).filter(Boolean)
    };
    plan.accounts.push(acc);
    accByOldId.set(a.id, acc);
    accByName.set(a.name, acc);
  }
  const cash = plan.accounts.find(a => a.name === 'Cash') || plan.accounts.find(a => a.kind === 'cash');
  plan.settings.primaryCashId = cash?.id || plan.accounts[0]?.id || null;
  report.push({ level: 'info', message: `Account types were guessed from names and tags (${plan.accounts.map(a => `${a.name} → ${a.kind}`).join(', ')}). Check them under Plan → Accounts; types drive taxes and liquidity.` });
  if (plan.accounts.some(a => a.kind === 'property' || a.kind === 'equity')) {
    report.push({ level: 'warn', message: 'Cost basis is unknown for properties and stock, so it was set to today\'s value (no tax on gains so far). Enter real cost basis to estimate capital-gains tax on sales.' });
  }

  // ---- debts ----
  const debtByName = new Map();
  for (const l of json.loans || []) {
    const startsLater = parseYMD(l.start_date) > parseYMD(asOf);
    const debt = {
      id: newId('debt'),
      name: l.name,
      balance: Math.round(legacyCurrentBalance(l, asOf) * 100) / 100,
      rate: Math.round((Number(l.interest_rate) || 0) * 100 * 10000) / 10000,
      payment: Number(l.monthly_payment) || 0,
      paymentDay: Number(l.day_of_month) || 1,
      start: startsLater ? l.start_date : undefined,
      payoffDate: l.early_payoff_date || l.payoff_date || undefined,
      securedBy: l.linkedAccountId ? accByOldId.get(l.linkedAccountId)?.id : undefined,
      payFrom: [],
      enabled: l.isEnabled !== false
    };
    plan.debts.push(debt);
    debtByName.set(l.name, debt);
    if (accByName.has(l.name)) report.push({ level: 'info', message: `"${l.name}" is both an account and a debt. They are now separate items; payments into "${l.name}" were linked to the debt.` });
  }

  // ---- groups ----
  const groupOf = new Map();
  for (const g of json.transactionGroups || []) {
    const gid = newId('grp');
    plan.groups.push({ id: gid, name: g.name });
    for (const item of g.items || []) groupOf.set(item, gid);
  }

  // ---- transactions → flows ----
  const accRef = name => (name ? accByName.get(name)?.id : undefined);
  for (const t of json.transactions || []) {
    const unitId = t.units && t.units !== 'usd' ? unitIdMap.get(t.units) : undefined;
    const toId = t.to_account ? (debtByName.get(t.to_account)?.id || accRef(t.to_account)) : null;
    const fromId = t.from_account ? (accRef(t.from_account) || debtByName.get(t.from_account)?.id) : undefined;
    if (t.to_account && !toId) report.push({ level: 'warn', message: `"${t.name}" goes to "${t.to_account}", which no longer exists — imported as an expense.` });
    if (t.from_account && !fromId) report.push({ level: 'warn', message: `"${t.name}" comes from "${t.from_account}", which no longer exists — it will be paid from Cash.` });
    const flow = {
      id: newId('flow'),
      name: t.name,
      group: groupOf.get(t.id),
      amount: Number(t.amount) || 0,
      unitId,
      schedule: convertSchedule(t, report),
      growth: pctFromFactor(t.annual_growth),
      steps: [],
      from: fromId ? [fromId] : [],
      to: toId || null,
      whileOwned: t.linkedAccountId ? accByOldId.get(t.linkedAccountId)?.id : undefined,
      enabled: t.isEnabled !== false
    };
    if (t.split_amount != null && t.split_month) {
      const s = parseYMD(flow.schedule.start);
      let stepDate = new Date(Date.UTC(s.getUTCFullYear(), Number(t.split_month) - 1, 1));
      if (stepDate < s) stepDate = new Date(Date.UTC(s.getUTCFullYear() + 1, Number(t.split_month) - 1, 1));
      flow.steps.push({ date: toYMD(stepDate), amount: Number(t.split_amount) });
      report.push({ level: 'info', message: `"${t.name}": the old "split amount" became a permanent change to ${t.split_amount} from ${toYMD(stepDate)} (the old app reset it every January).` });
    }
    if (!flow.from.length && !flow.to) {
      report.push({ level: 'warn', message: `"${t.name}" had neither a source nor a destination — imported as an expense from Cash.` });
    }
    plan.flows.push(flow);
  }

  // ---- asset sale dates + fees → sell events, owned by a decision so you can compare ----
  for (const a of json.accounts || []) {
    if (!a.saleDate) continue;
    const acc = accByOldId.get(a.id);
    const fees = (json.fees || []).filter(f => f.assetId === a.id);
    const pct = fees.filter(f => f.feeType === 'percent').reduce((s, f) => s + (Number(f.amount) || 0), 0);
    const fixed = fees.filter(f => f.feeType === 'fixed').reduce((s, f) => s + (Number(f.amount) || 0), 0);
    const decId = newId('dec');
    const keep = newId('alt');
    const sell = newId('alt');
    const evt = { id: newId('evt'), type: 'sell', name: `Sell ${a.name}`, assetId: acc.id, date: a.saleDate, costPct: pct, fixedCost: fixed, when: { [decId]: [sell] } };
    plan.events.push(evt);
    plan.decisions.push({
      id: decId,
      name: `${a.name}: keep or sell?`,
      defaultAlt: sell,
      alternatives: [
        { id: keep, name: 'Keep', patches: [] },
        { id: sell, name: `Sell ${a.saleDate}`, patches: [] }
      ]
    });
    plan.scenarios.push({ id: newId('scn'), name: `Keep ${a.name}`, color: SCENARIO_COLORS[plan.scenarios.length % SCENARIO_COLORS.length], choices: { [decId]: keep }, cases: {}, patches: [] });
    report.push({ level: 'info', message: `${a.name} had a sale date. It is now a decision ("${a.name}: keep or sell?") with Sell as the default, plus a "Keep ${a.name}" scenario so you can compare right away.` });
    if (pct) report.push({ level: 'info', message: `${a.name}: the ${pct}% selling fee now applies to the sale price (the old app applied it to equity after the mortgage).` });
  }

  plan.comparisons = plan.scenarios.length > 1
    ? [{ id: newId('cmp'), name: plan.scenarios.slice(1).map(s => s.name).join(' vs ') + ' vs Baseline', referenceId: 'baseline', scenarioIds: plan.scenarios.map(s => s.id) }]
    : [];
  report.push({ level: 'info', message: 'Set your birth date under Settings so early-withdrawal penalties apply correctly, and your cash safety floor.' });
  void addDays;
  return { plan: normalizePlan(plan), report };
}
