import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYMD } from '../src/engine/dates.js';
import { compile } from '../src/engine/compile.js';
import { simulate, attributionUpTo } from '../src/engine/simulate.js';
import { normalizePlan } from '../src/engine/model.js';
import { rebaseline } from '../src/engine/rebaseline.js';
import { paycheck, newYtd, federalIncomeTax, wageIncomeTax, payPreview, suggestedFedPct, PAYROLL } from '../src/engine/payroll.js';

const D = parseYMD;
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (±${tol})`);
const at = (run, ymd) => Math.round((D(ymd) - D(run.start)) / 86400000);
const plan = extra => normalizePlan({
  name: 'T', asOf: '2025-12-31', horizonYears: 3,
  settings: { cashFloor: 0, inflation: 0, tax: { enabled: true, filing: 'mfj', ordinary: 24, ltcg: 15, state: 0 } },
  accounts: [{ id: 'cash', name: 'Cash', kind: 'cash', balance: 20000 }, { id: 'k', name: '401(k)', kind: 'traditional', balance: 0 }],
  ...extra
});
const run = p => simulate(compile(p, 'baseline').plan);
const salary = (pay, extra = {}) => ({ id: 'pay', name: 'Salary', amount: 10000, schedule: { freq: 'semimonthly', start: '2026-01-01', days: [15, 'last'] }, to: 'cash', from: [], pay: { employer: 'Acme', fica: true, fedPct: 15, statePct: 0, deductions: [], ...pay }, ...extra });
const paychecks = (r, year = '2026') => r.ledger.filter(l => l.item === 'pay' && l.kind === 'income' && l.date.startsWith(year));

test('2026 federal brackets (MFJ and single)', () => {
  near(federalIncomeTax(24800, 'mfj', 2026, 0).tax, 2480);
  // 10% of 24,800 + 12% of 76,000 + 22% of 50,000
  near(federalIncomeTax(150800, 'mfj', 2026, 0).tax, 2480 + 9120 + 11000);
  assert.equal(federalIncomeTax(150800, 'mfj', 2026, 0).marginal, 0.22);
  near(federalIncomeTax(12400, 'single', 2026, 0).tax, 1240);
  // standard deduction comes off first
  near(wageIncomeTax(32200, 'mfj', 2026, 0).tax, 0);
  // indexed for later years
  near(federalIncomeTax(24800 * 1.03, 'mfj', 2027, 3).tax, 2480 * 1.03);
});

test('Social Security stops at the wage base each year; Medicare never stops; take-home steps up', () => {
  const ytd = newYtd();
  let ss = 0;
  const nets = [];
  for (let k = 0; k < 24; k++) {
    const r = paycheck({ fica: true, fedPct: 0 }, 10000, ytd, { year: 2026, inflation: 0 });
    ss += r.ss;
    nets.push(r.net);
    near(r.medicare, 145);
  }
  near(ss, PAYROLL.ssWageBase * 0.062);
  // paycheck 19 straddles the base (184,500 − 180,000 = 4,500 taxed), 20+ have none
  near(nets[0], 10000 - 620 - 145);
  near(nets[18], 10000 - 4500 * 0.062 - 145);
  // additional 0.9% Medicare on wages above $200k (from the 21st paycheck on)
  near(nets[19], 10000 - 145);
  near(nets[20], 10000 - 145 - 90);
  near(nets[23], 10000 - 145 - 90);
});

test('simulated paychecks: wage base resets on January 1st and is shared by paychecks from the same employer', () => {
  const r = run(plan({ flows: [salary({})] }));
  const y1 = paychecks(r, '2026');
  assert.equal(y1.length, 24);
  assert.ok(y1[0].note.includes('SS $620'), y1[0].note);
  assert.ok(!y1[23].note.includes('SS '), 'no Social Security late in the year');
  assert.ok(y1[23].amount > y1[0].amount, 'take-home rises once the wage base is reached');
  const y2 = paychecks(r, '2027');
  assert.ok(y2[0].note.includes('SS $620'), 'resets in January');

  // A big stock vest from the same employer uses up the wage base sooner
  const withVest = run(plan({
    units: [{ id: 'acme', name: 'Acme', symbol: 'AC', price: 100, growth: 0, paths: {} }],
    accounts: [{ id: 'cash', name: 'Cash', kind: 'cash', balance: 20000 }, { id: 'sh', name: 'Shares', kind: 'equity', unitId: 'acme', balance: 0 }],
    flows: [salary({}), { id: 'vest', name: 'Vest', amount: 1000, unitId: 'acme', schedule: { freq: 'once', start: '2026-02-01' }, to: 'sh', from: [], pay: { employer: ' acme ', fica: true, fedPct: 22, statePct: 0 } }]
  }));
  const first = paychecks(withVest, '2026');
  const vest = withVest.ledger.find(l => l.item === 'vest');
  near(vest.tax, 100000 * (0.062 + 0.0145 + 0.22));
  const lastWithSS = first.filter(l => l.note.includes('SS ')).length;
  assert.equal(lastWithSS, 9, 'salary loses Social Security after 20k + 100k vest + 9 × 10k ≥ 184.5k');
  // shares withheld to cover taxes
  near(withVest.accounts.sh[at(withVest, '2026-02-01')], 100000 * (1 - 0.062 - 0.0145 - 0.22));
});

test('payroll deductions: pre-tax 401(k) stops at its annual limit, employer adds a match, others leave pay', () => {
  const r = run(plan({ flows: [salary({ deductions: [
    { id: 'k', name: '401(k)', pct: 15, to: 'k', pretax: true, annualLimit: 24500, employerPct: 4 },
    { id: 'med', name: 'Health insurance', amount: 300, pretax: true }
  ] })] }));
  const k = r.accounts.k;
  // 15% of 10k = 1,500/paycheck → limit after 16 paychecks + 500; match 400/paycheck while contributing
  near(k[at(r, '2026-12-31')], 24500 + 400 * 17, 1);
  near(k[at(r, '2027-01-15')] - k[at(r, '2026-12-31')], 1500 + 400, 1);
  const p = paychecks(r);
  // first paycheck: taxable = 10,000 − 1,500 − 300 = 8,200 → 15% fed
  near(p[0].tax, 620 + 145 + 8200 * 0.15);
  near(p[0].amount, 10000 - (620 + 145 + 8200 * 0.15) - 1500 - 300);
  // attribution still explains every dollar
  const other = [...attributionUpTo(r, 3).values()].filter(b => b.kind === 'other').reduce((s, b) => s + b.total, 0);
  near(other, 0, 1);
});

test('cafeteria-plan deductions (HSA, health premiums) also skip Social Security and Medicare', () => {
  const ytd = newYtd();
  const r = paycheck({ fica: true, fedPct: 10, deductions: [
    { id: 'k', name: '401(k)', pct: 10, pretax: true },
    { id: 'h', name: 'Health', amount: 500, pretax: true, ficaExempt: true }
  ] }, 10000, ytd, { year: 2026 });
  near(r.ss, 9500 * 0.062);
  near(r.medicare, 9500 * 0.0145);
  near(r.fed, (10000 - 1000 - 500) * 0.10);
  assert.equal(ytd.wages, 9500);
});

test('the last year is partial when the horizon ends mid-year', () => {
  const r = run(plan({ asOf: '2026-06-30', flows: [salary({ ytdGross: 120000 })] }));
  const last = r.taxYears.at(-1);
  assert.equal(last.year, 2029);
  assert.ok(last.partial && !last.settledOn);
  assert.ok(!r.taxYears[0].partial);
});

test('check-in does not credit pay from scenario-only jobs', () => {
  const p = plan({
    asOf: '2026-01-31',
    decisions: [{ id: 'job', name: 'Job', alternatives: [{ id: 'stay', name: 'Stay' }, { id: 'move', name: 'Move' }] }],
    scenarios: [{ id: 'baseline', name: 'Baseline', choices: { job: 'stay' } }, { id: 'mv', name: 'Move', choices: { job: 'move' } }],
    flows: [
      salary({}, { id: 'stay-pay', when: { job: ['stay'] } }),
      salary({}, { id: 'move-pay', when: { job: ['move'] }, schedule: { freq: 'semimonthly', start: '2026-03-01', days: [15, 'last'] } })
    ]
  });
  const out = rebaseline(p, { balances: {} }, '2026-06-30', { referenceId: 'baseline' }).plan;
  near(out.flows.find(f => f.id === 'stay-pay').pay.ytdGross, 100000);
  assert.ok(!out.flows.find(f => f.id === 'move-pay').pay.ytdGross);
});

test('pre-tax and Roth 401(k) can share one annual limit', () => {
  const r = run(plan({
    accounts: [{ id: 'cash', name: 'Cash', kind: 'cash', balance: 20000 }, { id: 'k', name: '401(k)', kind: 'traditional', balance: 0 }, { id: 'roth', name: 'Roth', kind: 'roth', balance: 0 }],
    flows: [salary({ deductions: [
      { id: 'pre', name: '401(k)', pct: 10, to: 'k', pretax: true, annualLimit: 24500 },
      { id: 'ro', name: 'Roth 401(k)', pct: 5, to: 'roth', pretax: false, annualLimit: 24500, limitWith: 'pre' }
    ] })]
  }));
  const end = at(r, '2026-12-31');
  near(r.accounts.k[end] + r.accounts.roth[end], 24500, 1);
  // pre-tax goes first each paycheck: 1,000 + 500 per paycheck until the shared cap
  near(r.accounts.k[end], 16 * 1000 + 500, 1);
});

test('April true-up: withholding vs estimated tax becomes a refund or a payment from cash', () => {
  const under = run(plan({ flows: [salary({ fedPct: 5 })] }));
  const t = under.taxYears.find(x => x.year === 2026);
  near(t.wages, 240000);
  near(t.federal, wageIncomeTax(240000, 'mfj', 2026, 0).tax);
  near(t.addlMedicare, 0.009 * (240000 - 250000 > 0 ? 240000 - 250000 : 0));
  near(t.withheld, 240000 * 0.05 + 0.009 * 40000);
  assert.ok(t.due > 0);
  assert.equal(t.settledOn, '2027-04-15');
  const bill = under.ledger.find(l => l.kind === 'tax');
  near(bill.amount, t.due);
  assert.equal(bill.date, '2027-04-15');
  const i = at(under, '2027-04-15');
  const sameDayPay = under.ledger.find(l => l.item === 'pay' && l.date === '2027-04-15').amount;
  near(under.accounts.cash[i - 1] + sameDayPay - under.accounts.cash[i], t.due, 0.5);

  const over = run(plan({ flows: [salary({ fedPct: 30 })] }));
  const refund = over.ledger.find(l => l.kind === 'refund');
  assert.ok(refund && refund.amount > 0);
  near(refund.amount, -over.taxYears[0].due);
  // net taxes = estimated liability + FICA, regardless of withholding
  const taxesFirstYear = r => r.taxYears[0].federal + r.taxYears[0].addlMedicare + r.taxYears[0].fica;
  near(taxesFirstYear(under), taxesFirstYear(over));
});

test('wages paid before the as-of date count toward the wage base and the tax bill', () => {
  const p = plan({ asOf: '2026-10-31', flows: [salary({ ytdGross: 190000 })] });
  const r = run(p);
  const rest = paychecks(r, '2026');
  assert.equal(rest.length, 4);
  assert.ok(rest.every(l => !l.note.includes('SS ')), 'already past the wage base');
  const t = r.taxYears.find(x => x.year === 2026);
  assert.ok(t.includesEarlier);
  near(t.wages, 230000);
  near(t.fedWithheld, 230000 * 0.15);
});

test('a partial first year without earlier wages is not trued up', () => {
  const r = run(plan({ asOf: '2026-10-31', flows: [salary({})] }));
  assert.ok(r.taxYears[0].partial);
  assert.ok(!r.ledger.some(l => (l.kind === 'tax' || l.kind === 'refund') && l.date === '2027-04-15'));
  assert.ok(r.ledger.some(l => (l.kind === 'tax' || l.kind === 'refund') && l.date === '2028-04-15'));
});

test('check-in rolls "paid so far this year" forward', () => {
  const p = plan({ asOf: '2026-10-31', flows: [salary({ ytdGross: 190000 })] });
  const same = rebaseline(p, { balances: {} }, '2026-12-01').plan;
  near(same.flows[0].pay.ytdGross, 210000); // + Nov 15 and Nov 30
  const next = rebaseline(p, { balances: {} }, '2027-02-01').plan;
  near(next.flows[0].pay.ytdGross, 20000);
});

test('pay preview and suggested withholding', () => {
  const p = plan({ flows: [salary({ fedPct: 15, deductions: [{ id: 'k', name: '401(k)', pct: 10, to: 'k', pretax: true, annualLimit: 24500 }] })] });
  const pv = payPreview(p, p.flows[0], 2026);
  assert.equal(pv.rows.length, 24);
  assert.ok(pv.rows[0].ss > 0 && pv.rows[23].ss === 0);
  const pct = suggestedFedPct(p, p.flows[0]);
  const taxable = 240000 - 24000;
  near(pct, Math.round(wageIncomeTax(taxable, 'mfj', 2026, 0).tax / taxable * 1000) / 10);
});

test('taxes off: paychecks keep deductions but withhold nothing and nothing is trued up', () => {
  const p = plan({ flows: [salary({ deductions: [{ id: 'k', name: '401(k)', pct: 10, to: 'k', pretax: true }] })] });
  p.settings.tax.enabled = false;
  const r = run(p);
  near(paychecks(r)[0].amount, 9000);
  assert.ok(!r.ledger.some(l => l.kind === 'tax' || l.kind === 'refund'));
  assert.equal(r.totals.taxes, 0);
});
