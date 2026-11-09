// Summary metrics for one simulation run, and A/B comparison between runs.

import { addYears, toYMD, yearsBetween, parseYMD } from './dates.js';
import { compile } from './compile.js';
import { simulate } from './simulate.js';

export const HORIZONS = [1, 3, 5, 10, 20, 30];

export const LENSES = [
  { id: 'afterTaxReal', label: "After-tax, today's dollars", series: 'afterTax', real: true },
  { id: 'afterTax', label: 'After-tax', series: 'afterTax', real: false },
  { id: 'netWorthReal', label: "Net worth, today's dollars", series: 'netWorth', real: true },
  { id: 'netWorth', label: 'Net worth', series: 'netWorth', real: false }
];

export function deflator(run, inflationPct) {
  const r = (Number(inflationPct) || 0) / 100;
  const out = new Float64Array(run.N);
  for (let i = 0; i < run.N; i++) out[i] = r ? (1 + r) ** (i / 365.25) : 1;
  return out;
}

// The series for a lens, e.g. after-tax net worth in today's dollars.
export function lensSeries(run, lensId, inflationPct) {
  const lens = LENSES.find(l => l.id === lensId) || LENSES[0];
  const base = run.series[lens.series];
  if (!lens.real) return base;
  const def = deflator(run, inflationPct);
  const out = new Float64Array(run.N);
  for (let i = 0; i < run.N; i++) out[i] = base[i] / def[i];
  return out;
}

function indexAtYears(run, years) {
  const target = addYears(parseYMD(run.start), years);
  const i = Math.round((target - parseYMD(run.start)) / 86400000);
  return Math.min(run.N - 1, Math.max(0, i));
}

export function metrics(run, plan) {
  const s = plan.settings || {};
  const floor = Number(s.cashFloor) || 0;
  const infl = s.inflation;
  const real = lensSeries(run, 'afterTaxReal', infl);
  const nwReal = lensSeries(run, 'netWorthReal', infl);
  const cash = run.series.cash;

  let minCash = Infinity;
  let minCashI = 0;
  let firstNegative = null;
  let firstBelowFloor = null;
  let daysBelowFloor = 0;
  for (let i = 0; i < run.N; i++) {
    const c = cash[i];
    if (c < minCash) { minCash = c; minCashI = i; }
    if (c < 0 && firstNegative == null) firstNegative = i;
    if (c < floor) { daysBelowFloor++; if (firstBelowFloor == null) firstBelowFloor = i; }
  }
  // Same, for the first 3 years (the "can I sustain it?" window).
  const near = indexAtYears(run, 3);
  let minCashNear = Infinity;
  let minCashNearI = 0;
  for (let i = 0; i <= near; i++) if (cash[i] < minCashNear) { minCashNear = cash[i]; minCashNearI = i; }

  const at = {};
  for (const y of HORIZONS) {
    const i = indexAtYears(run, y);
    if (i >= run.N - 1 && y > (plan.horizonYears || 30)) continue;
    at[y] = {
      date: toYMD(run.dates[i]),
      netWorth: run.series.netWorth[i],
      afterTax: run.series.afterTax[i],
      afterTaxReal: real[i],
      netWorthReal: nwReal[i],
      cash: cash[i]
    };
  }
  const last = run.N - 1;
  return {
    at,
    end: {
      date: toYMD(run.dates[last]),
      netWorth: run.series.netWorth[last],
      afterTax: run.series.afterTax[last],
      afterTaxReal: real[last],
      netWorthReal: nwReal[last]
    },
    minCash: { value: minCash, date: toYMD(run.dates[minCashI]) },
    minCashNear: { value: minCashNear, date: toYMD(run.dates[minCashNearI]) },
    firstNegative: firstNegative == null ? null : toYMD(run.dates[firstNegative]),
    firstBelowFloor: firstBelowFloor == null ? null : toYMD(run.dates[firstBelowFloor]),
    daysBelowFloor,
    floor,
    totals: run.totals
  };
}

// Days where the sign of (b - a) changes. Small wiggles (< threshold) are ignored.
export function crossovers(a, b, dates, threshold = 1000) {
  const out = [];
  let sign = 0;
  for (let i = 0; i < a.length; i++) {
    const d = b[i] - a[i];
    if (Math.abs(d) < threshold) continue;
    const sgn = Math.sign(d);
    if (sign !== 0 && sgn !== sign) out.push({ date: toYMD(dates[i]), direction: sgn > 0 ? 'ahead' : 'behind' });
    sign = sgn;
  }
  return out;
}

export function runScenario(plan, scenarioId, opts = {}) {
  const compiled = compile(plan, scenarioId, opts);
  const run = simulate(compiled.plan, { ledger: opts.ledger });
  return { scenarioId, compiled, run, metrics: metrics(run, compiled.plan) };
}

// Compare challengers against a reference. Returns per-challenger verdicts and deltas.
export function compareRuns(ref, others, plan, lensId = 'afterTaxReal') {
  const infl = plan.settings?.inflation;
  const negligible = (Number(plan.settings?.negligiblePct) || 2) / 100;
  const refSeries = lensSeries(ref.run, lensId, infl);
  return others.map(o => {
    const s = lensSeries(o.run, lensId, infl);
    const delta = new Float64Array(s.length);
    for (let i = 0; i < s.length; i++) delta[i] = s[i] - refSeries[i];
    const cross = crossovers(refSeries, s, ref.run.dates);
    const deltasAt = {};
    for (const y of Object.keys(o.metrics.at)) {
      const i = indexAtYears(ref.run, Number(y));
      deltasAt[y] = delta[i];
    }
    const endDelta = delta[delta.length - 1];
    const endRef = refSeries[refSeries.length - 1];
    const endPct = Math.abs(endRef) > 1 ? endDelta / Math.abs(endRef) : 0;
    const floor = o.metrics.floor;
    const refBreach = ref.metrics.minCash.value < floor;
    const oBreach = o.metrics.minCash.value < floor;
    const liquidityDelta = o.metrics.minCashNear.value - ref.metrics.minCashNear.value;
    const cashDelta1y = (o.metrics.at[1]?.cash ?? 0) - (ref.metrics.at[1]?.cash ?? 0);
    const cashDelta3y = (o.metrics.at[3]?.cash ?? 0) - (ref.metrics.at[3]?.cash ?? 0);
    const longTerm = Math.abs(endPct) < negligible ? 'negligible' : endDelta > 0 ? 'better' : 'worse';
    return {
      scenarioId: o.scenarioId,
      delta,
      crossovers: cross,
      firstCrossover: cross[0] || null,
      lastCrossover: cross[cross.length - 1] || null,
      deltasAt,
      endDelta,
      endPct,
      longTerm: longTerm === 'negligible' && (refBreach || oBreach) ? 'small' : longTerm,
      liquidityDelta,
      cashDelta1y,
      cashDelta3y,
      refBreach,
      oBreach
    };
  });
}

// Plain-language one-liner for a comparison row.
export function verdictText(cmp, refName, oName, fmtMoney) {
  const pct = `${(Math.abs(cmp.endPct) * 100).toFixed(1)}%`;
  const parts = [];
  if (cmp.longTerm === 'negligible') parts.push(`${oName} ends within ${pct} of ${refName} — negligible long-term`);
  else parts.push(`${oName} ends ${fmtMoney(Math.abs(cmp.endDelta))} (${pct}) ${cmp.endDelta >= 0 ? 'above' : 'below'} ${refName}`);
  if (Math.abs(cmp.liquidityDelta) >= 1000) {
    parts.push(`its lowest cash in the next 3 years is ${fmtMoney(Math.abs(cmp.liquidityDelta))} ${cmp.liquidityDelta > 0 ? 'higher' : 'lower'}`);
  }
  const cushion = Math.abs(cmp.cashDelta1y) >= Math.abs(cmp.cashDelta3y) ? ['1 year', cmp.cashDelta1y] : ['3 years', cmp.cashDelta3y];
  if (Math.abs(cushion[1]) >= 1000) {
    parts.push(`it has ${fmtMoney(Math.abs(cushion[1]))} ${cushion[1] > 0 ? 'more' : 'less'} cash on hand after ${cushion[0]}`);
  }
  if (cmp.oBreach && !cmp.refBreach) parts.push('but it dips below your cash floor');
  else if (!cmp.oBreach && cmp.refBreach) parts.push(`and it stays above the cash floor (${refName} doesn't)`);
  if (cmp.lastCrossover) parts.push(`it ${cmp.lastCrossover.direction === 'ahead' ? 'pulls ahead' : 'falls behind'} for good around ${cmp.lastCrossover.date.slice(0, 7)}`);
  return parts.join('; ') + '.';
}

// Run every scenario under each case of one assumption, holding everything else constant.
export function stressTest(plan, scenarioIds, assumptionId, refId, lensId = 'afterTaxReal') {
  const asm = plan.assumptions.find(a => a.id === assumptionId);
  if (!asm) return null;
  const infl = plan.settings?.inflation;
  const rows = asm.cases.map(c => {
    const runs = scenarioIds.map(id => runScenario(plan, id, { caseOverrides: { [assumptionId]: c.id }, ledger: false }));
    const ref = runs.find(r => r.scenarioId === refId) || runs[0];
    const refEnd = lensSeries(ref.run, lensId, infl).at(-1);
    return {
      caseId: c.id,
      caseName: c.name,
      cells: runs.map(r => {
        const end = lensSeries(r.run, lensId, infl).at(-1);
        return { scenarioId: r.scenarioId, end, delta: end - refEnd, minCash: r.metrics.minCashNear.value, breach: r.metrics.minCash.value < r.metrics.floor };
      })
    };
  });
  return { assumption: asm, rows };
}

export { yearsBetween };
