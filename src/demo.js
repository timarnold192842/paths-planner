// Fictional demo household. Dates are relative to today so the demo never goes stale.
import { todayYMD, parseYMD, toYMD, addMonths } from './engine/dates.js';
import { SCHEMA, defaultSettings, SCENARIO_COLORS } from './engine/model.js';

export function demoPlan() {
  const asOf = todayYMD();
  const t0 = parseYMD(asOf);
  const m = n => toYMD(addMonths(t0, n));
  const dayBefore = ymd => toYMD(new Date(parseYMD(ymd).getTime() - 86400000));
  const firstOf = n => { const d = addMonths(t0, n); return toYMD(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))); };

  const settings = defaultSettings();
  settings.primaryCashId = 'checking';
  settings.cashFloor = 20000;
  settings.tax.birthDate = toYMD(new Date(Date.UTC(t0.getUTCFullYear() - 41, 3, 12)));

  return {
    schema: SCHEMA,
    id: 'demo',
    name: 'Demo household',
    asOf,
    horizonYears: 30,
    settings,
    groups: [
      { id: 'g-income', name: 'Income' },
      { id: 'g-home', name: 'Home & living' },
      { id: 'g-condo', name: 'Rental condo' },
      { id: 'g-kids', name: 'Kids & college' },
      { id: 'g-equity', name: 'ACME equity' },
      { id: 'g-saving', name: 'Saving' }
    ],
    units: [{
      id: 'acme', name: 'ACME', symbol: 'ACME', price: 12, growth: 6, assumptionId: 'a-acme',
      paths: {
        bear: [{ date: m(12), price: 8 }, { date: m(36), price: 10 }, { date: m(60), price: 13 }],
        mid: [{ date: m(12), price: 15 }, { date: m(36), price: 24 }, { date: m(60), price: 35 }],
        bull: [{ date: m(12), price: 22 }, { date: m(36), price: 45 }, { date: m(60), price: 80 }]
      }
    }],
    accounts: [
      { id: 'checking', name: 'Checking', kind: 'cash', balance: 38000, growth: 1, tags: [] },
      { id: 'savings', name: 'High-yield savings', kind: 'cash', balance: 22000, growth: 4, tags: [] },
      { id: 'brokerage', name: 'Brokerage', kind: 'brokerage', balance: 64000, costBasis: 47000, growth: 7, tags: [] },
      { id: 'acme-shares', name: 'ACME shares', kind: 'equity', unitId: 'acme', balance: 9000, costBasis: 72000, growth: 0, tags: [] },
      { id: '401k', name: '401(k)', kind: 'traditional', balance: 185000, growth: 7, tags: [] },
      { id: 'roth', name: 'Roth IRA', kind: 'roth', balance: 42000, growth: 7, tags: [] },
      { id: 'hsa', name: 'HSA', kind: 'hsa', balance: 16000, growth: 6, tags: [] },
      { id: 'maya-529', name: "Maya's 529", kind: 'education', balance: 38000, costBasis: 26000, growth: 6, tags: [] },
      { id: 'home', name: 'Home', kind: 'property', balance: 640000, costBasis: 470000, growth: 3.5, primaryResidence: true, tags: [] },
      { id: 'condo', name: 'Rental condo', kind: 'property', balance: 315000, costBasis: 205000, growth: 3, tags: [] },
      { id: 'car', name: 'Car', kind: 'other', balance: 24000, growth: -12, tags: [] }
    ],
    debts: [
      { id: 'home-mortgage', name: 'Home mortgage', balance: 402000, rate: 3.1, payment: 2640, paymentDay: 1, securedBy: 'home', payFrom: [] },
      { id: 'condo-mortgage', name: 'Condo mortgage', balance: 188000, rate: 6.5, payment: 1460, paymentDay: 5, securedBy: 'condo', payFrom: [] },
      { id: 'car-loan', name: 'Car loan', balance: 19500, rate: 7.9, payment: 540, paymentDay: 20, securedBy: 'car', payFrom: [] },
      { id: 'promo-card', name: '0% intro card', balance: 20000, start: m(3), proceedsTo: 'checking', feePct: 3, rate: 0, rateSteps: [{ date: m(21), rate: 24.99 }], paymentRule: 'minimum', minPct: 1, payment: 35, paymentDay: 12, payoffDate: dayBefore(m(21)), payFrom: [], when: { 'd-remodel': ['card'] } },
      { id: 'heloc', name: 'Home equity line', balance: 45000, start: m(3), proceedsTo: 'checking', creditLimit: 120000, rate: 8.25, paymentRule: 'interestOnly', paymentDay: 1, payoffDate: m(39), securedBy: 'home', payFrom: [], when: { 'd-remodel': ['heloc'] } }
    ],
    flows: [
      { id: 'salary', name: 'Salary (net)', group: 'g-income', amount: 6900, growth: 3, schedule: { freq: 'semimonthly', start: firstOf(0), days: [15, 'last'] }, from: [], to: 'checking', steps: [] },
      { id: 'bonus', name: 'Annual bonus (net)', group: 'g-income', amount: 9000, growth: 3, schedule: { freq: 'annual', start: firstOf(0), month: 3, dayOfMonth: 15 }, from: [], to: 'checking', steps: [] },
      { id: 'spending', name: 'Household spending', group: 'g-home', amount: 4700, growth: 2.5, schedule: { freq: 'monthly', start: firstOf(1), dayOfMonth: 2 }, from: [], to: null, steps: [] },
      { id: 'daycare', name: 'Daycare', group: 'g-kids', amount: 1450, growth: 3, schedule: { freq: 'monthly', start: firstOf(1), end: m(30), dayOfMonth: 1 }, from: [], to: null, steps: [{ date: m(18), amount: 900 }] },
      { id: 'home-tax', name: 'Home property tax', group: 'g-home', amount: 8400, growth: 3, schedule: { freq: 'annual', start: firstOf(0), month: 4, dayOfMonth: 30 }, from: [], to: null, whileOwned: 'home', steps: [] },
      { id: 'home-repairs', name: 'Home repairs (avg)', group: 'g-home', amount: 1500, growth: 3, schedule: { freq: 'quarterly', start: firstOf(1) }, from: [], to: null, whileOwned: 'home', steps: [] },
      { id: 'rent', name: 'Rent from tenant', group: 'g-condo', amount: 2350, growth: 3, taxed: 'ordinary', schedule: { freq: 'monthly', start: firstOf(1), dayOfMonth: 1 }, from: [], to: 'checking', whileOwned: 'condo', steps: [] },
      { id: 'condo-hoa', name: 'Condo HOA', group: 'g-condo', amount: 430, growth: 4, schedule: { freq: 'monthly', start: firstOf(1), dayOfMonth: 10 }, from: [], to: null, whileOwned: 'condo', steps: [] },
      { id: 'condo-tax', name: 'Condo property tax', group: 'g-condo', amount: 3900, growth: 3, schedule: { freq: 'annual', start: firstOf(0), month: 9, dayOfMonth: 30 }, from: [], to: null, whileOwned: 'condo', steps: [] },
      { id: 'condo-repairs', name: 'Condo repairs & turnover', group: 'g-condo', amount: 1100, growth: 3, schedule: { freq: 'quarterly', start: firstOf(1) }, from: [], to: null, whileOwned: 'condo', steps: [] },
      { id: 'acme-vest', name: 'ACME RSU vest', group: 'g-equity', amount: 420, unitId: 'acme', withholdPct: 35, schedule: { freq: 'quarterly', start: firstOf(1), end: m(48), dayOfMonth: 20 }, from: [], to: 'acme-shares', steps: [] },
      { id: '401k-contrib', name: '401(k) contribution', group: 'g-saving', amount: 900, growth: 2, schedule: { freq: 'semimonthly', start: firstOf(0), days: [15, 'last'] }, from: ['checking'], to: '401k', steps: [] },
      { id: '529-contrib', name: '529 contribution', group: 'g-kids', amount: 300, schedule: { freq: 'monthly', start: firstOf(1), end: m(110), dayOfMonth: 5 }, from: ['checking'], to: 'maya-529', steps: [] },
      { id: 'remodel', name: 'Kitchen remodel', group: 'g-home', amount: 45000, schedule: { freq: 'once', start: m(3) }, from: [], to: null, steps: [] },
      { id: 'college', name: "Maya's college", group: 'g-kids', amount: 34000, growth: 4, qualified: 'education', schedule: { freq: 'annual', start: m(116), end: m(160), month: 8, dayOfMonth: 15 }, from: ['maya-529'], to: null, steps: [] }
    ],
    events: [
      { id: 'sell-condo-spring', type: 'sell', name: 'Sell the condo (spring)', assetId: 'condo', date: m(6), costPct: 6, fixedCost: 2500, when: { 'd-condo': ['sell-soon'] } },
      { id: 'sell-condo-later', type: 'sell', name: 'Sell the condo (in 3 years)', assetId: 'condo', date: m(36), costPct: 6, fixedCost: 2500, when: { 'd-condo': ['sell-later'] } },
      { id: 'payoff-car', type: 'payoff', name: 'Pay off the car loan', debtId: 'car-loan', date: m(1), from: ['savings'], when: { 'd-car': ['payoff'] } },
      { id: 'acme-diversify', type: 'liquidate', name: 'Sell ACME each quarter', assetId: 'acme-shares', mode: 'percent', amount: 12, schedule: { freq: 'quarterly', start: firstOf(2), end: m(36) }, to: 'brokerage', when: { 'd-acme': ['diversify'] } }
    ],
    decisions: [
      { id: 'd-condo', name: 'Rental condo', notes: 'Keep collecting rent, or sell and take the cash cushion?', defaultAlt: 'keep', alternatives: [
        { id: 'keep', name: 'Keep renting it out', patches: [] },
        { id: 'sell-soon', name: 'Sell this spring', patches: [] },
        { id: 'sell-later', name: 'Sell in 3 years', patches: [] }
      ] },
      { id: 'd-car', name: 'Car loan', notes: 'Pay it off from savings now, or keep the schedule?', defaultAlt: 'normal', alternatives: [
        { id: 'normal', name: 'Keep the schedule', patches: [] },
        { id: 'payoff', name: 'Pay off now from savings', patches: [] }
      ] },
      { id: 'd-remodel', name: 'Paying for the remodel', notes: '$45k kitchen remodel in 3 months: pay cash, float part of it on a 0% card, or draw on a home equity line?', defaultAlt: 'cash', alternatives: [
        { id: 'cash', name: 'Pay cash', patches: [] },
        { id: 'card', name: '$20k on a 0% card for 18 months', patches: [] },
        { id: 'heloc', name: 'Home equity line, repay in 3 years', patches: [] }
      ] },
      { id: 'd-acme', name: 'ACME shares', notes: 'Hold company stock, or sell some every quarter into the brokerage account?', defaultAlt: 'hold', alternatives: [
        { id: 'hold', name: 'Hold everything', patches: [] },
        { id: 'diversify', name: 'Sell 12% per quarter for 3 years', patches: [] }
      ] }
    ],
    assumptions: [
      { id: 'a-acme', name: 'ACME price', defaultCase: 'mid', cases: [{ id: 'bear', name: 'Bear', patches: [] }, { id: 'mid', name: 'Mid', patches: [] }, { id: 'bull', name: 'Bull', patches: [] }] },
      { id: 'a-homes', name: 'Home appreciation', defaultCase: 'normal', cases: [
        { id: 'slow', name: 'Slow (1.5%/yr)', patches: [{ id: 'home', field: 'growth', value: 1.5 }, { id: 'condo', field: 'growth', value: 1.5 }] },
        { id: 'normal', name: 'As planned', patches: [] },
        { id: 'hot', name: 'Hot (5%/yr)', patches: [{ id: 'home', field: 'growth', value: 5 }, { id: 'condo', field: 'growth', value: 5 }] }
      ] }
    ],
    scenarios: [
      { id: 'baseline', name: 'Baseline', color: SCENARIO_COLORS[0], choices: {}, cases: {}, patches: [], notes: 'Keep the condo, keep the car schedule, hold ACME.' },
      { id: 's-sell-condo', name: 'Sell condo this spring', color: SCENARIO_COLORS[1], choices: { 'd-condo': 'sell-soon' }, cases: {}, patches: [] },
      { id: 's-car', name: 'Pay off car now', color: SCENARIO_COLORS[2], choices: { 'd-car': 'payoff' }, cases: {}, patches: [] },
      { id: 's-heloc', name: 'Remodel on a HELOC', color: SCENARIO_COLORS[4], choices: { 'd-remodel': 'heloc' }, cases: {}, patches: [] },
      { id: 's-card', name: 'Remodel on a 0% card', color: SCENARIO_COLORS[5], choices: { 'd-remodel': 'card' }, cases: {}, patches: [] },
      { id: 's-diversify', name: 'Sell condo + diversify ACME', color: SCENARIO_COLORS[3], basedOn: 's-sell-condo', choices: { 'd-acme': 'diversify' }, cases: {}, patches: [] }
    ],
    comparisons: [
      { id: 'c-condo', name: 'Should we sell the condo?', referenceId: 'baseline', scenarioIds: ['baseline', 's-sell-condo'], stressAssumptionId: 'a-homes' },
      { id: 'c-acme', name: 'Diversify out of ACME?', referenceId: 's-sell-condo', scenarioIds: ['s-sell-condo', 's-diversify'], stressAssumptionId: 'a-acme' },
      { id: 'c-remodel', name: 'How should we pay for the remodel?', referenceId: 'baseline', scenarioIds: ['baseline', 's-card', 's-heloc'], stressAssumptionId: '' },
      { id: 'c-car', name: 'Pay off the car early?', referenceId: 'baseline', scenarioIds: ['baseline', 's-car'], stressAssumptionId: '' }
    ],
    updatedAt: new Date().toISOString()
  };
}
