import { html, compact, signed, tone, cls } from './h.js';
import { store, useUI } from '../store.js';
import { getRun } from './runs.js';
import { effectiveSelections } from '../engine/compile.js';
import { newId, SCENARIO_COLORS, findItem, COLLECTIONS } from '../engine/model.js';
import { toast } from './toast.js';
import { navigate } from './nav.js';

export const PATCHABLE = {
  accounts: [['balance', 'Balance', 'number'], ['growth', 'Growth %/yr', 'number'], ['costBasis', 'Cost basis', 'number'], ['ownedFrom', 'Owned from', 'date']],
  debts: [['balance', 'Balance / amount', 'number'], ['rate', 'Rate %', 'number'], ['payment', 'Monthly payment', 'number'], ['payoffDate', 'Pay off on', 'date'], ['start', 'Starts on', 'date'], ['creditLimit', 'Credit limit', 'number'], ['termMonths', 'Term (months)', 'number'], ['feePct', 'Upfront fee %', 'number'], ['enabled', 'Included (true/false)', 'bool']],
  flows: [['amount', 'Amount', 'number'], ['growth', 'Growth %/yr', 'number'], ['pay.fedPct', 'Federal withholding %', 'number'], ['schedule.start', 'Start date', 'date'], ['schedule.end', 'End date', 'date'], ['enabled', 'Included (true/false)', 'bool']],
  events: [['date', 'Date', 'date'], ['price', 'Price', 'number'], ['costPct', 'Selling costs %', 'number'], ['amount', 'Amount', 'number'], ['loanAmount', 'Loan amount', 'number'], ['enabled', 'Included (true/false)', 'bool']],
  units: [['price', 'Price today', 'number'], ['growth', 'Growth %/yr', 'number']]
};

export function PatchEditor({ plan, patches = [], onChange, label = '+ Change a value' }) {
  const items = COLLECTIONS.flatMap(coll => plan[coll].map(x => ({ coll, id: x.id, name: x.name || x.type })));
  const setAt = (i, p) => onChange(patches.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return html`<div>
    ${patches.map((p, i) => {
      const hit = findItem(plan, p.id);
      const fields = hit ? PATCHABLE[hit.coll] : [];
      const type = fields.find(f => f[0] === p.field)?.[2] || 'number';
      return html`<div class="patch" key=${i}>
        <select value=${p.id} onChange=${e => setAt(i, { id: e.target.value, field: PATCHABLE[findItem(plan, e.target.value)?.coll]?.[0]?.[0] })} aria-label="Item">
          ${!hit ? html`<option value=${p.id}>Missing item</option>` : null}
          ${COLLECTIONS.map(coll => plan[coll].length ? html`<optgroup label=${coll}>${plan[coll].map(x => html`<option value=${x.id}>${x.name || x.type}</option>`)}</optgroup>` : null)}
        </select>
        <select value=${p.field} onChange=${e => setAt(i, { field: e.target.value })} aria-label="Field">
          ${fields.map(f => html`<option value=${f[0]}>${f[1]}</option>`)}
        </select>
        ${type === 'date' ? html`<input type="date" value=${p.value || ''} onInput=${e => setAt(i, { value: e.target.value })} aria-label="New value" />`
          : type === 'bool' ? html`<select value=${String(p.value)} onChange=${e => setAt(i, { value: e.target.value === 'true' })}><option value="true">Included</option><option value="false">Excluded</option></select>`
          : html`<input type="number" step="any" value=${p.value ?? ''} onInput=${e => setAt(i, { value: e.target.value === '' ? null : Number(e.target.value) })} aria-label="New value" />`}
        <button class="btn sm icon ghost" aria-label="Remove change" onClick=${() => onChange(patches.filter((_, j) => j !== i))}>×</button>
      </div>`;
    })}
    ${items.length ? html`<button class="btn sm" style="margin-top:8px" onClick=${() => {
      const first = items[0];
      onChange([...patches, { id: first.id, field: PATCHABLE[first.coll][0][0], value: null }]);
    }}>${label}</button>` : null}
  </div>`;
}

export function Scenarios() {
  const plan = store.plan;
  const [, setViewing] = useUI('scenarioId', 'baseline');
  const [, setCmpId] = useUI('comparisonId', null);
  const base = plan.scenarios[0];

  const updateScenario = (id, fn) => store.update(p => fn(p.scenarios.find(s => s.id === id)));
  const add = (from) => {
    const src = from || base;
    const s = { id: newId('scn'), name: from ? `${src.name} (variant)` : 'New scenario', color: SCENARIO_COLORS[plan.scenarios.length % SCENARIO_COLORS.length], basedOn: src.id, choices: {}, cases: {}, patches: [], createdAt: new Date().toISOString() };
    store.update(p => { p.scenarios.push(s); });
    toast(`Created "${s.name}" based on "${src.name}". Change a decision below to make it different.`, 'ok');
  };
  const remove = s => {
    if (plan.scenarios.length <= 1) return toast('Keep at least one scenario.', 'err');
    const children = plan.scenarios.filter(x => x.basedOn === s.id);
    if (!confirm(`Delete "${s.name}"?${children.length ? ` ${children.length} scenario(s) based on it will keep their own choices and inherit from its parent instead.` : ''}`)) return;
    store.update(p => {
      for (const c of p.scenarios) if (c.basedOn === s.id) { c.basedOn = s.basedOn; c.choices = { ...(s.choices || {}), ...(c.choices || {}) }; c.cases = { ...(s.cases || {}), ...(c.cases || {}) }; }
      p.scenarios = p.scenarios.filter(x => x.id !== s.id);
      for (const c of p.comparisons) c.scenarioIds = c.scenarioIds.filter(id => id !== s.id);
    });
  };
  const compareWithParent = s => {
    const refId = s.basedOn || base.id;
    const existing = plan.comparisons.find(c => c.scenarioIds.length === 2 && c.scenarioIds.includes(s.id) && c.scenarioIds.includes(refId));
    if (existing) { setCmpId(existing.id); navigate('compare'); return; }
    const c = { id: newId('cmp'), name: `${s.name} vs ${plan.scenarios.find(x => x.id === refId)?.name}`, referenceId: refId, scenarioIds: [refId, s.id], stressAssumptionId: plan.assumptions[0]?.id || '' };
    store.update(p => { p.comparisons.push(c); });
    setCmpId(c.id);
    navigate('compare');
  };

  return html`<div class="stack">
    <div class="page-head">
      <div>
        <h2>Scenarios</h2>
        <p>A scenario is just a set of choices — one alternative per decision and one case per assumption. It never copies your plan, so plan edits flow into every scenario automatically.</p>
      </div>
      <button class="btn primary" onClick=${() => add()}>+ New scenario</button>
    </div>
    <div class="scen-grid">
      ${plan.scenarios.map(s => {
        const sel = effectiveSelections(plan, s.id);
        const parent = s.basedOn ? effectiveSelections(plan, s.basedOn) : null;
        const r = getRun(plan, s.id);
        const baseRun = s.id !== base.id ? getRun(plan, base.id) : null;
        const delta = baseRun ? r.metrics.end.afterTaxReal - baseRun.metrics.end.afterTaxReal : null;
        const parentName = plan.scenarios.find(x => x.id === s.basedOn)?.name;
        return html`<div class="card scen-card" key=${s.id}>
          <div class="card-head" style="flex-wrap:nowrap">
            <input type="color" class="color-swatch" value=${s.color} aria-label="Scenario color" onChange=${e => updateScenario(s.id, x => { x.color = e.target.value; })} />
            <input class="name-input" type="text" value=${s.name} aria-label="Scenario name" onChange=${e => updateScenario(s.id, x => { x.name = e.target.value.trim() || x.name; })} />
          </div>
          <div class="card-pad" style="padding-top:10px">
            <div class="row small muted" style="margin-bottom:6px">
              <span>Based on</span>
              <select style="width:auto;height:30px" value=${s.basedOn || ''} onChange=${e => updateScenario(s.id, x => { x.basedOn = e.target.value || undefined; })}>
                <option value="">Plan defaults</option>
                ${plan.scenarios.filter(x => x.id !== s.id).map(x => html`<option value=${x.id}>${x.name}</option>`)}
              </select>
            </div>
            <div class="row" style="gap:12px;margin:6px 0 10px">
              <div><div class="small muted">After tax at end (today's $)</div><b class="num">${compact(r.metrics.end.afterTaxReal)}</b>${delta != null ? html` <span class=${cls('small', tone(delta, 1000))}>${signed(delta)} vs ${base.name}</span>` : null}</div>
              <div><div class="small muted">Lowest cash · 3 yrs</div><b class=${cls('num', r.metrics.minCashNear.value < plan.settings.cashFloor && 'neg')}>${compact(r.metrics.minCashNear.value)}</b></div>
            </div>
            ${plan.decisions.map(d => {
              const own = (s.choices || {})[d.id];
              const inherited = parent ? parent.choices[d.id] : (d.defaultAlt || d.alternatives[0]?.id);
              return html`<div class="choice" key=${d.id}>
                <label for=${`c-${s.id}-${d.id}`}>${d.name}</label>
                <select id=${`c-${s.id}-${d.id}`} class=${own && own !== inherited ? 'changed' : ''} value=${sel.choices[d.id]} onChange=${e => updateScenario(s.id, x => {
                  x.choices = { ...(x.choices || {}) };
                  if (e.target.value === inherited) delete x.choices[d.id]; else x.choices[d.id] = e.target.value;
                })}>
                  ${d.alternatives.map(a => html`<option value=${a.id}>${a.name}${a.id === inherited ? (parentName ? ` (as ${parentName})` : ' (default)') : ''}</option>`)}
                </select>
              </div>`;
            })}
            ${plan.assumptions.map(a => {
              const own = (s.cases || {})[a.id];
              const inherited = parent ? parent.cases[a.id] : (a.defaultCase || a.cases[0]?.id);
              return html`<div class="choice" key=${a.id}>
                <label for=${`a-${s.id}-${a.id}`}>${a.name} <span class="faint">· assumption</span></label>
                <select id=${`a-${s.id}-${a.id}`} class=${own && own !== inherited ? 'changed' : ''} value=${sel.cases[a.id]} onChange=${e => updateScenario(s.id, x => {
                  x.cases = { ...(x.cases || {}) };
                  if (e.target.value === inherited) delete x.cases[a.id]; else x.cases[a.id] = e.target.value;
                })}>
                  ${a.cases.map(c => html`<option value=${c.id}>${c.name}${c.id === inherited ? (parentName ? ` (as ${parentName})` : ' (default)') : ''}</option>`)}
                </select>
              </div>`;
            })}
            ${!plan.decisions.length && !plan.assumptions.length ? html`<p class="small muted">Create decisions (things you control) and assumptions (things you don't) to give scenarios something to choose.</p>` : null}
            <details class="more" open=${!!(s.patches || []).length} style="margin-top:8px">
              <summary>Scenario-only tweaks ${(s.patches || []).length ? html`<span class="badge blue">${s.patches.length}</span>` : null}</summary>
              <p class="small muted" style="margin:0 0 6px">One-off value changes that apply only to this scenario (and scenarios based on it).</p>
              <${PatchEditor} plan=${plan} patches=${s.patches || []} onChange=${v => updateScenario(s.id, x => { x.patches = v; })} />
            </details>
          </div>
          <div class="foot">
            <button class="btn sm" onClick=${() => { setViewing(s.id); navigate('overview'); }}>View</button>
            ${s.id !== base.id || s.basedOn ? html`<button class="btn sm" onClick=${() => compareWithParent(s)}>Compare with ${parentName || base.name}</button>` : null}
            <button class="btn sm ghost" onClick=${() => add(s)}>Variant</button>
            <button class="btn sm ghost danger" onClick=${() => remove(s)}>Delete</button>
          </div>
        </div>`;
      })}
    </div>
  </div>`;
}
