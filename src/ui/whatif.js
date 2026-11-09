// Quick what-if: try changes on top of the scenario you're viewing, see the effect instantly,
// and only save it as a scenario if it's worth keeping.
import { useMemo, useState } from 'preact/hooks';
import { html, compact, signed, cls } from './h.js';
import { store } from '../store.js';
import { getRun, scenarioName } from './runs.js';
import { compareRuns, verdictText } from '../engine/metrics.js';
import { effectiveSelections } from '../engine/compile.js';
import { newId, SCENARIO_COLORS } from '../engine/model.js';
import { PatchEditor } from './scenarios.js';
import { Chart, rangeFor } from './chart.js';
import { drivers } from './breakdown.js';
import { toast } from './toast.js';

const TEMP_ID = '__whatif';

export function WhatIf({ scenarioId, lens, years }) {
  const plan = store.plan;
  const base = effectiveSelections(plan, scenarioId);
  const [choices, setChoices] = useState({});
  const [cases, setCases] = useState({});
  const [patches, setPatches] = useState([]);
  const dirty = Object.keys(choices).length || Object.keys(cases).length || patches.some(p => p.value != null && p.value !== '');

  const tempPlan = useMemo(() => ({
    ...plan,
    scenarios: [...plan.scenarios, { id: TEMP_ID, name: 'What if', basedOn: scenarioId, choices, cases, patches: patches.filter(p => p.value != null && p.value !== '') }]
  }), [plan, scenarioId, choices, cases, patches]);

  const ref = getRun(plan, scenarioId);
  const alt = dirty ? getRun(tempPlan, TEMP_ID) : null;
  const cmp = alt ? compareRuns(ref, [alt], plan, lens)[0] : null;
  const top = alt ? drivers(ref.run, alt.run, Math.min(years, plan.horizonYears), 3) : [];

  const reset = () => { setChoices({}); setCases({}); setPatches([]); };
  const save = () => {
    const name = prompt('Name this scenario', 'What if…');
    if (!name) return;
    const s = { id: newId('scn'), name: name.trim(), color: SCENARIO_COLORS[plan.scenarios.length % SCENARIO_COLORS.length], basedOn: scenarioId, choices, cases, patches: patches.filter(p => p.value != null && p.value !== ''), createdAt: new Date().toISOString() };
    store.update(p => {
      p.scenarios.push(s);
      p.comparisons.push({ id: newId('cmp'), name: `${s.name} vs ${scenarioName(plan, scenarioId)}`, referenceId: scenarioId, scenarioIds: [scenarioId, s.id], stressAssumptionId: p.assumptions[0]?.id || '' });
    });
    reset();
    toast(`Saved "${s.name}" with a comparison against ${scenarioName(plan, scenarioId)}.`, 'ok');
  };

  const series = useMemo(() => (cmp ? [{ label: 'What if − current', values: cmp.delta, color: '#9333ea', width: 2.5, fill: '#9333ea22' }] : []), [cmp]);

  return html`<div class="card">
    <div class="card-head">
      <h3>What if…?</h3>
      <div class="row">
        ${dirty ? html`<button class="btn sm ghost" onClick=${reset}>Reset</button><button class="btn sm primary" onClick=${save}>Save as scenario</button>` : html`<span class="small muted">Try a change — nothing is saved until you choose to</span>`}
      </div>
    </div>
    <div class="whatif">
      <div class="whatif-controls">
        ${plan.decisions.map(d => html`<label class="field" key=${d.id}><span>${d.name}</span>
          <select value=${choices[d.id] || base.choices[d.id]} class=${choices[d.id] ? 'changed' : ''} onChange=${e => setChoices(c => { const n = { ...c }; if (e.target.value === base.choices[d.id]) delete n[d.id]; else n[d.id] = e.target.value; return n; })}>
            ${d.alternatives.map(a => html`<option value=${a.id}>${a.name}</option>`)}
          </select></label>`)}
        ${plan.assumptions.map(a => html`<label class="field" key=${a.id}><span>${a.name} <span class="faint">· assumption</span></span>
          <select value=${cases[a.id] || base.cases[a.id]} class=${cases[a.id] ? 'changed' : ''} onChange=${e => setCases(c => { const n = { ...c }; if (e.target.value === base.cases[a.id]) delete n[a.id]; else n[a.id] = e.target.value; return n; })}>
            ${a.cases.map(c => html`<option value=${c.id}>${c.name}</option>`)}
          </select></label>`)}
        <div class="field"><span>Change any value</span><${PatchEditor} plan=${plan} patches=${patches} onChange=${setPatches} label="+ Change a value (amount, rate, date…)" /></div>
      </div>
      <div class="whatif-result">
        ${!cmp ? html`<div class="empty small">Change something on the left to see how it compares with <b>${scenarioName(plan, scenarioId)}</b>.</div>` : html`
          <div class="lead" style="font-size:15px;line-height:1.5">${verdictText(cmp, scenarioName(plan, scenarioId), 'This change', compact)}</div>
          <div class="kpis" style="margin-top:12px">
            <div class="kpi card"><div class="label">Cash in 1 year</div><div class=${cls('value', cmp.cashDelta1y >= 0 ? 'pos' : 'neg')}>${signed(cmp.cashDelta1y)}</div></div>
            <div class="kpi card"><div class="label">Lowest cash · 3 yrs</div><div class=${cls('value', alt.metrics.minCashNear.value < plan.settings.cashFloor ? 'neg' : '')}>${compact(alt.metrics.minCashNear.value)}</div><div class="sub">${signed(cmp.liquidityDelta)} vs now</div></div>
            <div class="kpi card"><div class="label">In 10 years</div><div class=${cls('value', (cmp.deltasAt[10] ?? 0) >= 0 ? 'pos' : 'neg')}>${signed(cmp.deltasAt[10])}</div></div>
            <div class="kpi card"><div class="label">At the end</div><div class=${cls('value', cmp.endDelta >= 0 ? 'pos' : 'neg')}>${signed(cmp.endDelta)}</div><div class="sub">${(cmp.endPct * 100).toFixed(1)}%</div></div>
          </div>
          ${top.length ? html`<div class="small muted" style="margin-top:10px">Mostly from: ${top.map(t => `${t.label} (${signed(t.value)})`).join(' · ')}</div>` : null}
          <${Chart} series=${series} dates=${ref.run.dates} range=${rangeFor(ref.run, years)} height=${200} viewKey="whatif" refLines=${[{ value: 0, label: 'Current', color: '#94a3b8' }]} />
          ${alt.compiled.diagnostics.length ? html`<div class="notice small">${alt.compiled.diagnostics[0].message}</div>` : null}`}
      </div>
    </div>
  </div>`;
}
