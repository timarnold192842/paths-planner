// Paychecks (W-2 wages): gross pay, payroll taxes, withholding, and payroll deductions —
// plus a back-of-the-envelope federal income tax so each year's withholding can be trued up
// (refund or balance due) the following April.
//
// Payroll taxes reset every January 1st, which is what makes take-home pay step up mid-year:
// Social Security (6.2%) stops once the year's wages from an employer reach the wage base;
// Medicare (1.45%) never stops, and an extra 0.9% is withheld on wages above $200k.
// A capped payroll deduction (e.g. a 401(k) at its annual limit) stops the same way.
//
// Dollar thresholds are the 2026 IRS / SSA figures (Rev. Proc. 2025-32) and are indexed with the
// plan's inflation setting for other years. Not modeled: credits, itemizing, AMT, NIIT, SS taxation.

import { parseYMD } from './dates.js';
import { occurrences } from './schedule.js';

export const TAX_YEAR = 2026;

export const PAYROLL = {
  ssRate: 0.062,
  ssWageBase: 184500,
  medicareRate: 0.0145,
  addlMedicareRate: 0.009,
  addlMedicareWithholdAt: 200000, // statutory, not indexed
  addlMedicareThreshold: { single: 200000, mfj: 250000 },
  limit401k: 24500
};

export const FILING = [
  { id: 'mfj', label: 'Married filing jointly' },
  { id: 'single', label: 'Single' }
];

const STANDARD_DEDUCTION = { single: 16100, mfj: 32200 };
const BRACKETS = {
  single: [[0, 0.10], [12400, 0.12], [50400, 0.22], [105700, 0.24], [201775, 0.32], [256225, 0.35], [640600, 0.37]],
  mfj: [[0, 0.10], [24800, 0.12], [100800, 0.22], [211400, 0.24], [403550, 0.32], [512450, 0.35], [768700, 0.37]]
};

const filingOf = f => (f === 'single' ? 'single' : 'mfj');
export const indexFactor = (year, inflationPct, base = TAX_YEAR) => (1 + (Number(inflationPct) || 0) / 100) ** (year - base);

export function standardDeduction(filing, year, inflationPct) {
  return STANDARD_DEDUCTION[filingOf(filing)] * indexFactor(year, inflationPct);
}

// Federal income tax on taxable income (after deductions), with the marginal rate it lands in.
export function federalIncomeTax(taxable, filing, year, inflationPct) {
  const k = indexFactor(year, inflationPct);
  const br = BRACKETS[filingOf(filing)];
  let tax = 0;
  let marginal = br[0][1];
  for (let j = 0; j < br.length; j++) {
    const lo = br[j][0] * k;
    const hi = j + 1 < br.length ? br[j + 1][0] * k : Infinity;
    if (taxable <= lo) break;
    tax += (Math.min(taxable, hi) - lo) * br[j][1];
    marginal = br[j][1];
  }
  return { tax: Math.max(0, tax), marginal };
}

// Estimated federal tax on a year's taxable wages (standard deduction, no credits).
export function wageIncomeTax(taxableWages, filing, year, inflationPct) {
  return federalIncomeTax(Math.max(0, taxableWages - standardDeduction(filing, year, inflationPct)), filing, year, inflationPct);
}

export const ssWageBase = (year, inflationPct) => PAYROLL.ssWageBase * indexFactor(year, inflationPct);

// A fresh year-to-date counter for one employer.
export const newYtd = () => ({ wages: 0, ded: {} });

// Withholding on one paycheck. `ytd` (this employer, this calendar year) is updated in place.
// opts: year, inflation, taxOn, isUnit (stock vest: no deductions), limitIndex (inflation factor for
// deduction limits), count (fixed-$ deductions are multiplied by this; used for "paid so far" lumps),
// key (prefix for deduction counters, normally the flow id).
export function paycheck(pay, gross, ytd, opts = {}) {
  const { year = TAX_YEAR, inflation = 0, taxOn = true, isUnit = false, limitIndex = 1, count = 1, key = '' } = opts;
  const g = Math.max(0, Number(gross) || 0);
  const out = { gross: g, pretax: 0, ficaExempt: 0, ficaWages: g, deductions: [], employerAdds: 0, ss: 0, medicare: 0, addlMedicare: 0, fed: 0, state: 0, net: 0 };
  if (!isUnit) {
    for (const d of pay.deductions || []) {
      const want = d.pct != null && d.pct !== '' ? g * (Number(d.pct) || 0) / 100 : (Number(d.amount) || 0) * count;
      // Deductions can share one annual limit (pre-tax + Roth 401(k) share the elective-deferral cap).
      const ck = `${key}:${d.limitWith || d.id}`;
      const lim = Number(d.annualLimit) > 0 ? Number(d.annualLimit) * limitIndex : Infinity;
      const amount = Math.max(0, Math.min(want, lim - (ytd.ded[ck] || 0)));
      ytd.ded[ck] = (ytd.ded[ck] || 0) + amount;
      const employer = amount > 0 || want === 0 ? g * (Number(d.employerPct) || 0) / 100 : 0;
      if (d.pretax) out.pretax += amount;
      // Cafeteria-plan (Section 125) deductions like HSA and health premiums also skip FICA.
      if (d.pretax && d.ficaExempt) out.ficaExempt += amount;
      out.employerAdds += employer;
      out.deductions.push({ id: d.id, name: d.name || 'Deduction', amount, employer, to: d.to || null, pretax: !!d.pretax, capped: amount + 1e-9 < want });
    }
  }
  const fw = out.ficaWages = Math.max(0, g - out.ficaExempt);
  if (taxOn) {
    if (pay.fica !== false) {
      const base = ssWageBase(year, inflation);
      out.ss = PAYROLL.ssRate * Math.max(0, Math.min(fw, base - ytd.wages));
      out.medicare = PAYROLL.medicareRate * fw;
      const over = Math.max(0, ytd.wages + fw - Math.max(PAYROLL.addlMedicareWithholdAt, ytd.wages));
      out.addlMedicare = PAYROLL.addlMedicareRate * over;
    }
    const taxable = Math.max(0, g - out.pretax);
    out.fed = taxable * (Number(pay.fedPct) || 0) / 100;
    out.state = taxable * (Number(pay.statePct) || 0) / 100;
  }
  ytd.wages += fw; // Social Security / Medicare wages
  const deducted = out.deductions.reduce((s, d) => s + d.amount, 0);
  out.withheld = out.ss + out.medicare + out.addlMedicare + out.fed + out.state;
  out.net = g - out.withheld - deducted;
  return out;
}

// Paycheck-by-paycheck preview of one income item for a calendar year, including other paychecks
// from the same employer (they share the Social Security wage base). Stock vests use today's price.
export function payPreview(plan, flow, year) {
  const pay = flow.pay;
  if (!pay) return null;
  const infl = plan.settings?.inflation || 0;
  const asOfYear = parseYMD(plan.asOf).getUTCFullYear();
  const employer = (pay.employer || '').trim().toLowerCase();
  const peers = (plan.flows || []).filter(f => f.id !== flow.id && f.pay && f.enabled !== false && (f.pay.employer || '').trim().toLowerCase() === employer);
  const from = new Date(Date.UTC(year, 0, 1));
  const to = new Date(Date.UTC(year, 11, 31));
  const priceOf = f => (f.unitId ? Number((plan.units || []).find(u => u.id === f.unitId)?.price) || 0 : 1);
  const items = [];
  for (const f of [flow, ...peers]) {
    for (const d of occurrences(f.schedule, from, to)) items.push({ f, d, gross: amountAt(f, d) * priceOf(f) });
  }
  items.sort((a, b) => a.d - b.d || (a.f === flow ? 1 : -1));
  const ytd = newYtd();
  const opts = { year, inflation: infl, taxOn: plan.settings?.tax?.enabled !== false, limitIndex: indexFactor(year, infl, asOfYear) };
  const rows = [];
  for (const it of items) {
    const r = paycheck(it.f.pay, it.gross, ytd, { ...opts, isUnit: !!it.f.unitId, key: it.f.id });
    if (it.f === flow) rows.push({ date: it.d, ...r });
  }
  return { year, rows, peers: peers.map(f => f.name) };
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

// Suggested federal withholding % for a paycheck: the estimated effective rate on its annualized
// taxable pay (this job alone, standard deduction).
export function suggestedFedPct(plan, flow) {
  const year = parseYMD(plan.asOf).getUTCFullYear() + 1;
  const pv = payPreview(plan, { ...flow, pay: { ...flow.pay, fedPct: 0, statePct: 0 } }, year);
  if (!pv || !pv.rows.length) return null;
  const taxable = pv.rows.reduce((s, r) => s + r.gross - r.pretax, 0);
  if (taxable <= 0) return 0;
  const { tax } = wageIncomeTax(taxable, plan.settings?.tax?.filing, year, plan.settings?.inflation);
  return Math.round(tax / taxable * 1000) / 10;
}
