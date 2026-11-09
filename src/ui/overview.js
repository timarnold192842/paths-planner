import { useMemo } from 'preact/hooks';
import { html, money, compact, signed, tone, cls } from './h.js';
import { store, useUI } from '../store.js';
import { getRun, scenarioName } from './runs.js';
import { Chart, rangeFor } from './chart.js';
import { LENSES, lensSeries } from '../engine/metrics.js';
import { formatDate, formatMonthYear, parseYMD, addDays, toYMD, todayYMD } from '../engine/dates.js';
import { Breakdown, yearly } from './breakdown.js';
import { WhatIf } from './whatif.js';

export const RANGES = [[2, '2Y'], [5, '5Y'], [10, '10Y'], [30, '30Y']];

// Canvas can't read CSS variables, so resolve theme colors before handing them to the chart.
export function cssColor(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function Diagnostics({ diagnostics }) {
  if (!diagnostics?.length) return null;
  const uniq = [...new Map(diagnostics.map(d => [d.message, d])).values()];
  return html`<div class="notice" role="alert"><span>⚠</span><div>${uniq.slice(0, 4).map(d => html`<div>${d.message}</div>`)}${uniq.length > 4 ? html`<div>…and ${uniq.length - 4} more</div>` : null}</div></div>`;
}

const LENS_SHORT = { afterTaxReal: "After-tax · today's $", afterTax: 'After-tax', netWorthReal: "Net worth · today's $", netWorth: 'Net worth' };

export function LensPicker({ value, onChange }) {
  return html`<div class="seg hide-sm" aria-label="Measure">${LENSES.map(l => html`<button type="button" class=${l.id === value ? 'on' : ''} title=${l.label} onClick=${() => onChange(l.id)}>${LENS_SHORT[l.id]}</button>`)}</div>
    <select class="show-sm" value=${value} onChange=${e => onChange(e.target.value)} aria-label="Measure" style="width:auto">${LENSES.map(l => html`<option value=${l.id}>${LENS_SHORT[l.id]}</option>`)}</select>`;
}

export function RangePicker({ value, onChange }) {
  return html`<div class="seg" aria-label="Time range">${RANGES.map(([y, l]) => html`<button type="button" class=${y === value ? 'on' : ''} onClick=${() => onChange(y)}>${l}</button>`)}</div>`;
}

export function Overview({ scenarioId }) {
  const plan = store.plan;
  const [lens, setLens] = useUI('lens', 'afterTaxReal');
  const [years, setYears] = useUI('overviewYears', 10);
  const r = getRun(plan, scenarioId);
  const { run, metrics: m, compiled } = r;
  const infl = plan.settings.inflation;
  const lensLabel = LENSES.find(l => l.id === lens)?.label;

  const series = useMemo(() => [
    { label: lensLabel, values: lensSeries(run, lens, infl), color: cssColor('--primary', '#2563eb'), width: 2.5 },
    { label: 'Operating cash', values: run.series.cash, color: '#16a34a', width: 1.5, agg: 'min' },
    { label: 'Debt', values: run.series.liabilities, color: '#c2410c', width: 1.25, dash: [4, 4] }
  ], [run, lens, infl]);

  const floor = plan.settings.cashFloor;
  const staleDays = Math.round((parseYMD(todayYMD()) - parseYMD(plan.asOf)) / 86400000);
  const lastCheck = (plan.history || []).at(-1);
  const nearBreach = m.minCashNear.value < floor;
  const today = run.series;
  const upcoming = useMemo(() => {
    const until = toYMD(addDays(parseYMD(plan.asOf), 90));
    return run.ledger.filter(l => l.date <= until && l.kind !== 'note').slice(0, 14);
  }, [run]);

  const yearRows = useMemo(() => {
    const pl = yearly(run);
    const rows = [];
    for (let y = 1; y <= Math.min(plan.horizonYears, 60); y++) {
      const i = Math.min(run.N - 1, Math.round(y * 365.25));
      const r2 = pl[y - 1] || {};
      rows.push({ y, date: toYMD(run.dates[i]), nw: run.series.netWorth[i], cash: run.series.cash[i], income: r2.income, spending: r2.spending, taxes: r2.taxes, debtCost: (r2.interest || 0) + (r2.costs || 0), growth: r2.growth });
    }
    return rows;
  }, [run]);

  return html`<div class="stack">
    <div class="page-head">
      <div>
        <h2>${scenarioName(plan, scenarioId)}</h2>
        <p>Balances as of ${formatDate(plan.asOf)} · <a href="#/checkin">Update balances</a> · ${plan.horizonYears}-year horizon</p>
      </div>
    </div>
    ${staleDays > 30 ? html`<div class="notice info"><span>↻</span><div>Your balances are ${staleDays} days old. <a href="#/checkin">Check in</a> to refresh them — it takes a minute and shows how you're tracking against the plan.</div></div>` : null}
    ${lastCheck ? html`<div class="small muted">Last check-in ${formatDate(lastCheck.date)}: actual net worth ${compact(lastCheck.netWorth)} vs ${compact(lastCheck.plannedNetWorth)} expected (<span class=${lastCheck.netWorth >= lastCheck.plannedNetWorth ? 'pos' : 'neg'}>${signed(lastCheck.netWorth - lastCheck.plannedNetWorth)}</span>).</div>` : null}
    <${Diagnostics} diagnostics=${compiled.diagnostics} />
    <div class="kpis">
      <div class="card kpi"><div class="label">Net worth today</div><div class="value">${compact(today.netWorth[0])}</div><div class="sub">After tax ${compact(today.afterTax[0])}</div></div>
      <div class="card kpi"><div class="label">Operating cash</div><div class="value">${compact(today.cash[0])}</div><div class="sub">Floor ${compact(floor)}</div></div>
      <div class="card kpi"><div class="label">Lowest cash · next 3 years</div><div class=${cls('value', nearBreach && 'neg')}>${compact(m.minCashNear.value)}</div><div class="sub">${formatMonthYear(m.minCashNear.date)}${nearBreach ? ' · below floor' : ''}</div></div>
      <div class="card kpi"><div class="label">In 10 years</div><div class="value">${compact(m.at[10]?.afterTaxReal)}</div><div class="sub">After tax, today's dollars</div></div>
      <div class="card kpi"><div class="label">In ${plan.horizonYears} years</div><div class="value">${compact(m.end.afterTaxReal)}</div><div class="sub">Nominal ${compact(m.end.netWorth)}</div></div>
    </div>
    ${m.firstNegative ? html`<div class="notice" role="alert"><span>⚠</span><div>Cash goes negative on <b>${formatDate(m.firstNegative)}</b> and reaches ${money(m.minCash.value)} on ${formatDate(m.minCash.date)}. Add income, trim spending, or fund the gap from another account.</div></div>` : null}
    <div class="card">
      <div class="chart-toolbar">
        <${LensPicker} value=${lens} onChange=${setLens} />
        <${RangePicker} value=${years} onChange=${setYears} />
      </div>
      <${Chart} series=${series} dates=${run.dates} range=${rangeFor(run, years)} height=${320} refLines=${[{ value: floor, label: 'Cash floor', color: '#dc2626' }]} />
    </div>
    <${WhatIf} key=${scenarioId} scenarioId=${scenarioId} lens=${lens} years=${years} />
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3>Next 90 days</h3><span class="small muted">${upcoming.length} items</span></div>
        <div class="list">
          ${upcoming.length ? upcoming.map(l => html`<div class="list-item" style="cursor:default">
            <div class="title"><span class="name">${l.name}</span></div>
            <div class="meta">${formatDate(l.date)}${l.tax ? ` · tax ${money(l.tax)}` : ''}${l.note ? ` · ${l.note}` : ''}</div>
            <div class=${cls('amount', l.kind === 'income' || l.kind === 'sell' || l.kind === 'liquidate' ? 'pos' : '')}>${l.kind === 'income' || l.kind === 'sell' || l.kind === 'liquidate' ? '+' : l.kind === 'transfer' ? '' : '−'}${money(l.amount)}</div>
          </div>`) : html`<div class="empty">Nothing scheduled in the next 90 days.</div>`}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Where the change comes from</h3><span class="small muted">Next ${Math.min(years, plan.horizonYears)} years · nominal</span></div>
        <${Breakdown} run=${run} years=${Math.min(years, plan.horizonYears)} />
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Year by year</h3><span class="small muted">Each row is the 12 months ending on that date · nominal dollars</span></div>
      <div class="scroll-x" style="max-height:460px;overflow-y:auto">
        <table class="tbl">
          <thead><tr><th>Year ending</th><th>Income</th><th>Spending</th><th>Taxes</th><th>Interest & fees</th><th>Growth</th><th>Net worth</th><th>Cash</th></tr></thead>
          <tbody>${yearRows.map(r2 => html`<tr>
            <td>${formatMonthYear(r2.date)}</td>
            <td class="pos">${compact(r2.income)}</td>
            <td>${compact(-(r2.spending || 0))}</td>
            <td>${compact(-(r2.taxes || 0))}</td>
            <td>${compact(-(r2.debtCost || 0))}</td>
            <td class=${(r2.growth || 0) < 0 ? 'neg' : ''}>${signed(r2.growth || 0)}</td>
            <td><b>${compact(r2.nw)}</b></td>
            <td class=${r2.cash < floor ? 'neg' : ''}>${compact(r2.cash)}</td>
          </tr>`)}</tbody>
        </table>
      </div>
    </div>
  </div>`;
}

export { signed, tone };
