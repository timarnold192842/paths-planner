import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importLegacy } from '../src/engine/legacy.js';
import { runScenario } from '../src/engine/metrics.js';
import { payPreview } from '../src/engine/payroll.js';

// A small fictional export from the old Forecast app.
const fixture = () => ({
  accounts: [
    { id: 'a1', name: 'Cash', balance: 30000, annual_growth: 1.02, units: 'usd', tags: 'liquid', positionIndex: 0 },
    { id: 'a2', name: 'Kid A 529', balance: 20000, annual_growth: 1.06, units: 'usd' },
    { id: 'a3', name: 'Widget Co', balance: 1000, annual_growth: 1, units: 'u1', rightAxis: true, positionIndex: 1 }
  ],
  loans: [
    { id: 'l1', name: 'Promo Card', initial_balance: 10400, monthly_payment: 100, interest_rate: 0, start_date: '2026-01-01', payoff_date: '2027-12-01', day_of_month: 1, isEnabled: true },
    { id: 'l2', name: 'Car', initial_balance: 20000, monthly_payment: 400, interest_rate: 0.05, start_date: '2025-01-01', payoff_date: '2030-01-01', day_of_month: 5, isEnabled: true, positionIndex: 0, rightAxis: true }
  ],
  transactions: [
    { id: 't1', type: 'BiWeekly', name: 'Paycheck', amount: 5000, units: 'usd', to_account: 'Cash', start_date: '2026-01-01', days_of_month: '15, last', annual_growth: 1.02, split_amount: 5465, split_month: 9, isEnabled: true },
    { id: 't2', type: 'Annual', name: 'Bonus', amount: 10000, units: 'usd', to_account: 'Cash', start_date: '2026-01-01', month_of_year: 3, day_of_month: 15, isEnabled: true },
    { id: 't3', type: 'Quarterly', name: 'G1 RSU', amount: 100, units: 'u1', to_account: 'Widget Co', start_date: '2026-01-01', end_date: '2030-01-01', isEnabled: true },
    { id: 't4', type: 'Monthly', name: 'Option grant ISO', amount: 10, units: 'u1', to_account: 'Widget Co', start_date: '2026-01-01', end_date: '2028-01-01', day_of_month: 1, isEnabled: true },
    { id: 't5', type: 'Annual', name: 'Kid A College', amount: 30000, units: 'usd', from_account: 'Cash', start_date: '2030-09-01', end_date: '2033-09-01', month_of_year: 9, day_of_month: 1, isEnabled: true },
    { id: 't6', type: 'OneTime', name: 'Promo Card', amount: 10000, units: 'usd', to_account: 'Cash', start_date: '2026-06-01', isEnabled: true },
    { id: 't7', type: 'Monthly', name: 'Groceries', amount: 1200, units: 'usd', from_account: 'Cash', start_date: '2026-01-01', day_of_month: 3, isEnabled: true, positionIndex: 2 },
    { id: 't8', type: 'Monthly', name: 'Rent', amount: 2500, units: 'usd', from_account: 'Cash', start_date: '2026-01-01', day_of_month: 1, isEnabled: true, positionIndex: 1 }
  ],
  fees: [],
  units: [{ id: 'usd', name: 'USD', usdRate: 1, isDefault: true }, { id: 'u1', name: 'Widget', symbol: 'WDG', usdRate: 20, growthRate: 0, growthEnabled: false, priceTargets: [] }],
  accountGroups: [{ id: 'ag', name: 'Savings', collapsed: true, items: ['a2'], positionIndex: 0 }],
  loanGroups: [],
  transactionGroups: [
    { id: 'g2', name: 'Kids', collapsed: true, items: ['t5'], positionIndex: 1 },
    { id: 'g1', name: 'Work', collapsed: false, items: ['t2', 't1', 't3', 't4'], positionIndex: 0 }
  ],
  plotOptions: { Car: true, Cash: true, 'Some sale': true, Groceries: false },
  yAxisFrozen: true,
  transactionPlotOptions: { t7: true },
  viewRange: { start: '2026-01-01T00:00:00.000Z', end: '2029-01-01T00:00:00.000Z' }
});

const asOf = '2026-03-01';

test('net pay that steps up mid-year becomes a paycheck whose take-home matches exactly', () => {
  const { plan, report } = importLegacy(fixture(), { asOf });
  const pay = plan.flows.find(f => f.name === 'Paycheck');
  // (5465 − 5000) / 6.2% = 7500 gross
  assert.equal(pay.amount, 7500);
  assert.equal(pay.steps.length, 0, 'no permanent split step');
  const pv = payPreview(plan, pay, 2027);
  assert.ok(Math.abs(pv.rows[0].net - 5000 * 1.02 ** (10 / 12)) < 60, `first net ${pv.rows[0].net}`);
  assert.ok(pv.rows.at(-1).ss === 0 && pv.rows[0].ss > 0, 'Social Security stops during the year');
  // the same employer's bonus and RSUs are paychecks; options are not
  assert.ok(plan.flows.find(f => f.name === 'Bonus').pay);
  assert.ok(plan.flows.find(f => f.name === 'G1 RSU').pay);
  assert.ok(!plan.flows.find(f => f.name === 'Option grant ISO').pay);
  // bonus net is preserved
  const bonus = plan.flows.find(f => f.name === 'Bonus');
  const bpv = payPreview(plan, bonus, 2027);
  assert.ok(Math.abs(bpv.rows[0].net - 10000) < 5, `bonus net ${bpv.rows[0].net}`);
  assert.ok(report.some(r => r.level === 'change' && /Social Security/.test(r.message)));
  // withholding tracks the estimated tax, so true-ups stay small
  const run = runScenario(plan, 'baseline').run;
  const y = run.taxYears.find(t => t.year === 2027);
  assert.ok(Math.abs(y.due) < 0.03 * y.wages, `true-up ${y.due} on ${y.wages}`);
});

test('a card balance plus its "cash from card" deposit becomes one borrowing item with the fee', () => {
  const { plan, report } = importLegacy(fixture(), { asOf });
  const card = plan.debts.find(d => d.name === 'Promo Card');
  assert.equal(card.start, '2026-06-01');
  assert.equal(card.balance, 10000);
  assert.equal(card.feeFixed, 400);
  assert.equal(card.proceedsTo, plan.settings.primaryCashId);
  assert.ok(!plan.flows.some(f => f.name === 'Promo Card'));
  assert.ok(report.some(r => r.level === 'change' && /one borrowing item/.test(r.message)));
});

test('college bills are paid from the matching 529 first', () => {
  const { plan } = importLegacy(fixture(), { asOf });
  const college = plan.flows.find(f => f.name === 'Kid A College');
  assert.deepEqual(college.from, [plan.accounts.find(a => a.name === 'Kid A 529').id]);
  assert.equal(college.qualified, 'education');
});

test('order, folded groups, chart lines and range carry over; missing features are listed', () => {
  const { plan, report, ui } = importLegacy(fixture(), { asOf });
  assert.deepEqual(plan.groups.map(g => g.name), ['Work', 'Kids']);
  assert.deepEqual(plan.flows.filter(f => !f.group).map(f => f.name), ['Rent', 'Groceries']);
  assert.deepEqual(plan.flows.filter(f => f.group === plan.groups[0].id).map(f => f.name), ['Bonus', 'Paycheck', 'G1 RSU', 'Option grant ISO']);
  assert.deepEqual(plan.accounts.map(a => a.name).slice(0, 2), ['Cash', 'Widget Co']);
  assert.equal(plan.debts[0].name, 'Car');
  assert.deepEqual(Object.keys(ui.planCollapsed), [`flows:${plan.groups[1].id}`]);
  assert.deepEqual(ui.chartLines, [`debt:${plan.debts[0].id}`]);
  assert.equal(ui.overviewYears, 3);
  assert.deepEqual(ui['chart:overview'].right, [`debt:${plan.debts[0].id}`], 'right-axis lines stay on the right');
  const absent = report.filter(r => r.level === 'absent').map(r => r.message).join('\n');
  for (const re of [/Account groups/, /individual transactions \(Some sale\)/, /Frozen Y scale/, /Stock options/, /Tags/]) assert.match(absent, re);
});

test('modernize: false is a literal import', () => {
  const { plan } = importLegacy(fixture(), { asOf, modernize: false });
  assert.ok(!plan.flows.some(f => f.pay));
  assert.ok(plan.flows.some(f => f.name === 'Promo Card'));
  assert.equal(plan.flows.find(f => f.name === 'Paycheck').steps.length, 1);
});
