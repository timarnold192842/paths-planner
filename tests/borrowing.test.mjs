import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYMD } from '../src/engine/dates.js';
import { compile } from '../src/engine/compile.js';
import { simulate, attributionUpTo } from '../src/engine/simulate.js';
import { normalizePlan } from '../src/engine/model.js';
import { demoPlan } from '../src/demo.js';

const D = parseYMD;
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (±${tol})`);
const at = (run, ymd) => Math.round((D(ymd) - D(run.start)) / 86400000);
const plan = extra => normalizePlan({
  name: 'T', asOf: '2026-01-01', horizonYears: 3,
  settings: { cashFloor: 0, inflation: 0, tax: { enabled: false } },
  accounts: [{ id: 'cash', name: 'Cash', kind: 'cash', balance: 20000 }],
  ...extra
});
const run = p => simulate(compile(p, 'baseline').plan);

test('0% promo card: fee added to balance, minimum payments, no interest during promo, payoff at the end', () => {
  const r = run(plan({ debts: [{
    id: 'card', name: 'Promo card', balance: 10000, start: '2026-02-01', proceedsTo: 'cash', feePct: 3,
    rate: 0, rateSteps: [{ date: '2027-02-01', rate: 24.99 }], paymentRule: 'minimum', minPct: 1, payment: 35, paymentDay: 15,
    payoffDate: '2027-01-31'
  }] }));
  near(r.accounts.cash[at(r, '2026-02-01')], 30000);
  near(r.debts.card[at(r, '2026-02-01')], 10300);
  assert.equal(r.totals.interest, 0);
  near(r.totals.costs, 300);
  assert.equal(r.debts.card[at(r, '2027-01-31')], 0);
  // 30,000 − the full 10,300 repaid = 19,700
  near(r.accounts.cash[at(r, '2027-01-31')], 19700);
  const pays = r.ledger.filter(l => l.item === 'card' && l.kind === 'debt-payment');
  assert.equal(pays.length, 12);
  assert.ok(pays[0].amount >= 103 - 0.01 && pays[0].amount <= 103 + 0.01, `first minimum ${pays[0].amount}`);
});

test('balance transfer: proceeds pay off another debt', () => {
  const r = run(plan({ debts: [
    { id: 'old', name: 'Old card', balance: 5000, rate: 22, payment: 0 },
    { id: 'new', name: 'Transfer card', balance: 5000, start: '2026-03-01', proceedsTo: 'old', feePct: 3, rate: 0, payment: 0 }
  ] }));
  // The old card kept accruing 22% for two months, so a fixed $5,000 transfer leaves a remainder.
  const left = r.debts.old[at(r, '2026-03-01')];
  assert.ok(left > 150 && left < 200, `remainder ${left}`);
  near(r.debts.new[at(r, '2026-03-01')], 5150);
  near(r.accounts.cash[at(r, '2026-03-01')], 20000);
});

test('balance transfer of the whole balance, whatever it is on the day', () => {
  const r = run(plan({ debts: [
    { id: 'old', name: 'Old card', balance: 5000, rate: 22, payment: 0 },
    { id: 'new', name: 'Transfer card', start: '2026-03-01', proceedsTo: 'old', transferAll: true, feePct: 3, rate: 0, payment: 0 }
  ] }));
  assert.equal(r.debts.old[at(r, '2026-03-01')], 0);
  // Interest accrues on the old card the morning of the transfer, then the whole balance moves.
  const owed = r.debts.old[at(r, '2026-02-28')] * (1 + 0.22 / 365.25);
  near(r.debts.new[at(r, '2026-03-01')], owed * 1.03, 0.05);
});

test('amortizing loan is paid off by the end of its term, even after a rate change', () => {
  const r = run(plan({ debts: [{ id: 'loan', name: 'Loan', balance: 12000, start: '2026-01-15', proceedsTo: 'cash', rate: 12, rateSteps: [{ date: '2026-07-01', rate: 6 }], paymentRule: 'amortize', termMonths: 12, paymentDay: 15 }] }));
  assert.ok(r.debts.loan[at(r, '2027-01-16')] < 1, `left ${r.debts.loan[at(r, '2027-01-16')]}`);
  assert.ok(r.totals.interest > 300 && r.totals.interest < 800, `interest ${r.totals.interest}`);
});

test('a credit line as a safety net keeps cash at zero instead of negative, and charges interest-only payments', () => {
  const p = plan({
    debts: [{ id: 'heloc', name: 'HELOC', balance: 0, creditLimit: 100000, rate: 8, paymentRule: 'interestOnly', paymentDay: 1 }],
    flows: [{ id: 'roof', name: 'Roof', amount: 50000, schedule: { freq: 'once', start: '2026-03-10' } }]
  });
  p.settings.safetyNet = ['heloc'];
  const r = run(p);
  assert.equal(r.accounts.cash[at(r, '2026-03-10')], 0);
  near(r.debts.heloc[at(r, '2026-03-10')], 30000);
  // Interest-only: balance stays at the drawn amount; cash pays the interest, re-drawing as needed.
  const ip = r.ledger.find(l => l.item === 'heloc' && l.kind === 'debt-payment');
  assert.ok(ip && ip.amount > 100 && ip.amount < 160, `first interest payment ${ip?.amount}`);
  // A line can't pay itself: with no income, interest payments come out of cash, which goes
  // negative by exactly the interest paid; the HELOC balance stays at the drawn $30k.
  near(Math.min(...r.series.cash), -r.totals.interest, 1);
  near(r.debts.heloc[r.N - 1], 30000, 1);
  near(r.series.creditAvailable[at(r, '2026-03-10')], 70000);
});

test('drawing from a credit line deliberately (transfer from a debt)', () => {
  const r = run(plan({
    debts: [{ id: 'heloc', name: 'HELOC', balance: 0, creditLimit: 40000, rate: 7, paymentRule: 'interestOnly' }],
    flows: [{ id: 'draw', name: 'Draw', amount: 25000, schedule: { freq: 'once', start: '2026-02-01' }, from: ['heloc'], to: 'cash' },
            { id: 'draw2', name: 'Draw again', amount: 25000, schedule: { freq: 'once', start: '2026-02-02' }, from: ['heloc'], to: 'cash' }]
  }));
  near(r.debts.heloc[at(r, '2026-02-02')], 40000, 10);
  near(r.accounts.cash[at(r, '2026-02-02')], 60000, 10);
});

test('attribution adds up to the change in net worth and leaves nothing unexplained for the demo plan', () => {
  const p = normalizePlan(demoPlan());
  for (const s of p.scenarios) {
    const r = simulate(compile(p, s.id).plan, { ledger: false });
    const totals = attributionUpTo(r, r.attribution.years);
    let sum = 0;
    let other = 0;
    for (const b of totals.values()) { sum += b.total; if (b.kind === 'other') other += b.total; }
    const change = r.series.netWorth[r.N - 1] - r.series.netWorth[0];
    near(sum, change, 1);
    assert.ok(Math.abs(other) < 1, `${s.name}: unexplained ${other}`);
    const kinds = new Set([...totals.values()].map(b => b.kind));
    for (const k of ['income', 'spending', 'taxes', 'interest', 'growth']) assert.ok(kinds.has(k), `${s.name} has ${k}`);
  }
});

test('review fixes: amortization over the real term, safety net on transfers, no self-pay, closed lines, enabled patches', () => {
  // amortize: 36 payments of the standard amount, counted from the loan's real start
  const a = run(plan({ asOf: '2026-01-01', horizonYears: 5, debts: [{ id: 'l', name: 'Loan', balance: 10000, start: '2026-03-01', proceedsTo: 'cash', rate: 9.5, paymentRule: 'amortize', termMonths: 36, paymentDay: 1 }] }));
  const pays = a.ledger.filter(x => x.item === 'l' && x.kind === 'debt-payment');
  assert.equal(pays.length, 36);
  near(pays[0].amount, 320.33, 0.6);

  // transfer out of cash uses the safety net before cash goes negative
  const t = plan({
    accounts: [{ id: 'cash', name: 'Cash', kind: 'cash', balance: 1000 }, { id: 'b', name: 'Brokerage', kind: 'brokerage', balance: 0 }],
    debts: [{ id: 'h', name: 'HELOC', balance: 0, creditLimit: 50000, rate: 0, paymentRule: 'interestOnly' }],
    flows: [{ id: 'x', name: 'Invest', amount: 5000, schedule: { freq: 'once', start: '2026-02-01' }, from: ['cash'], to: 'b' }]
  });
  t.settings.safetyNet = ['h'];
  const tr = run(t);
  assert.equal(tr.accounts.cash[at(tr, '2026-02-01')], 0);
  near(tr.debts.h[at(tr, '2026-02-01')], 4000);

  // a credit line in the safety net can't pay itself off
  const sp = plan({
    accounts: [{ id: 'cash', name: 'Cash', kind: 'cash', balance: 0 }],
    debts: [{ id: 'h', name: 'HELOC', balance: 40000, creditLimit: 100000, rate: 0, payment: 0, payoffDate: '2026-06-01' }]
  });
  sp.settings.safetyNet = ['h'];
  const spr = run(sp);
  assert.equal(spr.debts.h[at(spr, '2026-06-01')], 0);
  near(spr.accounts.cash[at(spr, '2026-06-01')], -40000);

  // a line secured by a home closes when the home is sold
  const cl = plan({
    accounts: [{ id: 'cash', name: 'Cash', kind: 'cash', balance: 0 }, { id: 'home', name: 'Home', kind: 'property', balance: 300000 }],
    debts: [{ id: 'h', name: 'HELOC', balance: 0, creditLimit: 100000, rate: 0, paymentRule: 'interestOnly', securedBy: 'home' }],
    events: [{ id: 's', type: 'sell', assetId: 'home', date: '2026-03-01', costPct: 0, price: 300000 }],
    flows: [{ id: 'big', name: 'Big bill', amount: 400000, schedule: { freq: 'once', start: '2026-04-01' } }]
  });
  cl.settings.safetyNet = ['h'];
  const clr = run(cl);
  assert.equal(clr.debts.h[at(clr, '2026-04-01')], 0, 'no draw against a sold home');
  near(clr.accounts.cash[at(clr, '2026-04-01')], 300000 - 400000);

  // switching a debt off in a scenario tweak works
  const en = plan({ debts: [{ id: 'car', name: 'Car', balance: 9000, rate: 5, payment: 300 }], scenarios: [{ id: 'baseline', name: 'Baseline' }, { id: 'off', name: 'Off', patches: [{ id: 'car', field: 'enabled', value: false }] }] });
  const off = simulate(compile(en, 'off').plan);
  assert.equal(off.series.liabilities[0], 0);
  assert.equal(compile(en, 'off').diagnostics.filter(d => d.code === 'stale-patch').length, 0);
});

test('a purchase dated before the as-of date has already happened: balances are kept as entered', () => {
  const p = plan({
    asOf: '2026-11-09',
    accounts: [{ id: 'cash', name: 'Cash', kind: 'cash', balance: 0 }, { id: 'home', name: 'Home', kind: 'property', balance: 510000, growth: 0 }],
    debts: [{ id: 'm', name: 'Mortgage', balance: 397000, rate: 0, payment: 0 }],
    events: [{ id: 'b', type: 'buy', assetId: 'home', debtId: 'm', date: '2026-03-01', price: 500000, loanAmount: 400000 }]
  });
  const r = run(p);
  assert.equal(r.accounts.home[0], 510000);
  assert.equal(r.debts.m[0], 397000);
  assert.equal(r.series.netWorth[0], 113000);
});

test('check-in moves scenario-only loans whose dates passed to tomorrow, so they still start with their money', async () => {
  const { rebaseline } = await import('../src/engine/rebaseline.js');
  const { addMonths, toYMD } = await import('../src/engine/dates.js');
  const p = normalizePlan(demoPlan());
  const later = toYMD(addMonths(D(p.asOf), 4));
  const before = simulate(compile(p, 'baseline').plan, { ledger: false });
  const i = Math.round((D(later) - D(p.asOf)) / 86400000);
  const balances = {};
  for (const a of compile(p, 'baseline').plan.accounts) balances[a.id] = before.accounts[a.id][i] / (a.unitId ? before.units[a.unitId][i] : 1);
  for (const d of compile(p, 'baseline').plan.debts) balances[d.id] = before.debts[d.id][i];
  const { plan: q, shifted, passed } = rebaseline(p, { balances }, later);
  assert.equal(q.asOf, later);
  assert.deepEqual(shifted.map(x => x.id).sort(), ['heloc', 'payoff-car', 'promo-card']);
  assert.ok(passed.some(x => x.id === 'remodel') === false, 'flows are not events');
  const base = simulate(compile(q, 'baseline').plan, { ledger: false });
  const heloc = simulate(compile(q, 's-heloc').plan, { ledger: false });
  near(heloc.series.netWorth[0], base.series.netWorth[0], 1);
  near(heloc.debts.heloc[1], 45000, 1);
});
