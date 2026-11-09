// Daily simulation of a compiled plan. Pure: no DOM, no globals.
//
// Day order (see docs/DESIGN.md §10):
//   1 growth & interest · 2 income & unit grants · 3 transfers ·
//   4 events (buy → sell → liquidate → payoff) · 5 expenses · 6 scheduled debt payments
// Money is conserved: only the primary cash account may go negative; every other source is
// capped at what it holds. Taxes are estimated at the moment money leaves a tax-bearing account.

import { parseYMD, toYMD, addDays, addYears, yearsBetween, DAYS_PER_YEAR } from './dates.js';
import { occurrences } from './schedule.js';
import { pricePath } from './prices.js';

const EPS = 1e-6;
const BASIS_KINDS = new Set(['brokerage', 'equity', 'education', 'hsa', 'roth', 'property']);

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
    debt.set(d.id, {
      def: d,
      bal: startIdx > 0 ? 0 : Math.max(0, Number(d.balance) || 0),
      startIdx,
      dailyRate: (Number(d.rate) || 0) / 100 / DAYS_PER_YEAR,
      series: new Float64Array(N),
      interestPaid: 0
    });
  }

  // ---- ledger & totals ----
  const ledger = [];
  const totals = { taxes: 0, interest: 0, costs: 0, shortfall: 0, unfunded: 0 };
  const log = (i, kind, entry) => { if (keepLedger) ledger.push({ date: toYMD(dates[i]), kind, ...entry }); };

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

  // Take `gross` USD out of an account (capped at its value unless it is the primary cash).
  function takeGross(st, gross, i) {
    const v = valueOf(st, i);
    if (!st.isPrimary) gross = Math.min(gross, Math.max(0, v));
    if (gross <= EPS) return 0;
    if (BASIS_KINDS.has(st.def.kind) && v > EPS) st.basis *= Math.max(0, 1 - gross / v);
    st.qty -= gross / priceOf(st.def.unitId, i);
    return gross;
  }

  // Pay `net` USD of spending from an ordered list of sources, then from primary cash.
  // Returns the sources used, for the ledger.
  function payFrom(sources, net, i, ctx = {}) {
    let need = net;
    const used = [];
    const list = [...(sources || []).filter(id => id !== primaryId), primaryId];
    for (const id of list) {
      if (need <= EPS) break;
      const st = acc.get(id);
      if (!st) continue;
      const isLast = id === primaryId;
      if (!isLast && (!owned(st, i) || valueOf(st, i) <= EPS)) continue;
      const t = withdrawalTaxRate(st, i, ctx);
      if (t >= 1) continue;
      const gross = takeGross(st, need / (1 - t), i);
      const got = gross * (1 - t);
      const taxPaid = gross - got;
      totals.taxes += taxPaid;
      need -= got;
      used.push({ id, gross, tax: taxPaid });
    }
    if (need > EPS) totals.unfunded += need; // only when there is no primary cash account
    return used;
  }

  function debtPay(dst, amount, sources, i, label, kind = 'debt-payment') {
    if (!dst || dst.bal <= EPS) return 0;
    const pay = Math.min(amount, dst.bal);
    const used = payFrom(sources, pay, i);
    dst.bal -= pay;
    log(i, kind, { item: dst.def.id, name: label, amount: pay, from: used.map(u => u.id), tax: sum(used, 'tax') });
    return pay;
  }

  // ---- flows: precompute occurrences by day ----
  const byDay = { income: new Map(), transfer: new Map(), expense: new Map() };
  const push = (map, i, v) => { if (!map.has(i)) map.set(i, []); map.get(i).push(v); };
  const firstDay = addDays(start, 1); // balances are as of the start of `asOf`'s evening; activity on asOf is already in them
  for (const f of plan.flows) {
    const hasTo = !!f.to;
    const hasFrom = (f.from || []).length > 0;
    const phase = hasTo && !hasFrom ? 'income' : hasTo && hasFrom ? 'transfer' : 'expense';
    const ownerAsset = f.whileOwned ? acc.get(f.whileOwned) : null;
    for (const d of occurrences(f.schedule, firstDay, end)) {
      const i = idx(d);
      push(byDay[phase], i, { f, amount: amountAt(f, d), ownerAsset });
    }
  }

  // ---- events by day ----
  const eventsByDay = new Map();
  const ORDER = { buy: 0, sell: 1, liquidate: 2, payoff: 3 };
  for (const e of plan.events) {
    const dates_ = e.type === 'liquidate' && e.schedule ? occurrences(e.schedule, firstDay, end) : [parseYMD(e.date)].filter(d => d && d >= firstDay && d <= end);
    for (const d of dates_) push(eventsByDay, idx(d), e);
  }
  for (const list of eventsByDay.values()) list.sort((a, b) => (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9));

  // ---- scheduled debt payments & payoffs ----
  const debtByDay = new Map();
  for (const dst of debt.values()) {
    const d = dst.def;
    const payoff = parseYMD(d.payoffDate || '');
    const from = dst.startIdx > 0 ? addDays(start, dst.startIdx + 1) : firstDay;
    const last = payoff ? addDays(payoff, -1) : end;
    if (Number(d.payment) > 0) {
      for (const day of occurrences({ freq: 'monthly', start: toYMD(from), dayOfMonth: Number(d.paymentDay) || 1 }, from, last)) {
        push(debtByDay, idx(day), { dst, type: 'payment' });
      }
    }
    if (payoff && payoff >= firstDay && payoff <= end) push(debtByDay, idx(payoff), { dst, type: 'payoff' });
  }

  // ---- record day 0 ----
  const nw = new Float64Array(N);
  const afterTax = new Float64Array(N);
  const cash = new Float64Array(N);
  const accessible = new Float64Array(N);
  const assets = new Float64Array(N);
  const liabilities = new Float64Array(N);

  const propSellPct = (Number(tax.propertySellingCostPct) || 0) / 100;
  function record(i) {
    let A = 0;
    let L = 0;
    let AT = 0;
    let C = 0;
    let AC = 0;
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
    }
    assets[i] = A;
    liabilities[i] = L;
    nw[i] = A - L;
    afterTax[i] = AT - L;
    cash[i] = C;
    accessible[i] = AC;
  }
  record(0);

  // ---- main loop ----
  for (let i = 1; i < N; i++) {
    // 1. growth & interest
    for (const st of acc.values()) if (owned(st, i)) st.qty *= st.dailyGrowth;
    for (const dst of debt.values()) {
      if (i === dst.startIdx && dst.startIdx > 0) {
        dst.bal = Math.max(0, Number(dst.def.balance) || 0);
        if (dst.def.proceedsTo) deposit(dst.def.proceedsTo, dst.bal, i, 0);
        log(i, 'debt-start', { item: dst.def.id, name: dst.def.name, amount: dst.bal });
      } else if (dst.bal > EPS && dst.dailyRate) {
        const interest = dst.bal * dst.dailyRate;
        dst.bal += interest;
        totals.interest += interest;
        dst.interestPaid += interest;
      }
    }

    // 2. income & unit grants
    for (const { f, amount, ownerAsset } of byDay.income.get(i) || []) {
      if (ownerAsset && !owned(ownerAsset, i)) continue;
      const dst = acc.get(f.to);
      const dDebt = debt.get(f.to);
      const price = priceOf(f.unitId, i);
      let units = amount;
      let withheld = 0;
      if (f.withholdPct) { withheld = units * Math.min(100, Number(f.withholdPct)) / 100; units -= withheld; }
      let usd = units * price;
      let taxPaid = withheld * price;
      if (f.taxed === 'ordinary') { taxPaid += usd * ordinary; usd *= 1 - ordinary; }
      totals.taxes += taxPaid;
      if (dst) {
        if (!owned(dst, i) && !dst.isPrimary) continue;
        if (f.unitId && dst.def.unitId === f.unitId) {
          dst.qty += f.taxed === 'ordinary' ? usd / price : units;
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
        const st = acc.get(id);
        if (!st || gross - moved <= EPS) continue;
        if (!owned(st, i) && !st.isPrimary) continue;
        const t = withdrawalTaxRate(st, i, { qualified: f.qualified });
        const g = takeGross(st, gross - moved, i);
        moved += g;
        taxPaid += g * t;
      }
      totals.taxes += taxPaid;
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
      const used = payFrom(f.from, usd, i, { qualified: f.qualified });
      log(i, 'expense', { item: f.id, name: f.name, amount: usd, from: used.map(u => u.id), tax: sum(used, 'tax') });
    }

    // 6. scheduled debt payments
    for (const { dst, type } of debtByDay.get(i) || []) {
      if (type === 'payment') debtPay(dst, Number(dst.def.payment) || 0, dst.def.payFrom, i, `${dst.def.name} payment`);
      else debtPay(dst, dst.bal, dst.def.payFrom, i, `${dst.def.name} payoff`, 'payoff');
    }

    const p = acc.get(primaryId);
    if (p && p.qty < 0) totals.shortfall = Math.max(totals.shortfall, -valueOf(p, i));
    record(i);
  }

  function runEvent(e, i) {
    const d = dates[i];
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
        const loan = debt.get(e.debtId);
        const loanAmt = loan ? loan.bal : 0;
        const cashNeeded = price + closing - loanAmt;
        const used = cashNeeded > 0 ? payFrom(e.from, cashNeeded, i) : [];
        if (cashNeeded < 0) deposit(primaryId, -cashNeeded, i, 0);
        totals.costs += closing;
        log(i, 'buy', { item: e.id, name: e.name || `Buy ${st.def.name}`, amount: price, from: used.map(u => u.id), note: `Down payment + closing ${fmt(Math.max(0, cashNeeded))}` });
        break;
      }
      case 'sell': {
        const st = acc.get(e.assetId);
        if (!st || !owned(st, i)) return;
        const v = e.price != null && e.price !== '' ? Number(e.price) : valueOf(st, i);
        const costs = v * (Number(e.costPct) || 0) / 100 + (Number(e.fixedCost) || 0);
        let proceeds = v - costs;
        totals.costs += costs;
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
        totals.taxes += taxPaid;
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
        totals.taxes += taxPaid;
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
    void d;
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
    series: { netWorth: nw, afterTax, cash, accessible, assets, liabilities },
    accounts: accountsOut,
    debts: debtsOut,
    ledger,
    totals,
    units: Object.fromEntries([...prices].map(([id, arr]) => [id, arr]))
  };
}

// Amount of a flow on a date: dated steps first, then annual escalation from the active step.
export function amountAt(f, d) {
  let base = Number(f.amount) || 0;
  let since = parseYMD(f.schedule?.start) || d;
  for (const st of [...(f.steps || [])].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const sd = parseYMD(st.date);
    if (sd && sd <= d) { base = Number(st.amount) || 0; since = sd; }
  }
  const g = (Number(f.growth) || 0) / 100;
  if (!g) return base;
  const months = (d.getUTCFullYear() - since.getUTCFullYear()) * 12 + (d.getUTCMonth() - since.getUTCMonth());
  return base * (1 + g) ** Math.max(0, months / 12);
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
