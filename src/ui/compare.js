import { useMemo, useState } from 'preact/hooks';
import { html, money, compact, signed, tone, cls, pct } from './h.js';
import { store, useUI } from '../store.js';
import { getRun, getStress, scenarioName, scenarioColor } from './runs.js';
import { Chart, rangeFor, durationLabel } from './chart.js';
import { compareRuns, verdictText, lensSeries, LENSES } from '../engine/metrics.js';
import { scenarioDiff } from '../engine/compile.js';
import { newId } from '../engine/model.js';
import { formatMonthYear, formatDate } from '../engine/dates.js';
import { LensPicker, RangePicker, Diagnostics } from './overview.js';
import { toast } from './toast.js';
import { DriversView, drivers } from './breakdown.js';

const MAX_SCENARIOS = 5;

export function Compare() {
  const plan = store.plan;
  const [cmpIdRaw, setCmpId] = useUI('comparisonId', plan.comparisons[0]?.id || null);
  // A remembered id can be stale (e.g. after importing another plan): fall back to the first saved one.
  const cmpId = cmpIdRaw && !plan.comparisons.some(c => c.id === cmpIdRaw) ? plan.comparisons[0]?.id || null : cmpIdRaw;
  const [lens, setLens] = useUI('lens', 'afterTaxReal');
  const [years, setYears] = useUI('compareYears', 30);
  const [mode, setMode] = useUI('compareMode', 'difference');
  const saved = plan.comparisons.find(c => c.id === cmpId);
  const [scratch, setScratch] = useState(() => ({ scenarioIds: plan.scenarios.slice(0, 2).map(s => s.id), referenceId: plan.scenarios[0]?.id, stressAssumptionId: plan.assumptions[0]?.id || '' }));
  const cmp = saved || scratch;
  const ids = cmp.scenarioIds.filter(id => plan.scenarios.some(s => s.id === id));
  const refId = ids.includes(cmp.referenceId) ? cmp.referenceId : ids[0];

  const edit = patch => {
    if (saved) store.update(p => { Object.assign(p.comparisons.find(c => c.id === saved.id), patch); });
    else setScratch(s => ({ ...s, ...patch }));
  };
  const toggleScenario = id => {
    const next = ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id].slice(0, MAX_SCENARIOS);
    if (!next.length) return;
    edit({ scenarioIds: next, referenceId: next.includes(refId) ? refId : next[0] });
  };
  const saveAs = () => {
    const name = prompt('Name this comparison', ids.map(id => scenarioName(plan, id)).join(' vs '));
    if (!name) return;
    const c = { id: newId('cmp'), name: name.trim(), scenarioIds: ids, referenceId: refId, stressAssumptionId: cmp.stressAssumptionId || '' };
    store.update(p => { p.comparisons.push(c); });
    setCmpId(c.id);
    toast('Comparison saved. It re-runs against your latest plan every time you open it.', 'ok');
  };
  const removeSaved = () => {
    if (!saved || !confirm(`Delete the saved comparison "${saved.name}"? Scenarios are not affected.`)) return;
    store.update(p => { p.comparisons = p.comparisons.filter(c => c.id !== saved.id); });
    setScratch({ scenarioIds: ids, referenceId: refId, stressAssumptionId: cmp.stressAssumptionId });
    setCmpId(null);
  };

  const runs = ids.map(id => getRun(plan, id));
  const ref = runs.find(r => r.scenarioId === refId);
  const others = runs.filter(r => r.scenarioId !== refId);
  const results = useMemo(() => (ref ? compareRuns(ref, others, plan, lens) : []), [plan, ids.join(), refId, lens]);
  const infl = plan.settings.inflation;
  const lensLabel = LENSES.find(l => l.id === lens)?.label;

  const mainSeries = useMemo(() => {
    if (!ref) return [];
    if (mode === 'difference') {
      return results.map(c => ({ label: `${scenarioName(plan, c.scenarioId)} − ${scenarioName(plan, refId)}`, values: c.delta, color: scenarioColor(plan, c.scenarioId), width: 2.5, fill: scenarioColor(plan, c.scenarioId) + '22' }));
    }
    return runs.map(r => ({ label: scenarioName(plan, r.scenarioId), values: lensSeries(r.run, lens, infl), color: scenarioColor(plan, r.scenarioId), width: r.scenarioId === refId ? 3 : 2, dash: r.scenarioId === refId ? undefined : undefined }));
  }, [results, mode, lens, plan]);
  const cashSeries = useMemo(() => runs.map(r => ({ label: scenarioName(plan, r.scenarioId), values: r.run.series.cash, color: scenarioColor(plan, r.scenarioId), width: 2, agg: 'min' })), [plan, ids.join()]);

  const stressId = cmp.stressAssumptionId;
  const [stressOn, setStressOn] = useState(true);
  const stress = stressOn && stressId && plan.assumptions.some(a => a.id === stressId) && ids.length > 1 ? getStress(plan, ids, stressId, refId, lens) : null;

  if (!ref) return html`<div class="empty">Create at least one scenario to compare.</div>`;
  const allDiag = runs.flatMap(r => r.compiled.diagnostics);

  return html`<div class="stack">
    <div class="page-head">
      <div>
        <h2>Compare</h2>
        <p>Pick a reference (★) and up to ${MAX_SCENARIOS - 1} alternatives. Comparisons always run against your latest plan.</p>
      </div>
      <div class="row">
        <select value=${saved ? saved.id : ''} onChange=${e => setCmpId(e.target.value || null)} aria-label="Saved comparisons" style="width:auto;min-width:220px">
          <option value="">Unsaved comparison</option>
          ${plan.comparisons.map(c => html`<option value=${c.id}>${c.name}</option>`)}
        </select>
        ${saved ? html`<button class="btn sm ghost danger" onClick=${removeSaved}>Delete</button>` : html`<button class="btn sm primary" onClick=${saveAs}>Save comparison</button>`}
      </div>
    </div>

    <div class="card card-pad">
      <div class="scen-picker">
        ${plan.scenarios.map(s => {
          const on = ids.includes(s.id);
          return html`<span class=${cls('chip', on && 'on')} role="checkbox" aria-checked=${on} tabindex="0" onClick=${() => toggleScenario(s.id)} onKeyDown=${e => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), toggleScenario(s.id))}>
            <span class="dot" style=${`background:${s.color}`}></span>${s.name}
            ${on ? html`<span class="ref-star" role="button" title=${s.id === refId ? 'Reference' : 'Make this the reference'} onClick=${e => { e.stopPropagation(); edit({ referenceId: s.id }); }}>${s.id === refId ? '★' : '☆'}</span>` : null}
          </span>`;
        })}
      </div>
    </div>

    <${Diagnostics} diagnostics=${allDiag} />

    ${results.length ? html`<div class="card">
      <div class="card-head"><h3>Verdict</h3><span class="small muted">${lensLabel}</span></div>
      ${results.map(c => {
        const oName = scenarioName(plan, c.scenarioId);
        return html`<div class="verdict">
          <span class="dot" style=${`background:${scenarioColor(plan, c.scenarioId)};margin-top:6px`}></span>
          <div>
            <div class="lead">${verdictText(c, scenarioName(plan, refId), oName, compact)}</div>
            <div class="verdict-tags">
              <span class=${cls('badge', c.longTerm === 'better' ? 'pos' : c.longTerm === 'worse' ? 'neg' : '')}>Long term: ${c.longTerm === 'negligible' ? 'negligible' : c.longTerm === 'small' ? 'little difference' : c.longTerm}</span>
              <span class=${cls('badge', c.cashDelta1y > 1000 ? 'pos' : c.cashDelta1y < -1000 ? 'neg' : '')}>Cash in 1 yr: ${signed(c.cashDelta1y)}</span>
              <span class=${cls('badge', c.liquidityDelta > 1000 ? 'pos' : c.liquidityDelta < -1000 ? 'neg' : '')}>Lowest cash (3 yrs): ${signed(c.liquidityDelta)}</span>
              ${c.oBreach ? html`<span class="badge warn">Dips below floor</span>` : html`<span class="badge pos">Stays above floor</span>`}
              ${c.firstCrossover && c.crossovers.length > 1 ? html`<span class="badge">First crosses ${formatMonthYear(c.firstCrossover.date)}</span>` : null}
              ${(() => { const top = drivers(ref.run, runs.find(r => r.scenarioId === c.scenarioId).run, Math.min(years, plan.horizonYears), 1)[0]; return top ? html`<span class="badge blue">Main driver: ${top.label} (${signed(top.value)})</span>` : null; })()}
            </div>
          </div>
        </div>`;
      })}
    </div>` : html`<div class="notice info">Select a second scenario to see the comparison.</div>`}

    ${others.length ? html`<div class="card">
      <div class="card-head"><h3>What drives the difference</h3><span class="small muted">Nominal dollars · first ${durationLabel(Math.min(years, plan.horizonYears), plan.asOf)} (change with the range buttons)</span></div>
      ${others.map(o => html`<div style="border-bottom:1px solid var(--border)">
        <div class="row" style="padding:12px 18px 0"><span class="dot" style=${`background:${scenarioColor(plan, o.scenarioId)}`}></span><b>${scenarioName(plan, o.scenarioId)}</b></div>
        <${DriversView} refRun=${ref.run} run=${o.run} years=${Math.min(years, plan.horizonYears)} start=${plan.asOf} refName=${scenarioName(plan, refId)} name=${scenarioName(plan, o.scenarioId)} />
      </div>`)}
    </div>` : null}

    <div class="card">
      <div class="chart-toolbar">
        <div class="row">
          <div class="seg">${[['difference', 'Difference'], ['overlay', 'Side by side']].map(([k, l]) => html`<button type="button" class=${mode === k ? 'on' : ''} onClick=${() => setMode(k)}>${l}</button>`)}</div>
          <${LensPicker} value=${lens} onChange=${setLens} />
        </div>
        <${RangePicker} value=${years} onChange=${setYears} start=${plan.asOf} maxDays=${ref.run.N - 1} />
      </div>
      <p class="small muted" style="margin:6px 16px 0">${mode === 'difference' ? `How far each alternative is ahead of (above zero) or behind (below zero) ${scenarioName(plan, refId)}.` : 'Each scenario on the same scale.'}</p>
      <${Chart} series=${mainSeries} dates=${ref.run.dates} range=${rangeFor(ref.run, years)} height=${300} refLines=${mode === 'difference' ? [{ value: 0, label: scenarioName(plan, refId), color: '#94a3b8' }] : []} syncKey="cmp" />
    </div>

    <div class="card">
      <div class="card-head"><h3>Can I sustain it? · Operating cash</h3><span class="small muted">Lowest point in each period is shown</span></div>
      <${Chart} series=${cashSeries} dates=${ref.run.dates} range=${rangeFor(ref.run, Math.min(years, 10))} height=${240} refLines=${[{ value: plan.settings.cashFloor, label: 'Floor', color: '#dc2626' }, { value: 0, label: 'Zero', color: '#94a3b8' }]} syncKey="cmp" />
    </div>

    <${Scorecard} plan=${plan} runs=${runs} refId=${refId} lens=${lens} />

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3>What's different</h3></div>
        ${others.map(o => {
          const diff = scenarioDiff(plan, refId, o.scenarioId);
          return html`<div class="card-pad" style="border-bottom:1px solid var(--border)">
            <div class="row" style="margin-bottom:6px"><span class="dot" style=${`background:${scenarioColor(plan, o.scenarioId)}`}></span><b>${scenarioName(plan, o.scenarioId)}</b><span class="muted small">vs ${scenarioName(plan, refId)}</span></div>
            ${diff.length ? html`<table class="tbl"><tbody>${diff.map(l => html`<tr class="diff-row"><td>${l.label}<div class="small faint">${l.kind}</div></td><td class="muted">${l.a}</td><td><b>${l.b}</b></td></tr>`)}</tbody></table>` : html`<div class="small muted">No differences — these scenarios are identical.</div>`}
          </div>`;
        })}
        ${!others.length ? html`<div class="empty">Add another scenario.</div>` : null}
      </div>
      <div class="card">
        <div class="card-head">
          <h3>Stress test</h3>
          <select value=${stressId || ''} onChange=${e => edit({ stressAssumptionId: e.target.value })} style="width:auto" aria-label="Assumption to stress test">
            <option value="">Choose an assumption…</option>
            ${plan.assumptions.map(a => html`<option value=${a.id}>${a.name}</option>`)}
          </select>
        </div>
        ${stress ? html`<div class="scroll-x"><table class="tbl stress">
          <thead><tr><th>${stress.assumption.name}</th>${ids.filter(id => id !== refId).map(id => html`<th><span class="dot" style=${`background:${scenarioColor(plan, id)}`}></span> ${scenarioName(plan, id)}</th>`)}</tr></thead>
          <tbody>${stress.rows.map(row => html`<tr>
            <td>${row.caseName}</td>
            ${row.cells.filter(c => c.scenarioId !== refId).map(c => html`<td class=${cls('delta', tone(c.delta, 1000))}>${signed(c.delta)}<div class="small muted">low cash ${compact(c.minCash)}${c.breach ? ' ⚠' : ''}</div></td>`)}
          </tr>`)}</tbody>
        </table></div>
        <p class="small muted" style="margin:10px 16px 14px">End-of-horizon difference vs ${scenarioName(plan, refId)} (${lensLabel.toLowerCase()}) when every scenario is run under each case, with everything else held constant. If the sign never flips, the decision is robust to this assumption.</p>`
        : html`<div class="empty">${plan.assumptions.length ? 'Pick an assumption to see whether the answer holds up in other markets.' : 'Add an assumption (e.g. stock price Bear/Mid/Bull) under Decisions to stress-test.'}</div>`}
        ${stressId ? html`<div style="padding:0 16px 12px"><label class="check small"><input type="checkbox" checked=${stressOn} onChange=${e => setStressOn(e.target.checked)} /> Run stress test</label></div>` : null}
      </div>
    </div>
  </div>`;
}

function Scorecard({ plan, runs, refId, lens }) {
  const ref = runs.find(r => r.scenarioId === refId);
  const lensKey = lens;
  const rows = [
    { sec: 'Wealth' },
    ...Object.keys(ref.metrics.at).map(y => ({ label: `In ${y} year${y === '1' ? '' : 's'}`, get: m => m.at[y]?.[lensKey] })),
    { label: 'End of horizon', get: m => m.end[lensKey] },
    { label: 'Nominal net worth at end', get: m => m.end.netWorth },
    { sec: 'Cash & risk' },
    { label: 'Cash on hand in 1 year', get: m => m.at[1]?.cash },
    { label: 'Cash on hand in 3 years', get: m => m.at[3]?.cash },
    { label: 'Lowest cash · next 3 years', get: m => m.minCashNear.value, sub: m => formatMonthYear(m.minCashNear.date) },
    { label: 'Lowest cash · whole horizon', get: m => m.minCash.value, sub: m => formatMonthYear(m.minCash.date) },
    { label: 'First time below floor', text: m => (m.firstBelowFloor ? formatDate(m.firstBelowFloor) : 'Never') },
    { label: 'Days below floor', get: m => m.daysBelowFloor, plain: true, lowerIsBetter: true },
    { sec: 'Costs over the horizon' },
    { label: 'Estimated taxes', get: m => m.totals.taxes, lowerIsBetter: true },
    { label: 'Interest paid', get: m => m.totals.interest, lowerIsBetter: true },
    { label: 'Selling & closing costs', get: m => m.totals.costs, lowerIsBetter: true }
  ];
  return html`<div class="card">
    <div class="card-head"><h3>Scorecard</h3><span class="small muted">Differences are vs ★ ${scenarioName(plan, refId)}</span></div>
    <div class="scroll-x"><table class="tbl">
      <thead><tr><th></th>${runs.map(r => html`<th><span class="dot" style=${`background:${scenarioColor(plan, r.scenarioId)}`}></span> ${scenarioName(plan, r.scenarioId)}${r.scenarioId === refId ? ' ★' : ''}</th>`)}</tr></thead>
      <tbody>${rows.map(row => row.sec
        ? html`<tr class="sec"><td colspan=${runs.length + 1}>${row.sec}</td></tr>`
        : html`<tr><td>${row.label}</td>${runs.map(r => {
            if (row.text) return html`<td>${row.text(r.metrics)}</td>`;
            const v = row.get(r.metrics);
            const rv = row.get(ref.metrics);
            const d = v - rv;
            const good = row.lowerIsBetter ? -d : d;
            return html`<td>${row.plain ? (v ?? '—') : compact(v)}${r.scenarioId !== refId && Number.isFinite(d) && Math.abs(d) >= (row.plain ? 1 : 500)
              ? html`<div class=${cls('small', tone(good, row.plain ? 0.5 : 500))}>${row.plain ? `${d > 0 ? '+' : ''}${d}` : signed(d)}</div>` : null}
              ${row.sub ? html`<div class="small faint">${row.sub(r.metrics)}</div>` : null}</td>`;
          })}</tr>`)}
      </tbody>
    </table></div>
  </div>`;
}

export { money, pct };
