// Import a plan exported from the old Forecast app (budget-pages).
// Returns { plan, report, ui } where report lists everything that needs a human look
// (level: info | warn | change | absent) and ui carries display preferences (folded groups,
// chart lines, chart range) for the app to apply.
//
// opts.modernize (default true) also upgrades old workarounds to first-class features: net pay
// with a seasonal step → a paycheck, "cash from a card" + card balance → one borrowing item, and
// college bills → paid from the matching 529 first. Pass false for a literal 1:1 import.

import { parseYMD, toYMD, addDays, lastDayOfMonth, todayYMD } from './dates.js';
import { normalizePlan, newId, SCENARIO_COLORS } from './model.js';
import { occurrences } from './schedule.js';
import { amountAt, PAYROLL, payPreview, wageIncomeTax } from './payroll.js';

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

// Old lists interleave groups and items by positionIndex; items without one keep file order.
const byPosition = list => list.map((x, i) => [x, i]).sort((a, b) => (a[0].positionIndex ?? 1e9) - (b[0].positionIndex ?? 1e9) || a[1] - b[1]).map(([x]) => x);

export function importLegacy(json, opts = {}) {
  const report = [];
  const modernize = opts.modernize !== false;
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
  const accGroupOrder = new Map();
  byPosition(json.accountGroups || []).flatMap(g => g.items || []).forEach((id, i) => accGroupOrder.set(id, i));
  const orderedAccounts = (json.accounts || []).map((a, i) => [a, i]).sort((x, y) =>
    (x[0].positionIndex ?? 1e6 + (accGroupOrder.get(x[0].id) ?? 1e5)) - (y[0].positionIndex ?? 1e6 + (accGroupOrder.get(y[0].id) ?? 1e5)) || x[1] - y[1]).map(([a]) => a);
  for (const a of orderedAccounts) {
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
  const loanGroupOrder = new Map();
  byPosition(json.loanGroups || []).flatMap(g => g.items || []).forEach((id, i) => loanGroupOrder.set(id, i));
  const orderedLoans = (json.loans || []).map((l, i) => [l, i]).sort((x, y) =>
    (x[0].positionIndex ?? 1e6 + (loanGroupOrder.get(x[0].id) ?? 1e5)) - (y[0].positionIndex ?? 1e6 + (loanGroupOrder.get(y[0].id) ?? 1e5)) || x[1] - y[1]).map(([l]) => l);
  const loanById = new Map();
  for (const l of orderedLoans) {
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
    loanById.set(debt.id, l);
    if (accByName.has(l.name)) report.push({ level: 'info', message: `"${l.name}" is both an account and a debt. They are now separate items; payments into "${l.name}" were linked to the debt.` });
  }

  // ---- groups ----
  const groupOf = new Map();
  const itemRank = new Map();
  const ui = { planCollapsed: {} };
  byPosition(json.transactionGroups || []).forEach((g, gi) => {
    const gid = newId('grp');
    plan.groups.push({ id: gid, name: g.name });
    if (g.collapsed) ui.planCollapsed[`flows:${gid}`] = true;
    (g.items || []).forEach((item, k) => { groupOf.set(item, gid); itemRank.set(item, gi * 1000 + k); });
  });

  // ---- transactions → flows ----
  const accRef = name => (name ? accByName.get(name)?.id : undefined);
  const txs = (json.transactions || []).map((t, i) => [t, i])
    .sort((x, y) => (itemRank.get(x[0].id) ?? 1e7 + (x[0].positionIndex ?? 1e5)) - (itemRank.get(y[0].id) ?? 1e7 + (y[0].positionIndex ?? 1e5)) || x[1] - y[1])
    .map(([t]) => t);
  const flowOld = new Map();
  for (const t of txs) {
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
    flowOld.set(flow.id, t);
    if (t.split_amount != null && t.split_month && !(modernize && looksLikeSocialSecurityStop(t, flow))) {
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

  if (modernize) {
    mergeCardCash(plan, loanById, flowOld, asOf, report);
    convertPaychecks(plan, flowOld, asOf, report);
    collegeFrom529(plan, report);
  }
  absentFeatures(json, plan, report);
  ui.chartLines = chartLinesFrom(json, plan);
  const vr = json.viewRange;
  if (vr?.start && vr?.end) {
    const yrs = Math.round((new Date(vr.end) - new Date(vr.start)) / (365.25 * 86400000));
    if (yrs >= 1) ui.overviewYears = Math.min(30, yrs);
  }

  plan.comparisons = plan.scenarios.length > 1
    ? [{ id: newId('cmp'), name: plan.scenarios.slice(1).map(s => s.name).join(' vs ') + ' vs Baseline', referenceId: 'baseline', scenarioIds: plan.scenarios.map(s => s.id) }]
    : [];
  report.push({ level: 'info', message: 'Set your birth date under Settings so early-withdrawal penalties apply correctly, and your cash safety floor.' });
  void addDays;
  return { plan: normalizePlan(plan), report, ui };
}

// ---------- modernizing old workarounds ----------

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// Old workaround for borrowing: a one-time "cash from the card" income plus a card balance.
// When the amounts match (the balance may include a transfer fee of up to 6%), they become one
// borrowing item: starts on the cash date, deposits the cash, adds the fee to the balance.
function mergeCardCash(plan, loanById, flowOld, asOf, report) {
  for (const debt of plan.debts) {
    const cashIn = plan.flows.find(f => same(f.name, debt.name) && f.schedule?.freq === 'once' && f.to && !f.from.length && !f.unitId && plan.accounts.some(a => a.id === f.to));
    if (!cashIn) continue;
    const loan = loanById.get(debt.id);
    const principal = Number(cashIn.amount) || 0;
    const owed = Number(loan.initial_balance) || 0;
    const fee = owed - principal;
    const date = cashIn.schedule.start;
    const why = (debt.enabled !== false) !== (cashIn.enabled !== false) ? 'one is switched off and the other isn\'t'
      : !(principal > 0 && fee >= -0.005 && fee <= principal * 0.06) ? `the balance (${owed}) isn't the cash (${principal}) plus a fee of up to 6%`
      : !(date > asOf) ? 'the cash date has already passed' : '';
    if (why) {
      report.push({ level: 'info', message: `"${debt.name}": a debt and a same-named cash deposit look like the old "borrow on a card" workaround, but were kept separate because ${why}.` });
      continue;
    }
    Object.assign(debt, { balance: principal, start: date, proceedsTo: cashIn.to, feeFixed: Math.round(fee * 100) / 100 });
    plan.flows = plan.flows.filter(f => f !== cashIn);
    flowOld.delete(cashIn.id);
    report.push({ level: 'change', message: `"${debt.name}": the card balance and its "cash from card" deposit are now one borrowing item — it starts ${date}, puts ${principal.toLocaleString()} into ${plan.accounts.find(a => a.id === debt.proceedsTo)?.name}, and adds a ${Math.round(fee).toLocaleString()} fee (${(fee / principal * 100).toFixed(1)}%) to the balance.` });
  }
}

// Net pay whose take-home rises for the rest of each year by ≈6.2% of gross is the old way of
// modeling Social Security stopping at the wage base.
function looksLikeSocialSecurityStop(t, flow) {
  const net = Number(t.amount) || 0;
  const later = Number(t.split_amount) || 0;
  if (!(net > 0 && later > net) || flow.unitId || flow.from.length || !flow.to) return false;
  const gross = (later - net) / PAYROLL.ssRate;
  const withheld = 1 - net / gross - PAYROLL.ssRate - PAYROLL.medicareRate;
  return withheld > 0.02 && withheld < 0.5;
}

const SUPPLEMENTAL = 0.22;

function convertPaychecks(plan, flowOld, asOf, report) {
  const state = (Number(plan.settings.tax.state) || 0) / 100;
  const asOfDate = parseYMD(asOf);
  const jan1 = new Date(Date.UTC(asOfDate.getUTCFullYear(), 0, 1));
  const paidSoFar = (f, price = 1) => {
    let sum = 0;
    for (const d of occurrences(f.schedule, jan1, asOfDate)) sum += amountAt(f, d) * price;
    return Math.round(sum);
  };
  const salary = plan.flows.find(f => flowOld.get(f.id) && looksLikeSocialSecurityStop(flowOld.get(f.id), f));
  if (!salary) return;
  const t = flowOld.get(salary.id);
  const net = Number(t.amount);
  const gross = Math.round((Number(t.split_amount) - net) / PAYROLL.ssRate * 100) / 100;
  const withheld = 1 - net / gross - PAYROLL.ssRate - PAYROLL.medicareRate;
  const employer = 'Main job';
  const factor = gross / net;
  salary.amount = gross;
  salary.steps = (salary.steps || []).map(st => ({ ...st, amount: Math.round(Number(st.amount) * factor * 100) / 100 }));
  salary.pay = { employer, fica: true, fedPct: Math.round((withheld - state) * 10000) / 100, statePct: state * 100, ytdGross: null, deductions: [] };
  salary.pay.ytdGross = paidSoFar(salary);
  const converted = [salary.name];

  // Bonuses and RSU vests are wages from the same employer: they share the wage base.
  for (const f of plan.flows) {
    if (f === salary || f.from.length || !f.to) continue;
    if (!f.unitId && /bonus/i.test(f.name)) {
      const g = Math.round(Number(f.amount) / (1 - SUPPLEMENTAL - state - PAYROLL.ssRate - PAYROLL.medicareRate) * 100) / 100;
      f.amount = g;
      f.pay = { employer, fica: true, fedPct: SUPPLEMENTAL * 100, statePct: state * 100, ytdGross: null, deductions: [] };
      f.pay.ytdGross = paidSoFar(f);
      converted.push(f.name);
    } else if (f.unitId && /\brsu\b/i.test(f.name)) {
      const price = Number(plan.units.find(u => u.id === f.unitId)?.price) || 0;
      f.pay = { employer, fica: true, fedPct: SUPPLEMENTAL * 100, statePct: state * 100, ytdGross: null };
      f.pay.ytdGross = paidSoFar(f, price);
      converted.push(f.name);
    }
  }
  // Split the gap between gross and take-home: federal withholding ≈ the estimated tax on all
  // wages from this employer (so April true-ups stay small), and the rest — local tax, insurance,
  // retirement — as one inferred deduction. Take-home is unchanged either way.
  const year = asOfDate.getUTCFullYear() + 1;
  const total = f => (payPreview(plan, f, year)?.rows || []).reduce((s2, r) => s2 + r.gross, 0);
  const others = plan.flows.filter(f => f !== salary && f.pay && f.pay.employer === employer);
  const salaryWages = total(salary);
  const otherWages = others.reduce((s2, f) => s2 + total(f), 0);
  const estTax = wageIncomeTax(salaryWages + otherWages, plan.settings.tax.filing, year, plan.settings.inflation).tax;
  const fed = Math.min(withheld - state, Math.max(0, salaryWages ? (estTax - SUPPLEMENTAL * otherWages) / salaryWages : 0));
  const rest = withheld - state - fed;
  salary.pay.fedPct = Math.round(fed * 10000) / 100;
  if (rest > 0.0005) salary.pay.deductions = [{ id: newId('ded'), name: 'Other paycheck deductions (inferred)', pct: Math.round(rest * 10000) / 100, pretax: false }];
  const names = [...new Set(converted.slice(1))];
  report.push({ level: 'change', message: `"${salary.name}" rose from ${net.toLocaleString()} to ${Number(t.split_amount).toLocaleString()} each year from month ${t.split_month} — that is Social Security (6.2%) stopping at the wage base. It is now a paycheck: gross ${gross.toLocaleString()} minus Social Security & Medicare, ${salary.pay.fedPct}% federal and ${(state * 100).toFixed(2)}% state withholding${rest > 0.0005 ? `, and ${(rest * 100).toFixed(1)}% of other deductions (local tax, insurance, retirement… — inferred, not itemized)` : ''}. Take-home is exactly ${net.toLocaleString()} until the wage base is reached, then steps up automatically each year. Replace these guesses with your pay stub's numbers.` });
  if (names.length) report.push({ level: 'change', message: `Also paychecks from the same employer (they count toward the wage base): ${names.join(', ')}. Bonuses were grossed up from their net amount at the 22% supplemental rate; stock vests now withhold ≈${Math.round((SUPPLEMENTAL + state + PAYROLL.ssRate + PAYROLL.medicareRate) * 100)}% of shares to cover taxes (the old app kept every share).` });
  report.push({ level: 'info', message: 'Each year\'s tax on wages is now estimated (2026 brackets, married filing jointly — change under Settings) and the refund or balance due is settled every April 15, so an old "tax refund" item would double count.' });
}

// College bills paid from Cash while a matching 529 exists → pay from that 529 first.
function collegeFrom529(plan, report) {
  const edu = plan.accounts.filter(a => a.kind === 'education');
  const generic = new Set(['529', 'college', 'tuition', 'school', 'university', 'fund', 'plan', 'account', 'the', 'for']);
  const words = s => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !generic.has(w));
  for (const f of plan.flows) {
    if (f.to || !/college|tuition|universit|school/i.test(f.name) || f.from.some(id => edu.some(a => a.id === id))) continue;
    const w = words(f.name);
    const acct = edu.find(a => words(a.name).some(x => w.includes(x)));
    if (!acct) continue;
    f.from = [acct.id, ...f.from.filter(id => id !== plan.settings.primaryCashId)];
    f.qualified = 'education';
    report.push({ level: 'change', message: `"${f.name}" is now paid from ${acct.name} first (tax-free as a qualified education expense), then from cash once the 529 runs out. The old app paid it all from cash and never used the 529.` });
  }
}

// Chart lines that were switched on in the old app, for accounts and debts Paths can plot.
function chartLinesFrom(json, plan) {
  const on = Object.entries(json.plotOptions || {}).filter(([, v]) => v).map(([k]) => k);
  const keys = [];
  for (const name of on) {
    const a = plan.accounts.find(x => same(x.name, name));
    const d = plan.debts.find(x => same(x.name, name));
    if (a && a.id !== plan.settings.primaryCashId) keys.push(`acct:${a.id}`);
    else if (d) keys.push(`debt:${d.id}`);
  }
  return [...new Set(keys)];
}

function absentFeatures(json, plan, report) {
  const absent = message => report.push({ level: 'absent', message });
  const named = list => list.map(g => `"${g.name}"`).join(', ');
  if ((json.accountGroups || []).length) absent(`Account groups (${named(json.accountGroups)}): Paths groups accounts by type instead (cash, retirement, 529, property…), which also drives taxes.`);
  if ((json.loanGroups || []).length) absent(`Debt groups (${named(json.loanGroups)}): debts are one list in Paths. Order was kept, so grouped debts stay together.`);
  const plotted = Object.entries(json.plotOptions || {}).filter(([, v]) => v).map(([k]) => k)
    .filter(n => !plan.accounts.some(a => same(a.name, n)) && !plan.debts.some(d => same(d.name, n)));
  const txPlotted = Object.values(json.transactionPlotOptions || {}).filter(Boolean).length;
  if (plotted.length || txPlotted) absent(`Chart lines for individual transactions${plotted.length ? ` (${plotted.join(', ')})` : ''}: the chart can show accounts, debts and totals (“+ Add line…”); a transaction's effect shows up in its account.`);
  const rightAxis = [...(json.accounts || []), ...(json.loans || [])].filter(x => x.rightAxis).length;
  if (rightAxis || json.netWorthRightAxis || json.yAxisFrozen) absent('Right-hand axis and frozen Y scale: Paths uses one axis that rescales; click a line in the legend to hide it when scales differ a lot.');
  const iso = plan.flows.filter(f => f.unitId && /\biso\b|option/i.test(f.name));
  if (iso.length) absent(`Stock options (${iso.map(f => `"${f.name}"`).join(', ')}): strike price, exercise and AMT aren't modeled — vested options arrive as free shares, as before.`);
  for (const u of json.units || []) {
    if (u.priceTargetDate && (u.priceTargets || []).length) absent(`${u.name}: the old single price target (${u.priceTargetRate} by ${u.priceTargetDate}) was superseded by the per-scenario price paths, which were imported.`);
  }
  if ((json.accounts || []).some(a => a.tags) || (json.loans || []).some(l => l.tags)) absent('Tags: kept on accounts but nothing in Paths uses them yet (they only helped guess account types).');
  if (plan.accounts.some(a => a.kind === 'property')) report.push({ level: 'info', message: `Mark your primary residence under Plan → Accounts (properties: ${plan.accounts.filter(a => a.kind === 'property').map(a => a.name).join(', ')}) so a sale can use the home-sale exclusion.` });
}
