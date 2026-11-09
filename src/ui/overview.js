import { useMemo } from 'preact/hooks';
import { html, money, compact, signed, tone, cls } from './h.js';
import { store, useUI } from '../store.js';
import { getRun, scenarioName } from './runs.js';
import { Chart, rangeFor, nudgeWindow, windowDays, durationLabel } from './chart.js';
import { LENSES, lensSeries } from '../engine/metrics.js';
import { formatDate, formatMonthYear, parseYMD, addDays, toYMD, todayYMD } from '../engine/dates.js';
import { Breakdown, yearly } from './breakdown.js';
import { WhatIf } from './whatif.js';
import { AddLine, SeriesChips, customSeries } from './lines.js';

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

const LENS_HELP = {
  afterTaxReal: "After-tax, today's dollars: what you'd keep if you sold everything and paid the taxes (capital gains, 401(k)/IRA income tax, selling costs) — shown in today's purchasing power, so inflation doesn't make the future look richer than it is.",
  afterTax: 'After-tax: what you would keep after selling everything and paying the taxes, in the dollars of each year (not adjusted for inflation).',
  netWorthReal: "Net worth, today's dollars: everything you own minus everything you owe, ignoring taxes, adjusted to today's purchasing power.",
  netWorth: 'Net worth: everything you own minus everything you owe, at face value and in the dollars of each year.'
};

const LENS_SHORT = { afterTaxReal: "After-tax · today's $", afterTax: 'After-tax', netWorthReal: "Net worth · today's $", netWorth: 'Net worth' };

export function LensPicker({ value, onChange }) {
  return html`<div class="seg hide-sm" aria-label="Measure">${LENSES.map(l => html`<button type="button" class=${l.id === value ? 'on' : ''} title=${l.label} onClick=${() => onChange(l.id)}>${LENS_SHORT[l.id]}</button>`)}</div>
    <select class="show-sm" value=${value} onChange=${e => onChange(e.target.value)} aria-label="Measure" style="width:auto">${LENSES.map(l => html`<option value=${l.id}>${LENS_SHORT[l.id]}</option>`)}</select>`;
}

const NUDGES = [['y', '1y', 'year'], ['m', '1mo', 'month'], ['w', '1w', 'week']];

// Presets plus ± day / week / month / year nudges for the end of the chart window.
export function RangePicker({ value, onChange, start, maxDays }) {
  const nudge = (u, dir) => onChange(nudgeWindow(value, start, u, dir, maxDays));
  const full = windowDays(value, start);
  const days = Math.min(maxDays, full);
  const shown = full > maxDays ? maxDays / 365.25 : value;
  const btn = (u, l, name, dir) => html`<button type="button" title=${`End the chart 1 ${name} ${dir < 0 ? 'earlier' : 'later'}`} aria-label=${`${dir < 0 ? 'Minus' : 'Plus'} 1 ${name}`}
    disabled=${dir < 0 ? days <= 7 : days >= maxDays} onClick=${() => nudge(u, dir)}>${dir < 0 ? '−' : '+'}${l}</button>`;
  return html`<div class="range-picker">
    <div class="seg" aria-label="Time range">${RANGES.map(([y, l]) => html`<button type="button" class=${y === value ? 'on' : ''} onClick=${() => onChange(y)}>${l}</button>`)}</div>
    <div class="nudge-row">
      <div class="nudges" role="group" aria-label="Adjust the end of the chart">
        ${NUDGES.map(([u, l, n]) => btn(u, l, n, -1))}
        <span class="nudge-sep" aria-hidden="true"></span>
        ${[...NUDGES].reverse().map(([u, l, n]) => btn(u, l, n, 1))}
      </div>
      <span class="range-label" aria-live="polite">to ${formatDate(toYMD(addDays(parseYMD(start), days)))} · ${durationLabel(shown, start)}</span>
    </div>
  </div>`;
}

export function Overview({ scenarioId }) {
  const plan = store.plan;
  const [lens, setLens] = useUI('lens', 'afterTaxReal');
  const [years, setYears] = useUI('overviewYears', 10);
  const [lines, setLines] = useUI('chartLines', []);
  const [chartView, setChartView] = useUI('chart:overview', { hidden: [], right: [] });
  const [showHelp, setShowHelp] = useUI('lensHelp', false);
  const r = getRun(plan, scenarioId);
  const { run, metrics: m, compiled } = r;
  const infl = plan.settings.inflation;
  const lensLabel = LENSES.find(l => l.id === lens)?.label;

  const series = useMemo(() => [
    { key: 'lens', label: lensLabel, values: lensSeries(run, lens, infl), color: cssColor('--primary', '#2563eb'), width: 2.5 },
    { key: 'cash', label: 'Operating cash', values: run.series.cash, color: '#16a34a', below: '#dc2626', width: 1.5, agg: 'min' },
    { key: 'debt', label: 'Debt', values: run.series.liabilities, color: '#c2410c', width: 1.25, dash: [4, 4] },
    ...customSeries(run, plan, lines, lens)
  ], [run, lens, infl, lines.join('|')]);

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

  // Messages that come and go as the plan changes (cash warnings, diagnostics, axis hints) sit
  // below the chart, so live edits never shift the chart or the controls above it.
  return html`<div class="stack">
    <div class="page-head">
      <div>
        <h2>${scenarioName(plan, scenarioId)}</h2>
        <p>Balances as of ${formatDate(plan.asOf)} · <a href="#/checkin">Update balances</a> · ${plan.horizonYears}-year horizon</p>
      </div>
    </div>
    ${staleDays > 30 ? html`<div class="notice info"><span>↻</span><div>Your balances are ${staleDays} days old. <a href="#/checkin">Check in</a> to refresh them — it takes a minute and shows how you're tracking against the plan.</div></div>` : null}
    ${lastCheck ? html`<div class="small muted">Last check-in ${formatDate(lastCheck.date)}: actual net worth ${compact(lastCheck.netWorth)} vs ${compact(lastCheck.plannedNetWorth)} expected (<span class=${lastCheck.netWorth >= lastCheck.plannedNetWorth ? 'pos' : 'neg'}>${signed(lastCheck.netWorth - lastCheck.plannedNetWorth)}</span>).</div>` : null}
    <div class="kpis">
      <div class="card kpi"><div class="label">Net worth today</div><div class="value">${compact(today.netWorth[0])}</div><div class="sub">After tax ${compact(today.afterTax[0])}</div></div>
      <div class="card kpi"><div class="label">Operating cash</div><div class="value">${compact(today.cash[0])}</div><div class="sub">Floor ${compact(floor)}</div></div>
      <div class="card kpi"><div class="label">Lowest cash · next 3 years</div><div class=${cls('value', nearBreach && 'neg')}>${compact(m.minCashNear.value)}</div><div class="sub">${formatMonthYear(m.minCashNear.date)}${nearBreach ? ' · below floor' : ''}</div></div>
      <div class="card kpi"><div class="label">In 10 years</div><div class="value">${compact(m.at[10]?.afterTaxReal)}</div><div class="sub">After tax, today's dollars</div></div>
      <div class="card kpi"><div class="label">In ${plan.horizonYears} years</div><div class="value">${compact(m.end.afterTaxReal)}</div><div class="sub">Nominal ${compact(m.end.netWorth)}</div></div>
    </div>
    <div class="card">
      <div class="chart-toolbar">
        <div class="row lens-row"><${LensPicker} value=${lens} onChange=${setLens} /><button type="button" class=${cls('help-btn', showHelp && 'on')} aria-expanded=${showHelp} aria-label="What do these measures mean?" title="What do these measures mean?" onClick=${() => setShowHelp(!showHelp)}>?</button><${AddLine} plan=${plan} value=${lines} onChange=${setLines} /></div>
        <${RangePicker} value=${years} onChange=${setYears} start=${plan.asOf} maxDays=${run.N - 1} />
      </div>
      ${showHelp ? html`<div class="lens-help small muted"><b>${LENS_HELP[lens].split(':')[0]}:</b>${LENS_HELP[lens].slice(LENS_HELP[lens].indexOf(':') + 1)} <span class="faint">After-tax counts what selling would cost you; “today's dollars” removes ${plan.settings.inflation}%/yr inflation; plain “Net worth” does neither.</span></div>` : null}
      <${SeriesChips} series=${series} view=${chartView} onView=${setChartView} range=${rangeFor(run, years)}
        removable=${k => lines.includes(k)} onRemove=${k => { setLines(lines.filter(x => x !== k)); setChartView({ ...chartView, hidden: (chartView.hidden || []).filter(x => x !== k), right: (chartView.right || []).filter(x => x !== k) }); }} />
      <${Chart} series=${series} dates=${run.dates} range=${rangeFor(run, years)} height=${320} refLines=${[{ value: floor, label: 'Cash floor', color: '#dc2626' }]} view=${chartView} onView=${setChartView} />
      <${SeriesChips} part="hint" series=${series} view=${chartView} onView=${setChartView} range=${rangeFor(run, years)} />
    </div>
    ${m.firstNegative ? html`<div class="notice" role="alert"><span>⚠</span><div>Cash goes negative on <b>${formatDate(m.firstNegative)}</b> and reaches ${money(m.minCash.value)} on ${formatDate(m.minCash.date)}. Add income, trim spending, or fund the gap from another account.</div></div>` : null}
    <${Diagnostics} diagnostics=${compiled.diagnostics} />
    <${WhatIf} key=${scenarioId} scenarioId=${scenarioId} lens=${lens} years=${years} />
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3>Next 90 days</h3><span class="small muted">${upcoming.length} items</span></div>
        <div class="list">
          ${upcoming.length ? upcoming.map(l => html`<div class="list-item" style="cursor:default">
            <div class="title"><span class="name">${l.name}</span></div>
            <div class="meta">${formatDate(l.date)}${l.tax ? ` · tax ${money(l.tax)}` : ''}${l.note ? ` · ${l.note}` : ''}</div>
            <div class=${cls('amount', INFLOW.has(l.kind) ? 'pos' : '')}>${INFLOW.has(l.kind) ? '+' : l.kind === 'transfer' ? '' : '−'}${money(l.amount)}</div>
          </div>`) : html`<div class="empty">Nothing scheduled in the next 90 days.</div>`}
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Where the change comes from</h3><span class="small muted">Next ${durationLabel(Math.min(years, plan.horizonYears), plan.asOf)} · nominal</span></div>
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
    <${TaxYears} plan=${plan} run=${run} />
  </div>`;
}

const INFLOW = new Set(['income', 'sell', 'liquidate', 'refund']);

function TaxYears({ plan, run }) {
  const rows = run.taxYears || [];
  if (!rows.length) return null;
  return html`<div class="card">
    <div class="card-head"><h3>Paychecks & taxes</h3><span class="small muted">Calendar years · withholding is trued up each April 15 · nominal dollars</span></div>
    <div class="scroll-x" style="max-height:460px;overflow-y:auto">
      <table class="tbl">
        <thead><tr><th>Tax year</th><th>Wages</th><th>Pre-tax deductions</th><th>Est. federal</th><th>Est. state</th><th>Social Security & Medicare</th><th>Withheld</th><th>Refund / owed</th><th>Bracket</th></tr></thead>
        <tbody>${rows.map(t => html`<tr>
          <td>${t.year}${t.includesEarlier ? html`<span class="faint" title="Includes pay before the as-of date (“paid so far”)">*</span>` : ''}</td>
          <td>${compact(t.wages)}</td>
          <td>${compact(t.pretax)}</td>
          <td>${compact(t.federal + t.addlMedicare)}</td>
          <td>${compact(t.state)}</td>
          <td>${compact(t.fica)}</td>
          <td>${compact(t.withheld)}</td>
          <td>${t.partial ? html`<span class="faint" title=${t.year > parseYMD(plan.asOf).getUTCFullYear() ? 'The plan ends before this year does' : 'Enter “Paid so far” on your paychecks to estimate this year'}>partial year</span>`
            : html`<span class=${t.due > 0 ? 'neg' : 'pos'}>${t.due > 0 ? `owe ${compact(t.due)}` : `refund ${compact(-t.due)}`}</span><span class="faint small"> · ${t.settledOn ? formatMonthYear(t.settledOn) : 'after horizon'}</span>`}</td>
          <td>${Math.round(t.marginal * 100)}%</td>
        </tr>`)}</tbody>
      </table>
    </div>
    ${rows.some(t => t.includesEarlier) ? html`<div class="card-pad small faint" style="padding-top:8px">* includes pay earlier in the year that you entered as “paid so far”.</div>` : null}
  </div>`;
}

export { signed, tone };
