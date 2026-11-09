// Daily simulation of a compiled plan. Pure: no DOM, no globals.
//
// Day order (see docs/DESIGN.md §10):
//   1 growth & interest (and new loans originate) · 2 income & unit grants · 3 transfers ·
//   4 events (buy → sell → liquidate → payoff) · 5 expenses · 6 scheduled debt payments
// Money is conserved: only the primary cash account may go negative, and only after any
// safety-net credit lines are used up. Taxes are estimated when money leaves a tax-bearing account.
//
// Attribution: every day's change in net worth is split into income, spending, taxes, interest,
// costs, and growth. Whatever isn't explained explicitly lands in an "other" bucket, so the
// buckets always add up exactly to the change in net worth.

import { parseYMD, toYMD, addDays, addMonths, addYears, yearsBetween, DAYS_PER_YEAR } from './dates.js';
import { occurrences } from './schedule.js';
import { pricePath } from './prices.js';
import { amountAt, paycheck, newYtd, wageIncomeTax, indexFactor, PAYROLL } from './payroll.js';

export { amountAt };

const EPS = 1e-6;
const BASIS_KINDS = new Set(['brokerage', 'equity', 'education', 'hsa', 'roth', 'property']);
const GROWTH_LABELS = {
  cash: 'Interest on cash', brokerage: 'Brokerage returns', equity: 'Company stock price & growth', traditional: '401(k) / IRA returns',
  roth: 'Roth returns', hsa: 'HSA returns', education: '529 returns', property: 'Real-estate appreciation', other: 'Other assets (appreciation / depreciation)'
};

export const PAYMENT_RULES = [
  { id: 'fixed', label: 'Fixed monthly payment' },
  { id: 'amortize', label: 'Pay off evenly over a term' },
  { id: 'interestOnly', label: 'Interest only' },
  { id: 'minimum', label: 'Card-style minimum' }
];

export function simulate(plan, opts = {}) {
  const keepLedger = opts.ledger !== false;
  const start = parseYMD(plan.asOf);
  const end = addYears(start, Math.max(1, Number(plan.horizonYears) || 30));
  const N = Math.round((end - start) / 86400000) + 1;
  const dates = new Array(N);
  for (let i = 0; i < N; i++) dates[i] = addDays(start, i);
  const idx = d => Math.round((d - start) / 86400000);

  const s = plan.settings || {};
  const tax = s.tax || {};
  const taxOn = tax.enabled !== false;
  const rate = p => (taxOn ? (Number(p) || 0) / 100 : 0);
  const ordinary = rate(tax.ordinary) + rate(tax.state);
  const ltcg = rate(tax.ltcg) + rate(tax.state);
  const birth = parseYMD(tax.birthDate || '');
  const ageAt = d => (birth ? yearsBetween(birth, d) : 99);
  const groupName = new Map((plan.groups || []).map(g => [g.id, g.name]));

  // ---- attribution ----
  const Y = Math.ceil((N - 1) / DAYS_PER_YEAR) + 1;
  const buckets = new Map();
  let today = new Map();
  const yearOf = i => Math.min(Y - 1, Math.max(0, Math.floor((i - 1) / DAYS_PER_YEAR)));
  function attr(kind, key, label, amount) {
    if (!amount) return;
    const k = `${kind}:${key}`;
    if (!buckets.has(k)) buckets.set(k, { key: k, kind, label, values: new Float64Array(Y) });
    today.set(k, (today.get(k) || 0) + amount);
  }
  const flowKey = f => (f.group && groupName.has(f.group) ? [`g:${f.group}`, groupName.get(f.group)] : [`f:${f.id}`, f.name]);

  // ---- prices (precomputed per unit per day) ----
  const prices = new Map();
  for (const u of plan.units || []) {
    const fn = pricePath(u, u.caseId, plan.asOf);
    const arr = new Float64Array(N);
    for (let i = 0; i < N; i++) arr[i] = fn(dates[i]);
    prices.set(u.id, arr);
  }
  const priceOf = (unitId, i) => (unitId && prices.has(unitId) ? prices.get(unitId)[i] : 1);

  // ---- accounts ----
  const primaryId = s.primaryCashId && plan.accounts.some(a => a.id === s.primaryCashId)
    ? s.primaryCashId
    : (plan.accounts.find(a => a.kind === 'cash') || plan.accounts[0] || {}).id;
  const acc = new Map();
  for (const a of plan.accounts) {
    const ownedFromDate = parseYMD(a.ownedFrom || '');
    const ownedFrom = ownedFromDate && ownedFromDate > start ? idx(ownedFromDate) : 0;
    const qty = ownedFrom > 0 ? 0 : Number(a.balance) || 0;
    const value0 = qty * priceOf(a.unitId, 0);
    acc.set(a.id, {
      def: a,
      qty,
      basis: a.costBasis != null && a.costBasis !== '' ? Number(a.costBasis) : (BASIS_KINDS.has(a.kind) ? value0 : 0),
      dailyGrowth: (1 + (Number(a.growth) || 0) / 100) ** (1 / DAYS_PER_YEAR),
      ownedFrom,
      soldAt: null,
      series: new Float64Array(N),
      isPrimary: a.id === primaryId
    });
  }
  const valueOf = (st, i) => st.qty * priceOf(st.def.unitId, i);
  const owned = (st, i) => st && i >= st.ownedFrom && (st.soldAt == null || i < st.soldAt);

  // ---- debts ----
  const debt = new Map();
  for (const d of plan.debts) {
    const startDate = parseYMD(d.start || '');
    const startIdx = startDate && startDate > start ? idx(startDate) : 0;
    const steps = (d.rateSteps || [])
      .map(x => ({ i: idx(parseYMD(x.date) || start), rate: Number(x.rate) || 0 }))
      .filter(x => Number.isFinite(x.i))
      .sort((a, b) => a.i - b.i);
    const termStart = startDate || start; // the loan's real start, even if before the as-of date
    debt.set(d.id, {
      def: d,
      bal: startIdx > 0 ? 0 : Math.max(0, Number(d.balance) || 0),
      startIdx,
      steps,
      baseRate: Number(d.rate) || 0,
      limit: Number(d.creditLimit) > 0 ? Number(d.creditLimit) : null,
      payoffIdx: parseYMD(d.payoffDate || '') ? idx(parseYMD(d.payoffDate)) : Infinity,
      termEnd: Number(d.termMonths) > 0 ? addMonths(termStart, Number(d.termMonths)) : parseYMD(d.payoffDate || ''),
      accrued: 0,
      series: new Float64Array(N)
    });
  }
  // Annual rate (%) on day i, after any dated rate changes (promo periods, resets).
  function annualRate(dst, i) {
    let r = dst.baseRate;
    for (const st of dst.steps) { if (st.i <= i) r = st.rate; else break; }
    return r;
  }
  // A credit line can be drawn once open, until its payoff date, and while its collateral is owned.
  function isCreditSource(dst, i) {
    if (!dst || dst.limit == null || i < dst.startIdx || i >= dst.payoffIdx) return false;
    const collateral = dst.def.securedBy ? acc.get(dst.def.securedBy) : null;
    return !(collateral && collateral.soldAt != null && i >= collateral.soldAt);
  }
  const creditRoom = dst => Math.max(0, dst.limit - dst.bal);
  const safetyNet = (s.safetyNet || []).filter(id => debt.has(id));

  // ---- ledger & totals ----
  const ledger = [];
  const totals = { taxes: 0, interest: 0, costs: 0, shortfall: 0, unfunded: 0, borrowed: 0 };
  const log = (i, kind, entry) => { if (keepLedger) ledger.push({ date: toYMD(dates[i]), kind, ...entry }); };
  const addTax = x => { if (x > 0) { totals.taxes += x; attr('taxes', 'taxes', 'Taxes & penalties', -x); } };
  const addCost = (x, label = 'Selling, closing & loan fees') => { if (x > 0) { totals.costs += x; attr('costs', 'costs', label, -x); } };

  // ---- paychecks & the annual tax true-up ----
  // Payroll counters (Social Security wage base, capped deductions) run per employer per calendar
  // year. Each year's wage withholding is compared with an estimated tax bill and settled on
  // April 15 of the next year: a refund into primary cash or a payment out of it.
  const inflation = Number(s.inflation) || 0;
  const filing = tax.filing === 'single' ? 'single' : 'mfj';
  const asOfYear = start.getUTCFullYear();
  const ytdCounters = new Map();
  const taxYears = new Map();
  const ytdFor = (f, year) => {
    const k = `${(f.pay.employer || '').trim().toLowerCase()}|${year}`;
    if (!ytdCounters.has(k)) ytdCounters.set(k, newYtd());
    return ytdCounters.get(k);
  };
  const taxYear = year => {
    if (!taxYears.has(year)) taxYears.set(year, { year, wages: 0, ficaWages: 0, pretax: 0, fica: 0, fedWithheld: 0, stateWithheld: 0, addlMedWithheld: 0, includesEarlier: false, settledOn: null });
    return taxYears.get(year);
  };
  const addPay = (year, r) => {
    const t = taxYear(year);
    t.wages += r.gross; t.ficaWages += r.ficaWages; t.pretax += r.pretax; t.fica += r.ss + r.medicare;
    t.addlMedWithheld += r.addlMedicare; t.fedWithheld += r.fed; t.stateWithheld += r.state;
  };
  const payOpts = (f, year, extra) => ({ year, inflation, taxOn, isUnit: !!f.unitId, limitIndex: indexFactor(year, inflation, asOfYear), key: f.id, ...extra });
  // Wages paid earlier this year (before the as-of date) count toward this year's caps and tax
  // bill; they're assumed to have had the same withholding and deductions.
  for (const f of plan.flows) {
    const earlier = Number(f.pay?.ytdGross) || 0;
    if (!f.pay || !f.to || (f.from || []).length || earlier <= 0) continue;
    const typical = amountAt(f, start) * priceOf(f.unitId, 0);
    addPay(asOfYear, paycheck(f.pay, earlier, ytdFor(f, asOfYear), payOpts(f, asOfYear, { count: typical > 0 ? earlier / typical : 1 })));
    taxYear(asOfYear).includesEarlier = true;
  }
  // The as-of year is only partly simulated; without the earlier wages its tax can't be estimated.
  // Likewise the last year when the horizon ends before December 31st.
  const partialYear = t => (t.year === asOfYear && !t.includesEarlier && start.getUTCMonth() > 0) || new Date(Date.UTC(t.year, 11, 31)) > end;
  function trueUp(t) {
    const taxable = Math.max(0, t.wages - t.pretax);
    const fed = taxOn ? wageIncomeTax(taxable, filing, t.year, inflation) : { tax: 0, marginal: 0 };
    const addlMedicare = taxOn ? PAYROLL.addlMedicareRate * Math.max(0, t.ficaWages - PAYROLL.addlMedicareThreshold[filing]) : 0;
    const state = taxable * rate(tax.state);
    const withheld = t.fedWithheld + t.stateWithheld + t.addlMedWithheld;
    return { ...t, taxable, federal: fed.tax, marginal: fed.marginal, addlMedicare, state, withheld, due: fed.tax + addlMedicare + state - withheld, partial: partialYear(t) };
  }
  const settleDays = new Map();
  for (let y = asOfYear; ; y++) {
    const d = new Date(Date.UTC(y + 1, 3, 15));
    if (d > end) break;
    if (d > start) settleDays.set(idx(d), y);
  }

  // ---- money primitives ----
  function deposit(id, usd, i, basisUsd = usd) {
    const st = acc.get(id);
    if (!st || !(usd > 0) && !(usd < 0)) return false;
    if (!owned(st, i) && !st.isPrimary) return false;
    st.qty += usd / priceOf(st.def.unitId, i);
    if (BASIS_KINDS.has(st.def.kind) && basisUsd > 0) st.basis += basisUsd;
    return true;
  }

  // Effective tax+penalty fraction of a gross withdrawal from an account.
  function withdrawalTaxRate(st, i, ctx) {
    const k = st.def.kind;
    const v = Math.max(valueOf(st, i), EPS);
    const gainFrac = Math.min(1, Math.max(0, (v - st.basis) / v));
    if (!taxOn) return 0;
    switch (k) {
      case 'brokerage':
      case 'equity':
        return gainFrac * ltcg;
      case 'traditional':
        return ordinary + (ageAt(dates[i]) < 59.5 ? 0.10 : 0);
      case 'hsa':
        return ctx.qualified === 'medical' ? 0 : ordinary + (ageAt(dates[i]) < 65 ? 0.20 : 0);
      case 'education':
        return ctx.qualified === 'education' ? 0 : gainFrac * (ordinary + 0.10);
      default:
        return 0;
    }
  }

  // Take `gross` USD out of an account (capped at its value unless allowed to go negative).
  function takeGross(st, gross, i, allowNegative = st.isPrimary) {
    const v = valueOf(st, i);
    if (!allowNegative) gross = Math.min(gross, Math.max(0, v));
    if (gross <= EPS) return 0;
    if (BASIS_KINDS.has(st.def.kind) && v > EPS) st.basis *= Math.max(0, 1 - Math.min(gross, v) / v);
    st.qty -= gross / priceOf(st.def.unitId, i);
    return gross;
  }

  function draw(dst, amount, i) {
    const got = Math.min(amount, creditRoom(dst));
    if (got <= EPS) return 0;
    dst.bal += got;
    totals.borrowed += got;
    return got;
  }

  // Pay `net` USD from an ordered list of sources (accounts or credit lines), then primary
  // cash. Primary cash only goes negative after safety-net credit lines are exhausted.
  function payFrom(sources, net, i, ctx = {}) {
    let need = net;
    const used = [];
    for (const id of (sources || []).filter(x => x !== primaryId && x !== ctx.exclude)) {
      if (need <= EPS) break;
      const dst = debt.get(id);
      if (dst) {
        if (!isCreditSource(dst, i)) continue;
        const got = draw(dst, need, i);
        if (got > 0) { need -= got; used.push({ id, gross: got, tax: 0, draw: true }); }
        continue;
      }
      const st = acc.get(id);
      if (!st || !owned(st, i) || valueOf(st, i) <= EPS) continue;
      const t = withdrawalTaxRate(st, i, ctx);
      if (t >= 1) continue;
      const gross = takeGross(st, need / (1 - t), i, false);
      const got = gross * (1 - t);
      addTax(gross - got);
      need -= got;
      used.push({ id, gross, tax: gross - got });
    }
    if (need > EPS && acc.has(primaryId)) {
      used.push(...fromPrimary(need, i, ctx.exclude));
      need = 0;
    }
    if (need > EPS) totals.unfunded += need;
    return used;
  }

  // Take `need` from primary cash: its positive balance first, then safety-net credit lines,
  // and only then let it go negative. Always covers the full amount.
  function fromPrimary(need, i, exclude) {
    const p = acc.get(primaryId);
    const used = [];
    if (safetyNet.length) {
      const fromCash = takeGross(p, Math.min(need, Math.max(0, valueOf(p, i))), i, false);
      if (fromCash > 0) { need -= fromCash; used.push({ id: primaryId, gross: fromCash, tax: 0 }); }
      for (const id of safetyNet) {
        if (need <= EPS) break;
        if (id === exclude) continue;
        const dst = debt.get(id);
        if (!isCreditSource(dst, i)) continue;
        const got = draw(dst, need, i);
        if (got > 0) { need -= got; used.push({ id, gross: got, tax: 0, draw: true }); }
      }
    }
    if (need > EPS) { takeGross(p, need, i, true); used.push({ id: primaryId, gross: need, tax: 0 }); }
    return used;
  }

  function debtPay(dst, amount, sources, i, label, kind = 'debt-payment') {
    if (!dst || dst.bal <= EPS || !(amount > EPS)) return 0;
    const pay = Math.min(amount, dst.bal);
    const used = payFrom(sources, pay, i, { exclude: dst.def.id });
    dst.bal -= pay;
    dst.accrued = 0;
    log(i, kind, { item: dst.def.id, name: label, amount: pay, from: used.map(u => u.id), tax: sum(used, 'tax') });
    return pay;
  }

  // Scheduled payment amount for a debt today, by its payment rule.
  function scheduledPayment(dst, i) {
    const d = dst.def;
    const floor = Number(d.payment) || 0;
    switch (d.paymentRule) {
      case 'interestOnly':
        return dst.accrued;
      case 'minimum':
        return Math.max(floor, dst.bal * (Number(d.minPct ?? 1) || 0) / 100 + dst.accrued);
      case 'amortize': {
        if (!dst.termEnd) return floor;
        // Payments left, counting today's.
        const months = Math.max(1, Math.round((dst.termEnd - dates[i]) / (86400000 * 30.4375)) + 1);
        // Standard annuity on the principal before this period's interest (which the payment covers).
        const principal = Math.max(0, dst.bal - dst.accrued);
        const r = annualRate(dst, i) / 100 / 12;
        return r ? principal * r / (1 - (1 + r) ** -months) : principal / months;
      }
      default:
        return floor;
    }
  }

  // ---- flows: precompute occurrences by day ----
  const byDay = { income: new Map(), transfer: new Map(), expense: new Map() };
  const push = (map, i, v) => { if (!map.has(i)) map.set(i, []); map.get(i).push(v); };
  const firstDay = addDays(start, 1); // balances are as of `asOf`; activity on that day is already in them
  for (const f of plan.flows) {
    const hasTo = !!f.to;
    const hasFrom = (f.from || []).length > 0;
    const phase = hasTo && !hasFrom ? 'income' : hasTo && hasFrom ? 'transfer' : 'expense';
    const ownerAsset = f.whileOwned ? acc.get(f.whileOwned) : null;
    for (const d of occurrences(f.schedule, firstDay, end)) {
      push(byDay[phase], idx(d), { f, amount: amountAt(f, d), ownerAsset });
    }
  }

  // ---- events by day ----
  const eventsByDay = new Map();
  const ORDER = { buy: 0, sell: 1, liquidate: 2, payoff: 3 };
  for (const e of plan.events) {
    const ds = e.type === 'liquidate' && e.schedule ? occurrences(e.schedule, firstDay, end) : [parseYMD(e.date)].filter(d => d && d >= firstDay && d <= end);
    for (const d of ds) push(eventsByDay, idx(d), e);
  }
  for (const list of eventsByDay.values()) list.sort((a, b) => (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9));

  // ---- scheduled debt payments & payoffs ----
  const debtByDay = new Map();
  for (const dst of debt.values()) {
    const d = dst.def;
    const payoff = parseYMD(d.payoffDate || '');
    const from = dst.startIdx > 0 ? addDays(start, dst.startIdx + 1) : firstDay;
    const last = payoff ? addDays(payoff, -1) : end;
    const rule = d.paymentRule || 'fixed';
    if (rule !== 'fixed' || Number(d.payment) > 0) {
      for (const day of occurrences({ freq: 'monthly', start: toYMD(from), dayOfMonth: Number(d.paymentDay) || 1 }, from, last)) {
        push(debtByDay, idx(day), { dst, type: 'payment' });
      }
    }
    if (payoff && payoff >= firstDay && payoff <= end) push(debtByDay, idx(payoff), { dst, type: 'payoff' });
  }

  // ---- recording ----
  const nw = new Float64Array(N);
  const afterTax = new Float64Array(N);
  const cash = new Float64Array(N);
  const accessible = new Float64Array(N);
  const assets = new Float64Array(N);
  const liabilities = new Float64Array(N);
  const creditAvailable = new Float64Array(N);

  const propSellPct = (Number(tax.propertySellingCostPct) || 0) / 100;
  function record(i) {
    let A = 0;
    let L = 0;
    let AT = 0;
    let C = 0;
    let AC = 0;
    let CR = 0;
    for (const st of acc.values()) {
      const v = owned(st, i) || st.isPrimary ? valueOf(st, i) : 0;
      st.series[i] = v;
      A += v;
      const k = st.def.kind;
      let at = v;
      if (v > 0) {
        if (k === 'brokerage' || k === 'equity') at = v - Math.max(0, v - st.basis) * ltcg;
        else if (k === 'traditional') at = v * (1 - ordinary - (ageAt(dates[i]) < 59.5 && taxOn ? 0.10 : 0));
        else if (k === 'property') {
          const net = v * (1 - propSellPct);
          const exclusion = st.def.primaryResidence ? Number(tax.residenceExclusion) || 0 : 0;
          at = net - Math.max(0, net - st.basis - exclusion) * ltcg;
        }
      }
      AT += at;
      if (k === 'cash') { C += v; AC += v; } else if (k === 'brokerage' || k === 'equity') AC += at;
    }
    for (const dst of debt.values()) {
      dst.series[i] = dst.bal;
      L += dst.bal;
      if (isCreditSource(dst, i)) CR += creditRoom(dst);
    }
    assets[i] = A;
    liabilities[i] = L;
    nw[i] = A - L;
    afterTax[i] = AT - L;
    cash[i] = C;
    accessible[i] = AC;
    creditAvailable[i] = CR;
  }
  record(0);

  // ---- main loop ----
  for (let i = 1; i < N; i++) {
    today = new Map();

    // 1. growth, interest, and loans that start today
    for (const st of acc.values()) {
      if (!owned(st, i)) continue;
      const before = st.qty * priceOf(st.def.unitId, i - 1);
      st.qty *= st.dailyGrowth;
      attr('growth', st.def.kind, GROWTH_LABELS[st.def.kind] || 'Growth', st.qty * priceOf(st.def.unitId, i) - before);
    }
    for (const dst of debt.values()) {
      if (i === dst.startIdx && dst.startIdx > 0) originate(dst, i);
      else if (dst.bal > EPS) {
        const r = annualRate(dst, i);
        if (r) {
          const interest = dst.bal * r / 100 / DAYS_PER_YEAR;
          dst.bal += interest;
          dst.accrued += interest;
          totals.interest += interest;
          attr('interest', 'interest', 'Interest on debt', -interest);
        }
      }
    }

    // last year's wage taxes are settled on April 15
    if (settleDays.has(i)) settleTaxYear(settleDays.get(i), i);

    // 2. income & unit grants
    for (const { f, amount, ownerAsset } of byDay.income.get(i) || []) {
      if (ownerAsset && !owned(ownerAsset, i)) continue;
      const dst = acc.get(f.to);
      const dDebt = debt.get(f.to);
      if (dst && !owned(dst, i) && !dst.isPrimary) continue;
      const price = priceOf(f.unitId, i);
      const gross = amount * price;
      if (f.pay && dst) { runPaycheck(f, gross, price, dst, i); continue; }
      let units = amount;
      let withheld = 0;
      if (f.withholdPct) { withheld = units * Math.min(100, Number(f.withholdPct)) / 100; units -= withheld; }
      let usd = units * price;
      let taxPaid = withheld * price;
      if (f.taxed === 'ordinary') { taxPaid += usd * ordinary; usd *= 1 - ordinary; }
      const [k, label] = flowKey(f);
      attr('income', k, label, gross);
      addTax(taxPaid);
      if (dst) {
        if (f.unitId && dst.def.unitId === f.unitId) {
          dst.qty += usd / price;
          if (BASIS_KINDS.has(dst.def.kind)) dst.basis += usd; // vest-date price is the cost basis
        } else deposit(f.to, usd, i, usd);
      } else if (dDebt) {
        dDebt.bal = Math.max(0, dDebt.bal - usd);
      }
      log(i, 'income', { item: f.id, name: f.name, amount: usd, to: f.to, tax: taxPaid });
    }

    // 3. transfers (amount = what leaves the source; tax on the way out is withheld)
    for (const { f, amount, ownerAsset } of byDay.transfer.get(i) || []) {
      if (ownerAsset && !owned(ownerAsset, i)) continue;
      const toDebt = debt.get(f.to);
      let gross = amount * priceOf(f.unitId, i);
      if (toDebt) {
        if (toDebt.bal <= EPS) continue;
        gross = Math.min(gross, toDebt.bal);
        const used = payFrom(f.from, gross, i, { qualified: f.qualified });
        toDebt.bal -= gross;
        log(i, 'transfer', { item: f.id, name: f.name, amount: gross, from: used.map(u => u.id), to: f.to, tax: sum(used, 'tax') });
        continue;
      }
      let moved = 0;
      let taxPaid = 0;
      const sources = f.from || [];
      for (const id of sources) {
        if (gross - moved <= EPS) break;
        const dSrc = debt.get(id);
        if (dSrc) { if (isCreditSource(dSrc, i)) moved += draw(dSrc, gross - moved, i); continue; }
        if (id === primaryId) { fromPrimary(gross - moved, i); moved = gross; continue; }
        const st = acc.get(id);
        if (!st || !owned(st, i)) continue;
        const t = withdrawalTaxRate(st, i, { qualified: f.qualified });
        const g = takeGross(st, gross - moved, i, false);
        moved += g;
        taxPaid += g * t;
      }
      addTax(taxPaid);
      if (moved - taxPaid > EPS) deposit(f.to, moved - taxPaid, i);
      log(i, 'transfer', { item: f.id, name: f.name, amount: moved, from: sources, to: f.to, tax: taxPaid, note: moved + EPS < gross ? 'Source ran out' : undefined });
    }

    // 4. events
    for (const e of eventsByDay.get(i) || []) runEvent(e, i);

    // 5. expenses
    for (const { f, amount, ownerAsset } of byDay.expense.get(i) || []) {
      if (ownerAsset && !owned(ownerAsset, i)) continue;
      const usd = amount * priceOf(f.unitId, i);
      if (!(usd > 0)) continue;
      const [k, label] = flowKey(f);
      attr('spending', k, label, -usd);
      const used = payFrom(f.from, usd, i, { qualified: f.qualified });
      log(i, 'expense', { item: f.id, name: f.name, amount: usd, from: used.map(u => u.id), tax: sum(used, 'tax') });
    }

    // 6. scheduled debt payments
    for (const { dst, type } of debtByDay.get(i) || []) {
      if (type === 'payment') debtPay(dst, scheduledPayment(dst, i), dst.def.payFrom, i, `${dst.def.name} payment`);
      else debtPay(dst, dst.bal, dst.def.payFrom, i, `${dst.def.name} payoff`, 'payoff');
    }

    const p = acc.get(primaryId);
    if (p && p.qty < 0) totals.shortfall = Math.max(totals.shortfall, -valueOf(p, i));
    record(i);

    // close the day's attribution: anything unexplained goes to "other"
    let explained = 0;
    for (const v of today.values()) explained += v;
    const residual = (nw[i] - nw[i - 1]) - explained;
    if (Math.abs(residual) > 0.005) attr('other', 'other', 'Other (sale price vs. model, loans without proceeds)', residual);
    const y = yearOf(i);
    for (const [k, v] of today) buckets.get(k).values[y] += v;
  }

  function runPaycheck(f, gross, price, dst, i) {
    const year = dates[i].getUTCFullYear();
    const r = paycheck(f.pay, gross, ytdFor(f, year), payOpts(f, year));
    addPay(year, r);
    const [k, label] = flowKey(f);
    let employerIn = 0;
    const parts = [];
    for (const d of r.deductions) {
      if (d.amount > EPS) parts.push(`${d.name} ${fmt(d.amount)}`);
      if (d.to && acc.has(d.to) && deposit(d.to, d.amount + d.employer, i)) { employerIn += d.employer; continue; }
      attr('spending', `pay:${f.id}:${d.id}`, d.name, -d.amount);
    }
    attr('income', k, label, gross + employerIn);
    addTax(r.withheld);
    if (f.unitId && dst.def.unitId === f.unitId) {
      dst.qty += r.net / price; // shares withheld to cover taxes (sell-to-cover)
      if (BASIS_KINDS.has(dst.def.kind)) dst.basis += r.net;
    } else deposit(f.to, r.net, i, r.net);
    const taxes = [r.ss ? `SS ${fmt(r.ss)}` : '', `Medicare ${fmt(r.medicare + r.addlMedicare)}`, `withholding ${fmt(r.fed + r.state)}`].filter(Boolean).join(' · ');
    log(i, 'income', { item: f.id, name: f.name, amount: r.net, to: f.to, tax: r.withheld, gross, note: [`Gross ${fmt(gross)}`, taxOn ? taxes : '', ...parts].filter(Boolean).join(' · ') });
  }

  function settleTaxYear(year, i) {
    const t = taxYears.get(year);
    if (!t || t.wages <= 0 || partialYear(t)) return;
    const r = trueUp(t);
    t.settledOn = toYMD(dates[i]);
    const note = `Est. tax ${fmt(r.federal + r.state + r.addlMedicare)} vs withheld ${fmt(r.withheld)}`;
    if (r.due > EPS) {
      payFrom([], r.due, i);
      addTax(r.due);
      log(i, 'tax', { name: `${year} income tax due`, amount: r.due, note });
    } else if (r.due < -EPS) {
      deposit(primaryId, -r.due, i, 0);
      totals.taxes += r.due;
      attr('taxes', 'taxes', 'Taxes & penalties', -r.due);
      log(i, 'refund', { name: `${year} tax refund`, amount: -r.due, to: primaryId, note });
    }
  }

  // A new loan: balance (+ any fee) appears; the money goes to an account or pays down another debt.
  function originate(dst, i) {
    const d = dst.def;
    const target = d.proceedsTo;
    // "Transfer the whole balance": size the loan to whatever the other debt owes on that day.
    const principal = d.transferAll && target && debt.has(target) ? debt.get(target).bal : Math.max(0, Number(d.balance) || 0);
    const fee = principal * (Number(d.feePct) || 0) / 100 + (Number(d.feeFixed) || 0);
    dst.bal = principal + fee;
    dst.accrued = 0;
    totals.borrowed += principal;
    addCost(fee);
    let note = '';
    if (target && debt.has(target)) {
      const other = debt.get(target);
      const applied = Math.min(principal, other.bal);
      other.bal -= applied;
      if (principal - applied > EPS) deposit(primaryId, principal - applied, i, 0);
      note = `Paid ${fmt(applied)} of ${other.def.name}`;
    } else if (target) {
      deposit(target, principal, i, 0);
      note = `Deposited to ${acc.get(target)?.def.name || 'account'}`;
    }
    log(i, 'borrow', { item: d.id, name: `${d.name} starts`, amount: principal, to: target, note: [note, fee ? `fee ${fmt(fee)}` : ''].filter(Boolean).join(' · ') });
  }

  function runEvent(e, i) {
    switch (e.type) {
      case 'buy': {
        const st = acc.get(e.assetId);
        if (!st) return;
        const price = Number(e.price) || 0;
        const closing = price * (Number(e.closingPct) || 0) / 100 + (Number(e.closingFixed) || 0);
        st.ownedFrom = i;
        st.soldAt = null;
        st.qty = price / priceOf(st.def.unitId, i);
        st.basis = price + closing;
        addCost(closing);
        const loan = debt.get(e.debtId);
        const loanAmt = loan ? loan.bal : 0;
        const cashNeeded = price + closing - loanAmt;
        const used = cashNeeded > 0 ? payFrom(e.from, cashNeeded, i) : [];
        if (cashNeeded < 0) deposit(primaryId, -cashNeeded, i, 0);
        log(i, 'buy', { item: e.id, name: e.name || `Buy ${st.def.name}`, amount: price, from: used.map(u => u.id), note: `Down payment + closing ${fmt(Math.max(0, cashNeeded))}` });
        break;
      }
      case 'sell': {
        const st = acc.get(e.assetId);
        if (!st || !owned(st, i)) return;
        const v = e.price != null && e.price !== '' ? Number(e.price) : valueOf(st, i);
        const costs = v * (Number(e.costPct) || 0) / 100 + (Number(e.fixedCost) || 0);
        addCost(costs);
        const proceeds = v - costs;
        // Secured debts are settled from proceeds first.
        let debtPaid = 0;
        for (const dst of debt.values()) {
          if (dst.def.securedBy !== st.def.id || dst.bal <= EPS) continue;
          const fromProceeds = Math.min(dst.bal, Math.max(0, proceeds - debtPaid));
          debtPaid += fromProceeds;
          const rest = dst.bal - fromProceeds;
          if (rest > EPS) payFrom([], rest, i); // underwater: the remainder comes from cash
          log(i, 'payoff', { item: dst.def.id, name: `${dst.def.name} paid at sale`, amount: dst.bal });
          dst.bal = 0;
        }
        const exclusion = e.useExclusion || st.def.primaryResidence ? Number(tax.residenceExclusion) || 0 : 0;
        const gain = v - costs - st.basis - exclusion;
        const taxPaid = Math.max(0, gain) * ltcg;
        addTax(taxPaid);
        const net = proceeds - debtPaid - taxPaid;
        st.qty = 0;
        st.basis = 0;
        st.soldAt = i;
        if (net >= 0) deposit(e.to || primaryId, net, i, 0);
        else payFrom([], -net, i);
        log(i, 'sell', { item: e.id, name: e.name || `Sell ${st.def.name}`, amount: v, to: e.to || primaryId, tax: taxPaid, note: `Costs ${fmt(costs)} · debt ${fmt(debtPaid)} · net ${fmt(net)}` });
        break;
      }
      case 'liquidate': {
        const st = acc.get(e.assetId);
        if (!st || !owned(st, i) || st.qty <= EPS) return;
        const price = priceOf(st.def.unitId, i);
        let units = e.mode === 'usd' ? (Number(e.amount) || 0) / price
          : e.mode === 'percent' ? st.qty * (Number(e.amount) || 0) / 100
          : Number(e.amount) || 0;
        units = Math.min(units, st.qty);
        if (units <= EPS) return;
        const gross = units * price;
        const basisSold = st.basis * units / st.qty;
        const r = e.taxRate != null && e.taxRate !== '' ? rate(e.taxRate) : ltcg;
        const taxPaid = Math.max(0, gross - basisSold) * r;
        st.basis -= basisSold;
        st.qty -= units;
        addTax(taxPaid);
        deposit(e.to || primaryId, gross - taxPaid, i);
        log(i, 'liquidate', { item: e.id, name: e.name || `Sell ${st.def.name}`, amount: gross, from: [st.def.id], to: e.to || primaryId, tax: taxPaid, note: `${round(units)} units @ ${fmt(price)}` });
        break;
      }
      case 'payoff': {
        const dst = debt.get(e.debtId);
        if (!dst || dst.bal <= EPS) { log(i, 'note', { item: e.id, name: e.name || 'Payoff', note: 'Nothing left to pay off' }); return; }
        debtPay(dst, dst.bal, e.from, i, e.name || `Pay off ${dst.def.name}`, 'payoff');
        break;
      }
      default:
        break;
    }
  }

  const accountsOut = {};
  for (const [id, st] of acc) accountsOut[id] = st.series;
  const debtsOut = {};
  for (const [id, dst] of debt) debtsOut[id] = dst.series;
  return {
    start: plan.asOf,
    dates,
    N,
    primaryId,
    series: { netWorth: nw, afterTax, cash, accessible, assets, liabilities, creditAvailable },
    accounts: accountsOut,
    debts: debtsOut,
    ledger,
    totals,
    attribution: { years: Y, buckets: [...buckets.values()] },
    taxYears: [...taxYears.values()].filter(t => t.wages > 0).sort((a, b) => a.year - b.year).map(trueUp),
    units: Object.fromEntries([...prices].map(([id, arr]) => [id, arr]))
  };
}

// Sum of each attribution bucket from the start up to `years` (whole or fractional).
export function attributionUpTo(run, years) {
  const out = new Map();
  const full = Math.floor(years);
  const frac = years - full;
  for (const b of run.attribution.buckets) {
    let v = 0;
    for (let y = 0; y < Math.min(full, b.values.length); y++) v += b.values[y];
    if (frac && full < b.values.length) v += b.values[full] * frac;
    out.set(b.key, { ...b, total: v });
  }
  return out;
}

function sum(list, key) {
  return list.reduce((s, x) => s + (x[key] || 0), 0);
}
function round(n) {
  return Math.round(n * 100) / 100;
}
function fmt(n) {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}
