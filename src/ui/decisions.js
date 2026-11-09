import { useState } from 'preact/hooks';
import { html, money, cls } from './h.js';
import { store, useUI } from '../store.js';
import { newId, SCENARIO_COLORS, COLLECTIONS, findItem } from '../engine/model.js';
import { addMonths, addDays, parseYMD, toYMD, todayYMD } from '../engine/dates.js';
import { ItemSheet, Field, Num, Text, DateIn, Select, Waterfall, accountOptions, debtOptions } from './editors.js';
import { PatchEditor } from './scenarios.js';
import { toast } from './toast.js';
import { navigate } from './nav.js';

function itemsIn(plan, decisionId, altId) {
  return COLLECTIONS.flatMap(coll => plan[coll].filter(x => x.when?.[decisionId]?.includes(altId)).map(x => ({ coll, item: x })));
}

const monthsFromNow = n => toYMD(addMonths(parseYMD(todayYMD()), n));

export function Decisions() {
  const plan = store.plan;
  const [sheet, setSheet] = useState(null);
  const [template, setTemplate] = useState(null);
  const [, setCmpId] = useUI('comparisonId', null);

  const upd = fn => store.update(fn);
  const decisionUsage = d => plan.scenarios.filter(s => (s.choices || {})[d.id]).map(s => s.name);

  return html`<div class="stack">
    <div class="page-head">
      <div>
        <h2>Decisions & assumptions</h2>
        <p><b>Decisions</b> are choices you control (sell or keep, pay off or not). <b>Assumptions</b> are things you don't (stock prices, appreciation, inflation). Scenarios pick one of each; comparisons stress-test decisions against assumptions.</p>
      </div>
      <div class="row">
        <select value="" onChange=${e => { if (e.target.value) setTemplate(e.target.value); e.target.value = ''; }} aria-label="New decision" style="width:auto">
          <option value="">+ New decision…</option>
          <option value="borrow">Borrow money (credit line, 0% card, loan)</option>
          <option value="sell">Sell or keep an asset</option>
          <option value="payoff">Pay off a debt early</option>
          <option value="stock">Sell company stock on a schedule</option>
          <option value="buy">Buy a home</option>
          <option value="group">Switch a group of cash flows on/off</option>
          <option value="blank">Blank decision</option>
        </select>
        <select value="" onChange=${e => { if (e.target.value) addAssumption(e.target.value, plan); e.target.value = ''; }} aria-label="New assumption" style="width:auto">
          <option value="">+ New assumption…</option>
          <option value="inflation">Inflation (low / base / high)</option>
          <option value="price">Stock price paths (bear / mid / bull)</option>
          <option value="growth">Investment returns (low / base / high)</option>
          <option value="blank">Blank assumption</option>
        </select>
      </div>
    </div>

    ${!plan.decisions.length ? html`<div class="card empty">No decisions yet. Start with a template above — e.g. "Sell or keep an asset".</div>` : null}
    ${plan.decisions.map(d => html`<div class="card" key=${d.id}>
      <div class="card-head" style="flex-wrap:nowrap">
        <input class="name-input" type="text" value=${d.name} aria-label="Decision name" onChange=${e => upd(p => { p.decisions.find(x => x.id === d.id).name = e.target.value.trim() || d.name; })} />
        <span class="badge">Decision</span>
        <button class="btn sm ghost danger" onClick=${() => {
          if (!confirm(`Delete "${d.name}"? Items that exist only in its alternatives will stay in the plan but no longer be tied to it.`)) return;
          upd(p => {
            p.decisions = p.decisions.filter(x => x.id !== d.id);
            for (const coll of COLLECTIONS) for (const it of p[coll]) if (it.when?.[d.id]) { delete it.when[d.id]; if (!Object.keys(it.when).length) delete it.when; }
            for (const s of p.scenarios) if (s.choices) delete s.choices[d.id];
          });
        }}>Delete</button>
      </div>
      <div class="card-pad">
        <input type="text" placeholder="What are you deciding? (optional)" value=${d.notes || ''} onChange=${e => upd(p => { p.decisions.find(x => x.id === d.id).notes = e.target.value; })} style="margin-bottom:12px" />
        ${d.alternatives.map(a => {
          const owned = itemsIn(plan, d.id, a.id);
          return html`<div class="alt" key=${a.id}>
            <div class="alt-head">
              <label class="check small" title="Plan default (used unless a scenario picks otherwise)"><input type="radio" name=${`def-${d.id}`} checked=${(d.defaultAlt || d.alternatives[0]?.id) === a.id} onChange=${() => upd(p => { p.decisions.find(x => x.id === d.id).defaultAlt = a.id; })} /> Default</label>
              <input class="name-input" type="text" value=${a.name} aria-label="Alternative name" style="flex:1;font-size:14px" onChange=${e => upd(p => { p.decisions.find(x => x.id === d.id).alternatives.find(x => x.id === a.id).name = e.target.value.trim() || a.name; })} />
              ${d.alternatives.length > 1 ? html`<button class="btn sm icon ghost" aria-label="Delete alternative" onClick=${() => {
                if (!confirm(`Delete alternative "${a.name}"?`)) return;
                upd(p => {
                  const dd = p.decisions.find(x => x.id === d.id);
                  dd.alternatives = dd.alternatives.filter(x => x.id !== a.id);
                  if (dd.defaultAlt === a.id) dd.defaultAlt = dd.alternatives[0]?.id;
                  for (const coll of COLLECTIONS) for (const it of p[coll]) if (it.when?.[d.id]) it.when[d.id] = it.when[d.id].filter(x => x !== a.id);
                  for (const s of p.scenarios) if (s.choices?.[d.id] === a.id) delete s.choices[d.id];
                });
              }}>×</button>` : null}
            </div>
            <div class="small muted" style="margin-top:6px">${owned.length ? 'Only in this alternative:' : 'No items belong only to this alternative.'}</div>
            ${owned.length ? html`<div class="alt-items">${owned.map(({ coll, item }) => html`<span class="chip" role="button" tabindex="0" onClick=${() => setSheet({ coll, id: item.id })}>${item.name || item.type}</span>`)}</div>` : null}
            <div style="margin-top:8px">
              <${PatchEditor} plan=${plan} patches=${a.patches || []} label="+ Change a value in this alternative" onChange=${v => upd(p => { p.decisions.find(x => x.id === d.id).alternatives.find(x => x.id === a.id).patches = v; })} />
            </div>
          </div>`;
        })}
        <div class="row" style="margin-top:10px">
          <button class="btn sm" onClick=${() => upd(p => { p.decisions.find(x => x.id === d.id).alternatives.push({ id: newId('alt'), name: `Option ${d.alternatives.length + 1}`, patches: [] }); })}>+ Add alternative</button>
          <span class="small muted">${decisionUsage(d).length ? `Chosen explicitly in: ${decisionUsage(d).join(', ')}` : 'No scenario overrides the default yet.'}</span>
        </div>
      </div>
    </div>`)}

    ${plan.assumptions.map(a => html`<div class="card" key=${a.id}>
      <div class="card-head" style="flex-wrap:nowrap">
        <input class="name-input" type="text" value=${a.name} aria-label="Assumption name" onChange=${e => upd(p => { p.assumptions.find(x => x.id === a.id).name = e.target.value.trim() || a.name; })} />
        <span class="badge warn">Assumption</span>
        <button class="btn sm ghost danger" onClick=${() => {
          if (!confirm(`Delete "${a.name}"?`)) return;
          upd(p => {
            p.assumptions = p.assumptions.filter(x => x.id !== a.id);
            for (const u of p.units) if (u.assumptionId === a.id) delete u.assumptionId;
            for (const s of p.scenarios) if (s.cases) delete s.cases[a.id];
          });
        }}>Delete</button>
      </div>
      <div class="card-pad">
        ${plan.units.filter(u => u.assumptionId === a.id).map(u => html`<div class="small muted" style="margin-bottom:8px">Drives the price of <a href="#/plan/units">${u.name}</a> — each case has its own price targets.</div>`)}
        ${a.cases.map(c => html`<div class="alt" key=${c.id}>
          <div class="alt-head">
            <label class="check small"><input type="radio" name=${`defc-${a.id}`} checked=${(a.defaultCase || a.cases[0]?.id) === c.id} onChange=${() => upd(p => { p.assumptions.find(x => x.id === a.id).defaultCase = c.id; })} /> Default</label>
            <input class="name-input" type="text" value=${c.name} aria-label="Case name" style="flex:1;font-size:14px" onChange=${e => upd(p => { p.assumptions.find(x => x.id === a.id).cases.find(x => x.id === c.id).name = e.target.value.trim() || c.name; })} />
            ${a.cases.length > 1 ? html`<button class="btn sm icon ghost" aria-label="Delete case" onClick=${() => upd(p => { const aa = p.assumptions.find(x => x.id === a.id); aa.cases = aa.cases.filter(x => x.id !== c.id); if (aa.defaultCase === c.id) aa.defaultCase = aa.cases[0]?.id; })}>×</button>` : null}
          </div>
          <div style="margin-top:6px">
            <${PatchEditor} plan=${plan} patches=${c.patches || []} label="+ Change a value in this case" onChange=${v => upd(p => { p.assumptions.find(x => x.id === a.id).cases.find(x => x.id === c.id).patches = v; })} />
          </div>
        </div>`)}
        <button class="btn sm" style="margin-top:10px" onClick=${() => upd(p => { p.assumptions.find(x => x.id === a.id).cases.push({ id: newId('case'), name: `Case ${a.cases.length + 1}`, patches: [] }); })}>+ Add case</button>
      </div>
    </div>`)}

    ${sheet ? html`<${ItemSheet} coll=${sheet.coll} id=${sheet.id} onClose=${() => setSheet(null)} />` : null}
    ${template ? html`<${TemplateSheet} kind=${template} onClose=${() => setTemplate(null)} onDone=${cmpId => { setTemplate(null); if (cmpId) { setCmpId(cmpId); navigate('compare'); } }} />` : null}
  </div>`;
}

function addAssumption(kind, plan) {
  const id = newId('asm');
  const c = () => newId('case');
  let asm;
  if (kind === 'inflation') {
    asm = { id, name: 'Inflation', cases: [
      { id: c(), name: 'Low (2%)', patches: [{ id: 'settings', field: 'inflation', value: 2 }] },
      { id: c(), name: `Base (${plan.settings.inflation}%)`, patches: [] },
      { id: c(), name: 'High (4.5%)', patches: [{ id: 'settings', field: 'inflation', value: 4.5 }] }
    ] };
    asm.defaultCase = asm.cases[1].id;
  } else if (kind === 'price') {
    const unit = plan.units.find(u => !u.assumptionId) || plan.units[0];
    if (!unit) { toast('Add a stock price model first (Plan → Prices).', 'err'); return; }
    asm = { id, name: `${unit.name} price`, cases: [{ id: c(), name: 'Bear', patches: [] }, { id: c(), name: 'Mid', patches: [] }, { id: c(), name: 'Bull', patches: [] }] };
    asm.defaultCase = asm.cases[1].id;
    store.update(p => { p.assumptions.push(asm); p.units.find(u => u.id === unit.id).assumptionId = id; });
    toast(`Created "${asm.name}". Add price targets for each case under Plan → Prices.`, 'ok');
    return;
  } else if (kind === 'growth') {
    const invest = plan.accounts.filter(a => ['brokerage', 'traditional', 'roth', 'hsa', 'education'].includes(a.kind));
    const mk = delta => invest.map(a => ({ id: a.id, field: 'growth', value: Math.round(((Number(a.growth) || 0) + delta) * 10) / 10 }));
    asm = { id, name: 'Investment returns', cases: [{ id: c(), name: 'Low (−2%)', patches: mk(-2) }, { id: c(), name: 'As planned', patches: [] }, { id: c(), name: 'High (+2%)', patches: mk(2) }] };
    asm.defaultCase = asm.cases[1].id;
  } else {
    asm = { id, name: 'New assumption', cases: [{ id: c(), name: 'Low', patches: [] }, { id: c(), name: 'Base', patches: [] }, { id: c(), name: 'High', patches: [] }] };
    asm.defaultCase = asm.cases[1].id;
  }
  store.update(p => { p.assumptions.push(asm); });
}

// ---------- templates ----------
function amortizedPayment(principal, ratePct, years) {
  const r = ratePct / 100 / 12;
  const n = years * 12;
  if (!r) return principal / n;
  return principal * r / (1 - (1 + r) ** -n);
}

function TemplateSheet({ kind, onClose, onDone }) {
  const plan = store.plan;
  const firstProp = plan.accounts.find(a => a.kind === 'property') || plan.accounts.find(a => a.kind === 'other');
  const [v, setV] = useState({
    assetId: firstProp?.id, date: monthsFromNow(6), costPct: 6, fixedCost: 0,
    debtId: plan.debts[0]?.id, from: [],
    equityId: plan.accounts.find(a => a.kind === 'equity')?.id, pct: 10, years: 3, to: plan.accounts.find(a => a.kind === 'brokerage')?.id,
    groupId: plan.groups[0]?.id,
    homeName: 'New home', price: 500000, downPct: 20, rate: 6.5, term: 30, growth: 3, taxPct: 1.2, insurance: 1800, upkeepPct: 1,
    makeScenario: true,
    bKind: 'line', bName: 'Home equity line', bStart: monthsFromNow(1), bLimit: 100000, bDraw: 0, bAmount: 10000, bRate: 8.5,
    bPromoRate: 0, bPromoMonths: 18, bAfterRate: 24.99, bFeePct: 3, bMinPct: 1, bMinFloor: 35, bPayoffAtEnd: true,
    bTerm: 60, bTo: plan.settings.primaryCashId, bTransferAll: false, bSafety: true, bSecured: plan.accounts.find(a => a.primaryResidence)?.id || firstProp?.id
  });
  const set = (k, x) => setV(s => ({ ...s, [k]: x }));
  const setKind = k => setV(s => ({
    ...s,
    bKind: k,
    bName: { line: 'Home equity line', promo: '0% intro card', loan: 'Personal loan' }[k],
    bRate: { line: 8.5, promo: 0, loan: 9.5 }[k],
    bFeePct: { line: 0, promo: 3, loan: 0 }[k]
  }));
  const proceedsOptions = [...accountOptions(plan), ...plan.debts.map(x => ({ value: x.id, label: `Pay off ${x.name}` }))];
  const proceedsIsDebt = plan.debts.some(x => x.id === v.bTo);
  const title = { borrow: 'Borrow money', sell: 'Sell or keep an asset', payoff: 'Pay off a debt early', stock: 'Sell company stock on a schedule', buy: 'Buy a home', group: 'Switch a group of cash flows on/off', blank: 'Blank decision' }[kind];

  const create = () => {
    const decId = newId('dec');
    const altA = newId('alt');
    const altB = newId('alt');
    let decision;
    const items = { accounts: [], debts: [], flows: [], events: [] };
    const tagFlows = [];
    if (kind === 'borrow') {
      const debtId = newId('debt');
      const w = { [decId]: [altB] };
      const base = { id: debtId, name: v.bName || 'New loan', start: v.bStart, paymentDay: 1, payFrom: [], when: w };
      let debt;
      if (v.bKind === 'line') {
        debt = { ...base, balance: v.bDraw || 0, proceedsTo: v.bDraw ? v.bTo : undefined, creditLimit: v.bLimit, rate: v.bRate, paymentRule: 'interestOnly', securedBy: v.bSecured || undefined };
      } else if (v.bKind === 'promo') {
        const end = toYMD(addMonths(parseYMD(v.bStart), v.bPromoMonths || 12));
        debt = { ...base, balance: v.bAmount, proceedsTo: v.bTo, transferAll: proceedsIsDebt && v.bTransferAll, feePct: v.bFeePct, rate: v.bPromoRate,
          rateSteps: [{ date: end, rate: v.bAfterRate }], paymentRule: 'minimum', minPct: v.bMinPct, payment: v.bMinFloor, payoffDate: v.bPayoffAtEnd ? toYMD(addDays(parseYMD(end), -1)) : undefined };
      } else {
        debt = { ...base, balance: v.bAmount, proceedsTo: v.bTo, transferAll: proceedsIsDebt && v.bTransferAll, feePct: v.bFeePct, rate: v.bRate, paymentRule: 'amortize', termMonths: v.bTerm };
      }
      items.debts.push(debt);
      decision = { id: decId, name: `${debt.name}?`, defaultAlt: altA, alternatives: [{ id: altA, name: "Don't borrow", patches: [] }, { id: altB, name: `Open ${debt.name}`, patches: [] }] };
      if (v.bKind === 'line' && v.bSafety) tagFlows.push({ safetyNet: debtId });
    } else if (kind === 'sell') {
      const asset = plan.accounts.find(a => a.id === v.assetId);
      if (!asset) return toast('Choose an asset.', 'err');
      decision = { id: decId, name: `${asset.name}: keep or sell?`, defaultAlt: altA, alternatives: [{ id: altA, name: `Keep ${asset.name}`, patches: [] }, { id: altB, name: `Sell ${v.date}`, patches: [] }] };
      items.events.push({ id: newId('evt'), type: 'sell', name: `Sell ${asset.name}`, assetId: asset.id, date: v.date, costPct: v.costPct, fixedCost: v.fixedCost, when: { [decId]: [altB] } });
      if (v.groupId) tagFlows.push({ group: v.groupId, alt: altA });
    } else if (kind === 'payoff') {
      const debt = plan.debts.find(x => x.id === v.debtId);
      if (!debt) return toast('Choose a debt.', 'err');
      decision = { id: decId, name: `${debt.name}: pay off early?`, defaultAlt: altA, alternatives: [{ id: altA, name: 'Keep the schedule', patches: [] }, { id: altB, name: `Pay off ${v.date}`, patches: [] }] };
      items.events.push({ id: newId('evt'), type: 'payoff', name: `Pay off ${debt.name}`, debtId: debt.id, date: v.date, from: v.from, when: { [decId]: [altB] } });
    } else if (kind === 'stock') {
      const eq = plan.accounts.find(a => a.id === v.equityId);
      if (!eq) return toast('Choose a holding.', 'err');
      decision = { id: decId, name: `${eq.name}: hold or diversify?`, defaultAlt: altA, alternatives: [{ id: altA, name: 'Hold', patches: [] }, { id: altB, name: `Sell ${v.pct}% per quarter for ${v.years} yrs`, patches: [] }] };
      const start = monthsFromNow(1);
      items.events.push({ id: newId('evt'), type: 'liquidate', name: `Sell ${eq.name} quarterly`, assetId: eq.id, mode: 'percent', amount: v.pct, to: v.to, schedule: { freq: 'quarterly', start, end: toYMD(addMonths(parseYMD(start), v.years * 12)) }, when: { [decId]: [altB] } });
    } else if (kind === 'buy') {
      const homeId = newId('acct');
      const loanId = newId('debt');
      const loan = v.price * (1 - v.downPct / 100);
      decision = { id: decId, name: `Buy ${v.homeName}?`, defaultAlt: altA, alternatives: [{ id: altA, name: "Don't buy", patches: [] }, { id: altB, name: `Buy ${v.date}`, patches: [] }] };
      const w = { [decId]: [altB] };
      items.accounts.push({ id: homeId, name: v.homeName, kind: 'property', balance: 0, growth: v.growth, ownedFrom: v.date, tags: [], when: w });
      items.debts.push({ id: loanId, name: `${v.homeName} mortgage`, balance: 0, rate: v.rate, payment: Math.round(amortizedPayment(loan, v.rate, v.term) * 100) / 100, paymentDay: 1, securedBy: homeId, payFrom: [], when: w });
      items.events.push({ id: newId('evt'), type: 'buy', name: `Buy ${v.homeName}`, assetId: homeId, debtId: loanId, date: v.date, price: v.price, closingPct: 3, loanAmount: loan, from: v.from, when: w });
      const start = v.date;
      items.flows.push(
        { id: newId('flow'), name: `${v.homeName} property tax`, amount: Math.round(v.price * v.taxPct / 100), growth: 3, schedule: { freq: 'annual', start }, from: [], to: null, whileOwned: homeId, steps: [], when: w },
        { id: newId('flow'), name: `${v.homeName} insurance`, amount: v.insurance, growth: 4, schedule: { freq: 'annual', start }, from: [], to: null, whileOwned: homeId, steps: [], when: w },
        { id: newId('flow'), name: `${v.homeName} upkeep`, amount: Math.round(v.price * v.upkeepPct / 100 / 4), growth: 3, schedule: { freq: 'quarterly', start }, from: [], to: null, whileOwned: homeId, steps: [], when: w }
      );
    } else if (kind === 'group') {
      const g = plan.groups.find(x => x.id === v.groupId);
      if (!g) return toast('Choose a group.', 'err');
      decision = { id: decId, name: `${g.name}?`, defaultAlt: altA, alternatives: [{ id: altA, name: `With ${g.name}`, patches: [] }, { id: altB, name: `Without ${g.name}`, patches: [] }] };
      tagFlows.push({ group: g.id, alt: altA });
    } else {
      decision = { id: decId, name: 'New decision', defaultAlt: altA, alternatives: [{ id: altA, name: 'Option A', patches: [] }, { id: altB, name: 'Option B', patches: [] }] };
    }
    let cmpId = null;
    store.update(p => {
      p.decisions.push(decision);
      for (const coll of Object.keys(items)) p[coll].push(...items[coll]);
      for (const t of tagFlows) {
        if (t.safetyNet) { p.settings.safetyNet = [...new Set([...(p.settings.safetyNet || []), t.safetyNet])]; continue; }
        for (const f of p.flows) if (f.group === t.group) f.when = { ...(f.when || {}), [decId]: [t.alt] };
      }
      if (v.makeScenario && kind !== 'blank') {
        const sid = newId('scn');
        p.scenarios.push({ id: sid, name: decision.alternatives[1].name, color: SCENARIO_COLORS[p.scenarios.length % SCENARIO_COLORS.length], basedOn: p.scenarios[0].id, choices: { [decId]: altB }, cases: {}, patches: [] });
        cmpId = newId('cmp');
        p.comparisons.push({ id: cmpId, name: decision.name, referenceId: p.scenarios[0].id, scenarioIds: [p.scenarios[0].id, sid], stressAssumptionId: p.assumptions[0]?.id || '' });
      }
    });
    toast(cmpId ? `Created "${decision.name}" with a scenario and a comparison.` : `Created "${decision.name}".`, 'ok');
    onDone(cmpId);
  };

  return html`<div class="sheet-backdrop" onClick=${e => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="sheet" role="dialog" aria-modal="true" aria-label=${title}>
      <div class="sheet-head"><h3>${title}</h3><button class="btn icon ghost" aria-label="Close" onClick=${onClose}>✕</button></div>
      <div class="sheet-body">
        ${kind === 'borrow' ? html`
          <div class="seg">${[['line', 'Line of credit (HELOC)'], ['promo', '0% intro card / transfer'], ['loan', 'Installment loan']].map(([k, l]) => html`<button type="button" class=${v.bKind === k ? 'on' : ''} onClick=${() => setKind(k)}>${l}</button>`)}</div>
          <div class="form-grid">
            <${Field} label="Name"><${Text} value=${v.bName} onInput=${x => set('bName', x)} /><//>
            <${Field} label="Opens on"><${DateIn} value=${v.bStart} onInput=${x => set('bStart', x)} /><//>
            ${v.bKind === 'line' ? html`
              <${Field} label="Credit limit ($)"><${Num} value=${v.bLimit} onInput=${x => set('bLimit', x)} /><//>
              <${Field} label="Rate (%/yr)"><${Num} value=${v.bRate} onInput=${x => set('bRate', x)} /><//>
              <${Field} label="Draw on day one ($)" hint="Optional"><${Num} value=${v.bDraw} onInput=${x => set('bDraw', x)} /><//>
              <${Field} label="Draw goes to"><${Select} value=${v.bTo} onChange=${x => set('bTo', x)} options=${accountOptions(plan)} /><//>
              <${Field} label="Secured by"><${Select} value=${v.bSecured} empty="Nothing" onChange=${x => set('bSecured', x)} options=${accountOptions(plan, a => a.kind === 'property')} /><//>
              <${Field} label=" " wide><label class="check"><input type="checkbox" checked=${v.bSafety} onChange=${e => set('bSafety', e.target.checked)} /> Draw automatically when cash would go negative (safety net)</label><//>` : html`
              <${Field} label="Amount ($)" hint=${proceedsIsDebt && v.bTransferAll ? 'Ignored — the whole balance transfers' : null}><${Num} value=${v.bAmount} onInput=${x => set('bAmount', x)} /><//>
              <${Field} label="Money goes to"><${Select} value=${v.bTo} onChange=${x => set('bTo', x)} options=${proceedsOptions} /><//>
              ${proceedsIsDebt ? html`<${Field} label=" "><label class="check"><input type="checkbox" checked=${v.bTransferAll} onChange=${e => set('bTransferAll', e.target.checked)} /> Transfer the whole balance</label><//>` : null}
              <${Field} label="Upfront fee (%)"><${Num} value=${v.bFeePct} onInput=${x => set('bFeePct', x)} /><//>`}
            ${v.bKind === 'promo' ? html`
              <${Field} label="Intro rate (%)"><${Num} value=${v.bPromoRate} onInput=${x => set('bPromoRate', x)} /><//>
              <${Field} label="Intro period (months)"><${Num} value=${v.bPromoMonths} onInput=${x => set('bPromoMonths', x)} /><//>
              <${Field} label="Rate afterwards (%)"><${Num} value=${v.bAfterRate} onInput=${x => set('bAfterRate', x)} /><//>
              <${Field} label="Minimum payment (% of balance)"><${Num} value=${v.bMinPct} onInput=${x => set('bMinPct', x)} /><//>
              <${Field} label="Minimum floor ($)"><${Num} value=${v.bMinFloor} onInput=${x => set('bMinFloor', x)} /><//>
              <${Field} label=" " wide><label class="check"><input type="checkbox" checked=${v.bPayoffAtEnd} onChange=${e => set('bPayoffAtEnd', e.target.checked)} /> Pay off the rest when the intro period ends</label><//>` : null}
            ${v.bKind === 'loan' ? html`
              <${Field} label="Rate (%/yr)"><${Num} value=${v.bRate} onInput=${x => set('bRate', x)} /><//>
              <${Field} label="Term (months)" hint=${`≈ ${money(amortizedPayment(v.bAmount * (1 + (v.bFeePct || 0) / 100), v.bRate, (v.bTerm || 12) / 12))}/mo`}><${Num} value=${v.bTerm} onInput=${x => set('bTerm', x)} /><//>` : null}
          </div>
          <p class="small muted">Creates the debt inside a "Borrow / don't borrow" decision. Interest, fees, payments and payoff all follow from these terms — edit them anytime under Plan → Debts.</p>` : null}
        ${kind === 'sell' ? html`<div class="form-grid">
          <${Field} label="Asset"><${Select} value=${v.assetId} onChange=${x => set('assetId', x)} options=${accountOptions(plan, a => ['property', 'other', 'brokerage'].includes(a.kind))} /><//>
          <${Field} label="Sale date"><${DateIn} value=${v.date} onInput=${x => set('date', x)} /><//>
          <${Field} label="Selling costs (% of price)"><${Num} value=${v.costPct} onInput=${x => set('costPct', x)} /><//>
          <${Field} label="Fixed costs ($)"><${Num} value=${v.fixedCost} onInput=${x => set('fixedCost', x)} /><//>
          <${Field} label="Cash flows that only exist if you keep it" wide hint="e.g. rent income and rental expenses. Costs linked with 'only while I own' stop at the sale automatically.">
            <${Select} value=${v.groupId} empty="None" onChange=${x => set('groupId', x)} options=${plan.groups.map(g => ({ value: g.id, label: g.name }))} />
          <//>
        </div>
        <p class="small muted">The sale pays off any debt secured by the asset, deducts costs and estimated capital-gains tax, and deposits the rest in your primary cash account.</p>` : null}
        ${kind === 'payoff' ? html`<div class="form-grid">
          <${Field} label="Debt"><${Select} value=${v.debtId} onChange=${x => set('debtId', x)} options=${debtOptions(plan)} /><//>
          <${Field} label="Pay off on"><${DateIn} value=${v.date} onInput=${x => set('date', x)} /><//>
          <${Field} label="Paid from (in order)" wide><${Waterfall} plan=${plan} value=${v.from} onChange=${x => set('from', x)} /><//>
        </div>` : null}
        ${kind === 'stock' ? html`<div class="form-grid">
          <${Field} label="Holding"><${Select} value=${v.equityId} onChange=${x => set('equityId', x)} options=${accountOptions(plan, a => a.kind === 'equity' || a.kind === 'brokerage')} /><//>
          <${Field} label="Sell each quarter (% of holding)"><${Num} value=${v.pct} onInput=${x => set('pct', x)} /><//>
          <${Field} label="For how many years"><${Num} value=${v.years} onInput=${x => set('years', x)} /><//>
          <${Field} label="Proceeds go to"><${Select} value=${v.to} empty="Primary cash" onChange=${x => set('to', x)} options=${accountOptions(plan)} /><//>
        </div>
        <p class="small muted">Shares are sold at the modeled price on each date; capital-gains tax is estimated on the gain over average cost basis.</p>` : null}
        ${kind === 'buy' ? html`<div class="form-grid">
          <${Field} label="Name"><${Text} value=${v.homeName} onInput=${x => set('homeName', x)} /><//>
          <${Field} label="Purchase date"><${DateIn} value=${v.date} onInput=${x => set('date', x)} /><//>
          <${Field} label="Price ($)"><${Num} value=${v.price} onInput=${x => set('price', x)} /><//>
          <${Field} label="Down payment (%)"><${Num} value=${v.downPct} onInput=${x => set('downPct', x)} /><//>
          <${Field} label="Mortgage rate (%)"><${Num} value=${v.rate} onInput=${x => set('rate', x)} /><//>
          <${Field} label="Term (years)" hint=${`≈ ${money(amortizedPayment(v.price * (1 - v.downPct / 100), v.rate, v.term))}/mo`}><${Num} value=${v.term} onInput=${x => set('term', x)} /><//>
          <${Field} label="Appreciation (%/yr)"><${Num} value=${v.growth} onInput=${x => set('growth', x)} /><//>
          <${Field} label="Property tax (% of price/yr)"><${Num} value=${v.taxPct} onInput=${x => set('taxPct', x)} /><//>
          <${Field} label="Insurance ($/yr)"><${Num} value=${v.insurance} onInput=${x => set('insurance', x)} /><//>
          <${Field} label="Upkeep (% of price/yr)"><${Num} value=${v.upkeepPct} onInput=${x => set('upkeepPct', x)} /><//>
          <${Field} label="Down payment & closing from" wide><${Waterfall} plan=${plan} value=${v.from} onChange=${x => set('from', x)} /><//>
        </div>` : null}
        ${kind === 'group' ? html`<div class="form-grid">
          <${Field} label="Group" wide hint="Every cash flow in this group will exist only in the 'With' alternative."><${Select} value=${v.groupId} onChange=${x => set('groupId', x)} options=${plan.groups.map(g => ({ value: g.id, label: g.name }))} /><//>
        </div>` : null}
        ${kind === 'blank' ? html`<p class="muted">Creates a decision with two alternatives. Then mark plan items as "only in" an alternative, or add value changes to each alternative.</p>` : null}
        ${kind !== 'blank' ? html`<label class="check"><input type="checkbox" checked=${v.makeScenario} onChange=${e => set('makeScenario', e.target.checked)} /> Also create a scenario and open the comparison</label>` : null}
      </div>
      <div class="sheet-foot"><span></span><div class="row"><button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" onClick=${create}>Create</button></div></div>
    </div>
  </div>`;
}

export { findItem, cls };
