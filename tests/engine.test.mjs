import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occurrences } from '../src/engine/schedule.js';
import { parseYMD, toYMD } from '../src/engine/dates.js';
import { pricePath } from '../src/engine/prices.js';
import { compile, scenarioDiff } from '../src/engine/compile.js';
import { simulate, amountAt } from '../src/engine/simulate.js';
import { normalizePlan } from '../src/engine/model.js';
import { runScenario, compareRuns, crossovers, stressTest } from '../src/engine/metrics.js';

const D = parseYMD;
const ymds = list => list.map(toYMD);
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (±${tol})`);

// ---------- schedules ----------
test('monthly schedules clamp to month end and respect the window', () => {
  assert.deepEqual(ymds(occurrences({ freq: 'monthly', start: '2026-01-31' }, D('2026-01-01'), D('2026-04-30'))),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual(ymds(occurrences({ freq: 'monthly', start: '2026-01-10', dayOfMonth: 1 }, D('2026-01-01'), D('2026-03-31'))),
    ['2026-02-01', '2026-03-01']);
});

test('twice-a-month, weekly, every-2-weeks, quarterly, yearly and daily', () => {
  assert.deepEqual(ymds(occurrences({ freq: 'semimonthly', start: '2026-02-01', days: [15, 'last'] }, D('2026-02-01'), D('2026-03-31'))),
    ['2026-02-15', '2026-02-28', '2026-03-15', '2026-03-31']);
  assert.deepEqual(ymds(occurrences({ freq: 'weekly', start: '2026-11-04', weekday: 5 }, D('2026-11-01'), D('2026-11-20'))),
    ['2026-11-06', '2026-11-13', '2026-11-20']);
  assert.deepEqual(ymds(occurrences({ freq: 'biweekly', start: '2026-01-02' }, D('2026-01-20'), D('2026-02-28'))),
    ['2026-01-30', '2026-02-13', '2026-02-27']);
  assert.deepEqual(ymds(occurrences({ freq: 'quarterly', start: '2026-01-01' }, D('2026-01-01'), D('2026-12-31'))),
    ['2026-01-01', '2026-04-01', '2026-07-01', '2026-10-01']);
  assert.deepEqual(ymds(occurrences({ freq: 'annual', start: '2026-03-22', month: 10, dayOfMonth: 1 }, D('2026-01-01'), D('2028-12-31'))),
    ['2026-10-01', '2027-10-01', '2028-10-01']);
  assert.equal(occurrences({ freq: 'daily', start: '2026-01-01', end: '2026-01-10' }, D('2026-01-05'), D('2027-01-01')).length, 6);
  assert.deepEqual(ymds(occurrences({ freq: 'once', start: '2026-05-05' }, D('2026-01-01'), D('2026-12-31'))), ['2026-05-05']);
});

test('amount steps and annual escalation', () => {
  const f = { amount: 2000, growth: 10, schedule: { start: '2026-01-01' }, steps: [{ date: '2027-09-01', amount: 500 }] };
  assert.equal(amountAt(f, D('2026-01-01')), 2000);
  near(amountAt(f, D('2027-01-01')), 2200);
  assert.equal(amountAt(f, D('2027-09-01')), 500);
  near(amountAt(f, D('2028-09-01')), 550);
});

// ---------- prices ----------
test('price paths interpolate between targets and compound after the last one', () => {
  const unit = { price: 10, growth: 10, paths: { mid: [{ date: '2027-01-01', price: 20 }, { date: '2028-01-01', price: 40 }] } };
  const p = pricePath(unit, 'mid', '2026-01-01');
  assert.equal(p(D('2026-01-01')), 10);
  near(p(D('2026-07-02')), 15, 0.05);
  near(p(D('2027-07-02')), 30, 0.1);
  near(p(D('2029-01-01')), 44, 0.05);
  assert.equal(pricePath({ price: 7 }, null, '2026-01-01')(D('2040-01-01')), 7);
});

// ---------- fixtures ----------
function basePlan(extra = {}) {
  return normalizePlan({
    name: 'Test',
    asOf: '2026-01-01',
    horizonYears: 5,
    settings: { cashFloor: 10000, inflation: 0, tax: { enabled: true, ordinary: 20, ltcg: 10, state: 0, birthDate: '1980-01-01', residenceExclusion: 0, propertySellingCostPct: 0 } },
    accounts: [{ id: 'cash', name: 'Cash', kind: 'cash', balance: 50000 }],
    ...extra
  });
}
const valueOn = (run, id, ymd) => run.accounts[id][Math.round((D(ymd) - D(run.start)) / 86400000)];
const seriesOn = (run, key, ymd) => run.series[key][Math.round((D(ymd) - D(run.start)) / 86400000)];

// ---------- compile ----------
test('items can belong to several alternatives; decisions are ANDed', () => {
  const plan = basePlan({
    decisions: [
      { id: 'house', name: 'House', defaultAlt: 'keep', alternatives: [{ id: 'keep', name: 'Keep' }, { id: 'rent', name: 'Rent' }, { id: 'sell', name: 'Sell' }] },
      { id: 'loan', name: 'Loan', defaultAlt: 'normal', alternatives: [{ id: 'normal', name: 'Normal' }, { id: 'early', name: 'Early' }] }
    ],
    flows: [
      { id: 'tax', name: 'Property tax', amount: 100, schedule: { freq: 'monthly', start: '2026-01-15' }, when: { house: ['keep', 'rent'] } },
      { id: 'combo', name: 'Only rent + early', amount: 1, schedule: { freq: 'once', start: '2026-02-01' }, when: { house: ['rent'], loan: ['early'] } }
    ],
    scenarios: [
      { id: 'baseline', name: 'Baseline' },
      { id: 'sell', name: 'Sell', choices: { house: 'sell' } },
      { id: 'rentEarly', name: 'Rent + early', choices: { house: 'rent', loan: 'early' } }
    ]
  });
  assert.deepEqual(compile(plan, 'baseline').plan.flows.map(f => f.id), ['tax']);
  assert.deepEqual(compile(plan, 'sell').plan.flows.map(f => f.id), []);
  assert.deepEqual(compile(plan, 'rentEarly').plan.flows.map(f => f.id), ['tax', 'combo']);
});

test('conflicting patches and stale references are reported, and inheritance works', () => {
  const plan = basePlan({
    debts: [{ id: 'mort', name: 'Mortgage', balance: 1000, rate: 0, payment: 10 }],
    decisions: [
      { id: 'a', name: 'A', defaultAlt: 'x', alternatives: [{ id: 'x', name: 'X', patches: [{ id: 'mort', field: 'payoffDate', value: '2027-01-01' }] }] },
      { id: 'b', name: 'B', defaultAlt: 'y', alternatives: [{ id: 'y', name: 'Y', patches: [{ id: 'mort', field: 'payoffDate', value: '2028-01-01' }, { id: 'gone', field: 'amount', value: 1 }] }] }
    ],
    scenarios: [
      { id: 'baseline', name: 'Baseline' },
      { id: 'child', name: 'Child', basedOn: 'baseline', patches: [{ id: 'mort', field: 'payment', value: 99 }] },
      { id: 'loop1', name: 'L1', basedOn: 'loop2' },
      { id: 'loop2', name: 'L2', basedOn: 'loop1' }
    ]
  });
  const c = compile(plan, 'child');
  assert.equal(c.plan.debts[0].payoffDate, '2028-01-01');
  assert.equal(c.plan.debts[0].payment, 99);
  assert.ok(c.diagnostics.some(d => d.code === 'conflict'));
  assert.ok(c.diagnostics.some(d => d.code === 'stale-patch'));
  assert.ok(compile(plan, 'loop1').diagnostics.some(d => d.code === 'cycle'));
  assert.deepEqual(scenarioDiff(plan, 'baseline', 'child').map(l => l.kind), ['tweak']);
});

// ---------- simulate ----------
test('cash grows daily-compounded and expenses reduce it', () => {
  const plan = basePlan({
    accounts: [{ id: 'cash', name: 'Cash', kind: 'cash', balance: 10000, growth: 10 }],
    flows: [{ id: 'rent', name: 'Rent', amount: 1000, schedule: { freq: 'monthly', start: '2026-01-01' } }]
  });
  const run = simulate(compile(plan, 'baseline').plan);
  near(valueOn(run, 'cash', '2026-01-01'), 10000);
  // 12 payments in 2026 after Jan 1 (Feb..Dec = 11) plus growth; just sanity-check direction and magnitude.
  const v = valueOn(run, 'cash', '2026-12-31');
  assert.ok(v < 10000 * 1.1 - 11000 + 600 && v > 10000 * 1.1 - 11000 - 600, `cash ${v}`);
});

test('waterfall: college paid from the 529 first, then cash; qualified withdrawals are tax-free; money is conserved', () => {
  const plan = basePlan({
    accounts: [
      { id: 'cash', name: 'Cash', kind: 'cash', balance: 100000 },
      { id: '529', name: 'Kid 529', kind: 'education', balance: 30000, costBasis: 20000 }
    ],
    flows: [{ id: 'college', name: 'College', amount: 25000, schedule: { freq: 'annual', start: '2026-09-01' }, from: ['529'], qualified: 'education' }]
  });
  const run = simulate(compile(plan, 'baseline').plan);
  near(valueOn(run, '529', '2026-09-01'), 5000);
  near(valueOn(run, 'cash', '2026-09-01'), 100000);
  near(valueOn(run, '529', '2027-09-01'), 0);
  near(valueOn(run, 'cash', '2027-09-01'), 80000);
  assert.equal(run.totals.taxes, 0);
  // The 529 never goes negative.
  assert.ok(Math.min(...run.accounts['529']) >= -1e-6);
});

test('non-qualified traditional withdrawals are grossed up for income tax and the early penalty', () => {
  const plan = basePlan({
    accounts: [
      { id: 'cash', name: 'Cash', kind: 'cash', balance: 0 },
      { id: 'ira', name: 'IRA', kind: 'traditional', balance: 100000 }
    ],
    flows: [{ id: 'roof', name: 'Roof', amount: 7000, schedule: { freq: 'once', start: '2026-06-01' }, from: ['ira'] }]
  });
  const run = simulate(compile(plan, 'baseline').plan);
  // age 46 → 20% ordinary + 10% penalty → need 7000 / 0.7 = 10000 gross
  near(valueOn(run, 'ira', '2026-06-01'), 90000);
  near(valueOn(run, 'cash', '2026-06-01'), 0);
  near(run.totals.taxes, 3000);
});

test('selling a property pays its mortgage, taxes the gain, and stops its carrying costs', () => {
  const plan = basePlan({
    accounts: [
      { id: 'cash', name: 'Cash', kind: 'cash', balance: 10000 },
      { id: 'house', name: 'House', kind: 'property', balance: 400000, costBasis: 300000 }
    ],
    debts: [{ id: 'mort', name: 'Mortgage', balance: 250000, rate: 0, payment: 0, securedBy: 'house' }],
    flows: [{ id: 'ptax', name: 'Property tax', amount: 500, schedule: { freq: 'monthly', start: '2026-01-15' }, whileOwned: 'house' }],
    events: [{ id: 'sale', type: 'sell', assetId: 'house', date: '2026-06-01', costPct: 6 }]
  });
  const run = simulate(compile(plan, 'baseline').plan);
  // costs 24,000 → proceeds 376,000; mortgage 250,000; gain 400k−24k−300k = 76,000 → tax 7,600
  const before = valueOn(run, 'cash', '2026-05-31');
  near(valueOn(run, 'cash', '2026-06-01') - before, 376000 - 250000 - 7600);
  assert.equal(valueOn(run, 'house', '2026-06-01'), 0);
  assert.equal(run.debts.mort[Math.round((D('2026-06-01') - D('2026-01-01')) / 86400000)], 0);
  const ptax = run.ledger.filter(l => l.item === 'ptax').map(l => l.date);
  assert.deepEqual(ptax, ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15']);
});

test('equity: vests add shares at vest-price basis (net of withholding); dollar liquidations tax only the gain', () => {
  const plan = basePlan({
    units: [{ id: 'aur', name: 'AUR', price: 10, paths: { base: [{ date: '2027-01-01', price: 20 }] }, assumptionId: 'px' }],
    assumptions: [{ id: 'px', name: 'AUR price', defaultCase: 'base', cases: [{ id: 'base', name: 'Base' }] }],
    accounts: [
      { id: 'cash', name: 'Cash', kind: 'cash', balance: 0 },
      { id: 'stock', name: 'AUR', kind: 'equity', unitId: 'aur', balance: 1000, costBasis: 10000 }
    ],
    flows: [{ id: 'vest', name: 'RSU', amount: 100, unitId: 'aur', withholdPct: 30, schedule: { freq: 'once', start: '2026-07-02' }, to: 'stock' }],
    events: [{ id: 'pull', type: 'liquidate', assetId: 'stock', mode: 'usd', amount: 4000, schedule: { freq: 'once', start: '2027-01-01' } }]
  });
  const run = simulate(compile(plan, 'baseline').plan);
  // Vest on ~Jul 2 at ≈ $15: 70 shares, basis += ~1,050
  const sharesAfterVest = valueOn(run, 'stock', '2026-07-02') / run.units.aur[Math.round((D('2026-07-02') - D('2026-01-01')) / 86400000)];
  near(sharesAfterVest, 1070, 0.001);
  // Sell $4,000 at $20 = 200 shares. Avg basis ≈ (10000+1050)/1070 ≈ 10.33/share → gain ≈ 1934 → tax ≈ 193
  const cashGot = valueOn(run, 'cash', '2027-01-01');
  assert.ok(cashGot > 3790 && cashGot < 3820, `net proceeds ${cashGot}`);
  near(valueOn(run, 'stock', '2027-01-01') / 20, 870, 0.001);
});

test('debts amortize with payments, stop at zero, and pay off on the payoff date', () => {
  const plan = basePlan({
    debts: [
      { id: 'small', name: 'Small', balance: 250, rate: 0, payment: 100, paymentDay: 5 },
      { id: 'big', name: 'Big', balance: 10000, rate: 0, payment: 100, paymentDay: 1, payoffDate: '2026-04-01' }
    ]
  });
  const run = simulate(compile(plan, 'baseline').plan);
  const i = ymd => Math.round((D(ymd) - D('2026-01-01')) / 86400000);
  assert.equal(run.debts.small[i('2026-04-01')], 0);
  near(valueOn(run, 'cash', '2026-04-01'), 50000 - 250 - 10000);
  assert.equal(run.debts.big[i('2026-04-01')], 0);
});

test('a buy event activates a pre-declared asset and mortgage', () => {
  const plan = basePlan({
    accounts: [
      { id: 'cash', name: 'Cash', kind: 'cash', balance: 200000 },
      { id: 'newhome', name: 'New home', kind: 'property', balance: 0, growth: 0 }
    ],
    debts: [{ id: 'newmort', name: 'New mortgage', balance: 0, rate: 0, payment: 1000, paymentDay: 1 }],
    flows: [{ id: 'ins', name: 'Insurance', amount: 100, schedule: { freq: 'monthly', start: '2026-01-10' }, whileOwned: 'newhome' }],
    events: [{ id: 'b', type: 'buy', assetId: 'newhome', debtId: 'newmort', date: '2026-03-01', price: 500000, closingPct: 2, loanAmount: 400000 }]
  });
  const run = simulate(compile(plan, 'baseline').plan);
  assert.equal(valueOn(run, 'newhome', '2026-02-28'), 0);
  near(valueOn(run, 'newhome', '2026-03-01'), 500000);
  near(valueOn(run, 'cash', '2026-03-01'), 200000 - 110000);
  assert.deepEqual(run.ledger.filter(l => l.item === 'ins').map(l => l.date).slice(0, 2), ['2026-03-10', '2026-04-10']);
  near(valueOn(run, 'cash', '2026-04-10'), 90000 - 1000 - 100 - 100);
});

test('only the primary cash account can go negative; shortfalls are measured', () => {
  const plan = basePlan({
    accounts: [{ id: 'cash', name: 'Cash', kind: 'cash', balance: 1000 }, { id: 'b', name: 'Brokerage', kind: 'brokerage', balance: 500 }],
    flows: [{ id: 'x', name: 'Big bill', amount: 5000, schedule: { freq: 'once', start: '2026-02-01' }, from: ['b'] }]
  });
  const r = runScenario(plan, 'baseline');
  near(valueOn(r.run, 'b', '2026-02-01'), 0);
  near(valueOn(r.run, 'cash', '2026-02-01'), 1000 - 4500);
  assert.equal(r.metrics.firstNegative, '2026-02-01');
  near(r.metrics.minCash.value, -3500);
});

// ---------- compare ----------
test('crossovers report first and last sign changes; verdict and stress test run', () => {
  const dates = [0, 1, 2, 3, 4].map(n => D(`2026-01-0${n + 1}`));
  const cross = crossovers([0, 0, 0, 0, 0], [-5000, 5000, -5000, 5000, 5000], dates);
  assert.deepEqual(cross.map(c => c.direction), ['ahead', 'behind', 'ahead']);

  const plan = basePlan({
    accounts: [{ id: 'cash', name: 'Cash', kind: 'cash', balance: 20000, growth: 4 }],
    flows: [{ id: 'pay', name: 'Paycheck', amount: 600, schedule: { freq: 'monthly', start: '2026-01-15' }, to: 'cash' }],
    debts: [{ id: 'loan', name: 'Loan', balance: 15000, rate: 12, payment: 500 }],
    decisions: [{ id: 'd', name: 'Loan', defaultAlt: 'n', alternatives: [{ id: 'n', name: 'Normal' }, { id: 'e', name: 'Pay off now', patches: [{ id: 'loan', field: 'payoffDate', value: '2026-01-02' }] }] }],
    assumptions: [{ id: 'r', name: 'Rates', defaultCase: 'lo', cases: [{ id: 'lo', name: 'Low', patches: [] }, { id: 'hi', name: 'High', patches: [{ id: 'cash', field: 'growth', value: 15 }] }] }],
    scenarios: [{ id: 'baseline', name: 'Baseline' }, { id: 'early', name: 'Pay off', choices: { d: 'e' } }]
  });
  const a = runScenario(plan, 'baseline');
  const b = runScenario(plan, 'early');
  const [cmp] = compareRuns(a, [b], plan, 'netWorth');
  assert.ok(cmp.endDelta > 0, 'paying off a 12% loan with 4% cash wins long-term');
  assert.ok(cmp.liquidityDelta < 0, 'but near-term cash is lower');
  const st = stressTest(plan, ['baseline', 'early'], 'r', 'baseline', 'netWorth');
  assert.equal(st.rows.length, 2);
  assert.ok(st.rows[1].cells[1].delta < st.rows[0].cells[1].delta, 'early payoff wins by less when cash earns 15%');
});
