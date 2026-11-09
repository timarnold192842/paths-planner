import { useEffect, useMemo, useState } from 'preact/hooks';
import { html, money, cls } from './h.js';
import { store } from '../store.js';
import { ACCOUNT_KINDS, kindInfo, newId, clone, setPath, getPath } from '../engine/model.js';
import { FREQUENCIES, describeSchedule, perYear } from '../engine/schedule.js';
import { todayYMD } from '../engine/dates.js';
import { PAYMENT_RULES } from '../engine/simulate.js';
import { payPreview, suggestedFedPct, ssWageBase, PAYROLL } from '../engine/payroll.js';
import { parseYMD } from '../engine/dates.js';

// ---------- generic fields ----------
export function Field({ label, hint, children, wide }) {
  return html`<label class=${cls('field', wide && 'wide')}><span>${label}</span>${children}${hint ? html`<span class="hint">${hint}</span>` : null}</label>`;
}

export function Num({ value, onInput, step = 'any', placeholder, min }) {
  return html`<input type="number" inputmode="decimal" step=${step} min=${min} placeholder=${placeholder}
    value=${value ?? ''} onInput=${e => onInput(e.target.value === '' ? null : Number(e.target.value))} />`;
}

export function Text({ value, onInput, placeholder }) {
  return html`<input type="text" value=${value ?? ''} placeholder=${placeholder} onInput=${e => onInput(e.target.value)} />`;
}

export function DateIn({ value, onInput }) {
  return html`<input type="date" value=${value || ''} onInput=${e => onInput(e.target.value || undefined)} />`;
}

export function Select({ value, onChange, options, empty }) {
  return html`<select value=${value ?? ''} onChange=${e => onChange(e.target.value || undefined)}>
    ${empty != null ? html`<option value="">${empty}</option>` : null}
    ${options.map(o => html`<option value=${o.value}>${o.label}</option>`)}
  </select>`;
}

export const accountOptions = (plan, filter = () => true) =>
  plan.accounts.filter(filter).map(a => ({ value: a.id, label: `${a.name}${a.kind !== 'cash' ? ` · ${kindInfo(a.kind).label.split(' ')[0]}` : ''}` }));
export const debtOptions = plan => plan.debts.map(d => ({ value: d.id, label: d.name }));

// Ordered list of funding sources ("pay from 529 first, then Cash").
export function Waterfall({ plan, value = [], onChange, fallbackNote = true, placeholder }) {
  const list = value || [];
  const primary = plan.accounts.find(a => a.id === plan.settings.primaryCashId);
  const available = [
    ...plan.accounts.filter(a => kindInfo(a.kind).withdrawable && !list.includes(a.id)).map(a => ({ id: a.id, name: a.name })),
    ...plan.debts.filter(d => Number(d.creditLimit) > 0 && !list.includes(d.id)).map(d => ({ id: d.id, name: `${d.name} (credit line)` }))
  ];
  const move = (i, d) => { const n = [...list]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); onChange(n); };
  return html`<div class="waterfall">
    ${list.map((id, i) => {
      const a = plan.accounts.find(x => x.id === id) || plan.debts.find(x => x.id === id);
      return html`<div class="wf-row" key=${id}>
        <span class="wf-n">${i + 1}</span>
        <span>${a ? (a.creditLimit ? `${a.name} (credit line)` : a.name) : html`<span class="neg">Missing account</span>`}</span>
        <button type="button" class="btn sm icon ghost" aria-label="Move up" disabled=${i === 0} onClick=${() => move(i, -1)}>↑</button>
        <button type="button" class="btn sm icon ghost" aria-label="Move down" disabled=${i === list.length - 1} onClick=${() => move(i, 1)}>↓</button>
        <button type="button" class="btn sm icon ghost" aria-label="Remove" onClick=${() => onChange(list.filter(x => x !== id))}>×</button>
      </div>`;
    })}
    <select value="" onChange=${e => { if (e.target.value) onChange([...list, e.target.value]); e.target.value = ''; }}>
      <option value="">${placeholder || (list.length ? '+ Then pay from…' : '+ Pay from… (default: primary cash)')}</option>
      ${available.map(a => html`<option value=${a.id}>${a.name}</option>`)}
    </select>
    ${fallbackNote && primary ? html`<span class="hint small faint">Anything the listed accounts can't cover comes from ${primary.name}, which may go negative.</span>` : null}
  </div>`;
}

export function ScheduleEditor({ value, onChange }) {
  const s = value || { freq: 'monthly', start: todayYMD() };
  const set = (k, v) => onChange({ ...s, [k]: v });
  const recurring = s.freq !== 'once';
  return html`<div class="form-grid">
    <${Field} label="How often"><${Select} value=${s.freq} onChange=${v => set('freq', v || 'monthly')} options=${FREQUENCIES.map(f => ({ value: f.id, label: f.label }))} /><//>
    <${Field} label=${recurring ? 'Starts' : 'Date'}><${DateIn} value=${s.start} onInput=${v => set('start', v)} /><//>
    ${recurring ? html`<${Field} label="Ends" hint="Leave empty to continue indefinitely"><${DateIn} value=${s.end} onInput=${v => set('end', v)} /><//>` : null}
    ${s.freq === 'monthly' || s.freq === 'quarterly' || s.freq === 'everyNMonths' || s.freq === 'annual'
      ? html`<${Field} label="Day of month" hint="Defaults to the start date's day"><${Num} value=${s.dayOfMonth === 'last' ? 31 : s.dayOfMonth} min="1" step="1" onInput=${v => set('dayOfMonth', v || undefined)} /><//>` : null}
    ${s.freq === 'annual' ? html`<${Field} label="Month"><${Select} value=${s.month} empty="Same as start" onChange=${v => set('month', v ? Number(v) : undefined)} options=${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m, i) => ({ value: i + 1, label: m }))} /><//>` : null}
    ${s.freq === 'everyNMonths' ? html`<${Field} label="Every N months"><${Num} value=${s.interval} min="1" step="1" onInput=${v => set('interval', v)} /><//>` : null}
    ${s.freq === 'semimonthly' ? html`<${Field} label="Days of month" hint="e.g. 15, last"><${Text} value=${(s.days || [1, 15]).join(', ')} onInput=${v => set('days', v.split(',').map(x => x.trim()).filter(Boolean).map(x => (x === 'last' ? 'last' : Number(x))))} /><//>` : null}
    ${s.freq === 'weekly' ? html`<${Field} label="Weekday"><${Select} value=${s.weekday} empty="Same as start" onChange=${v => set('weekday', v === undefined ? undefined : Number(v))} options=${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => ({ value: i, label: d }))} /><//>` : null}
  </div>`;
}

function StepsEditor({ steps = [], onChange }) {
  return html`<div class="stack" style="gap:8px">
    ${steps.map((st, i) => html`<div class="row" key=${i}>
      <span class="small muted" style="width:46px">From</span>
      <div style="flex:1"><${DateIn} value=${st.date} onInput=${v => onChange(steps.map((x, j) => (j === i ? { ...x, date: v } : x)))} /></div>
      <div style="flex:1"><${Num} value=${st.amount} placeholder="New amount" onInput=${v => onChange(steps.map((x, j) => (j === i ? { ...x, amount: v } : x)))} /></div>
      <button type="button" class="btn sm icon ghost" aria-label="Remove change" onClick=${() => onChange(steps.filter((_, j) => j !== i))}>×</button>
    </div>`)}
    <div><button type="button" class="btn sm" onClick=${() => onChange([...steps, { date: todayYMD(), amount: null }])}>+ Add a change in amount</button></div>
  </div>`;
}

// Which decision alternatives this item belongs to (empty = always).
export function WhenEditor({ plan, value, onChange }) {
  const when = value || {};
  if (!plan.decisions.length) return html`<p class="small muted">Create a decision to make items exist only in some alternatives.</p>`;
  return html`<div class="stack" style="gap:10px">
    ${plan.decisions.map(d => {
      const sel = when[d.id] || [];
      const toggle = altId => {
        const next = sel.includes(altId) ? sel.filter(x => x !== altId) : [...sel, altId];
        const w = { ...when };
        if (next.length) w[d.id] = next; else delete w[d.id];
        onChange(Object.keys(w).length ? w : undefined);
      };
      return html`<div key=${d.id}>
        <div class="small" style="font-weight:650;margin-bottom:4px">${d.name}</div>
        <div class="row">
          <span class=${cls('chip', !sel.length && 'on')} role="button" tabindex="0" onClick=${() => { const w = { ...when }; delete w[d.id]; onChange(Object.keys(w).length ? w : undefined); }}>Any choice</span>
          ${d.alternatives.map(a => html`<span class=${cls('chip', sel.includes(a.id) && 'on')} role="button" tabindex="0" onClick=${() => toggle(a.id)}>${a.name}</span>`)}
        </div>
      </div>`;
    })}
  </div>`;
}

// Short label for the alternatives an item belongs to ("Only if: Sell this spring").
export function whenLabel(plan, when, verbose = false) {
  if (!when) return '';
  return Object.entries(when).map(([dId, alts]) => {
    const d = plan.decisions.find(x => x.id === dId);
    if (!d) return null;
    const names = alts.map(a => d.alternatives.find(x => x.id === a)?.name || '?').join(' / ');
    return verbose ? `${d.name}: ${names}` : names;
  }).filter(Boolean).join(' · ');
}

// ---------- item sheet ----------
const TITLES = { accounts: 'account', debts: 'debt', flows: 'cash flow', events: 'event', units: 'price model' };

export function blankItem(coll, plan, extra = {}) {
  const today = todayYMD();
  const cash = plan.settings.primaryCashId;
  switch (coll) {
    case 'accounts': return { id: newId('acct'), name: 'New account', kind: 'brokerage', balance: 0, growth: 6, tags: [], ...extra };
    case 'debts': return { id: newId('debt'), name: 'New debt', balance: 0, rate: 5, payment: 0, paymentDay: 1, payFrom: [], ...extra };
    case 'flows': return { id: newId('flow'), name: 'New expense', amount: 100, growth: 0, schedule: { freq: 'monthly', start: today }, from: [], to: null, steps: [], ...extra };
    case 'events': return { id: newId('evt'), type: 'sell', name: 'Sell an asset', date: today, costPct: 6, ...extra };
    case 'units': return { id: newId('unit'), name: 'New stock', symbol: 'TICK', price: 10, growth: 0, paths: {}, ...extra };
    default: return { id: newId('x'), ...extra };
  }
  void cash;
}

export function ItemSheet({ coll, id, draftItem, onClose }) {
  const plan = store.plan;
  const existing = id ? (plan[coll] || []).find(x => x.id === id) : null;
  const [d, setD] = useState(() => clone(existing || draftItem));
  const isNew = !existing;
  const set = (path, v) => setD(prev => { const n = clone(prev); setPath(n, path, v); return n; });
  const get = path => getPath(d, path);

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const save = () => {
    store.update(p => {
      const list = p[coll];
      const i = list.findIndex(x => x.id === d.id);
      if (i >= 0) list[i] = d; else list.push(d);
    });
    onClose();
  };
  const remove = () => {
    if (!confirm(`Delete "${d.name || TITLES[coll]}"? Scenarios that referred to it will show a warning.`)) return;
    store.update(p => { p[coll] = p[coll].filter(x => x.id !== d.id); });
    onClose();
  };
  const duplicate = () => {
    const copy = { ...clone(d), id: newId(coll.slice(0, 4)), name: `${d.name} (copy)` };
    store.update(p => { p[coll].push(copy); });
    onClose();
  };

  return html`<div class="sheet-backdrop" onClick=${e => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="sheet" role="dialog" aria-modal="true" aria-label=${`Edit ${TITLES[coll]}`}>
      <div class="sheet-head">
        <h3>${isNew ? `New ${TITLES[coll]}` : d.name || TITLES[coll]}</h3>
        <button class="btn icon ghost" aria-label="Close" onClick=${onClose}>✕</button>
      </div>
      <div class="sheet-body">
        ${coll === 'accounts' ? html`<${AccountForm} plan=${plan} d=${d} set=${set} get=${get} />` : null}
        ${coll === 'debts' ? html`<${DebtForm} plan=${plan} d=${d} set=${set} />` : null}
        ${coll === 'flows' ? html`<${FlowForm} plan=${plan} d=${d} set=${set} setD=${setD} />` : null}
        ${coll === 'events' ? html`<${EventForm} plan=${plan} d=${d} set=${set} />` : null}
        ${coll === 'units' ? html`<${UnitForm} plan=${plan} d=${d} set=${set} setD=${setD} />` : null}
        ${coll !== 'units' ? html`<details class="more" open=${!!d.when}>
          <summary>Only in some alternatives ${d.when ? html`<span class="badge blue">${whenLabel(plan, d.when, true)}</span>` : null}</summary>
          <${WhenEditor} plan=${plan} value=${d.when} onChange=${v => set('when', v)} />
        </details>` : null}
        ${coll !== 'units' && coll !== 'accounts' ? html`<label class="check"><input type="checkbox" checked=${d.enabled !== false} onChange=${e => set('enabled', e.target.checked)} /> Included in the plan</label>` : null}
      </div>
      <div class="sheet-foot">
        <div class="row">
          ${!isNew ? html`<button class="btn danger" onClick=${remove}>Delete</button><button class="btn ghost" onClick=${duplicate}>Duplicate</button>` : null}
        </div>
        <div class="row">
          <button class="btn" onClick=${onClose}>Cancel</button>
          <button class="btn primary" onClick=${save}>${isNew ? 'Add' : 'Save'}</button>
        </div>
      </div>
    </div>
  </div>`;
}

function AccountForm({ plan, d, set }) {
  const unit = plan.units.find(u => u.id === d.unitId);
  return html`<div class="form-grid">
    <${Field} label="Name" wide><${Text} value=${d.name} onInput=${v => set('name', v)} /><//>
    <${Field} label="Type" hint="Drives taxes and what counts as liquid"><${Select} value=${d.kind} onChange=${v => set('kind', v)} options=${ACCOUNT_KINDS.map(k => ({ value: k.id, label: k.label }))} /><//>
    <${Field} label="Held in"><${Select} value=${d.unitId} empty="US dollars" onChange=${v => set('unitId', v)} options=${plan.units.map(u => ({ value: u.id, label: `${u.name} shares` }))} /><//>
    <${Field} label=${unit ? `Balance (${unit.symbol} shares)` : 'Balance today ($)'} hint=${unit ? `≈ ${money((d.balance || 0) * unit.price)} at today's price` : null}><${Num} value=${d.balance} onInput=${v => set('balance', v)} /><//>
    <${Field} label="Growth (%/yr)" hint=${unit ? 'Growth in share count (e.g. dividends reinvested). Price comes from the price model.' : 'Interest, returns or appreciation'}><${Num} value=${d.growth} onInput=${v => set('growth', v)} /><//>
    ${d.kind !== 'cash' && d.kind !== 'traditional' && d.kind !== 'other' ? html`<${Field} label="Cost basis ($)" hint="What you paid / contributed. Gains above this are taxed."><${Num} value=${d.costBasis} placeholder="Defaults to today's value" onInput=${v => set('costBasis', v)} /><//>` : null}
    ${d.kind === 'property' ? html`<${Field} label=" "><label class="check"><input type="checkbox" checked=${!!d.primaryResidence} onChange=${e => set('primaryResidence', e.target.checked)} /> Primary residence (gain exclusion)</label><//>` : null}
    <${Field} label="Owned from" hint="Leave empty if you own it today. A buy event sets this automatically."><${DateIn} value=${d.ownedFrom} onInput=${v => set('ownedFrom', v)} /><//>
    <${Field} label="Notes" wide><${Text} value=${d.notes} onInput=${v => set('notes', v)} /><//>
  </div>`;
}

function DebtForm({ plan, d, set }) {
  const rule = d.paymentRule || 'fixed';
  const future = !!d.start;
  const toDebt = d.proceedsTo && plan.debts.some(x => x.id === d.proceedsTo);
  const isLine = Number(d.creditLimit) > 0;
  return html`<div class="form-grid">
      <${Field} label="Name" wide><${Text} value=${d.name} onInput=${v => set('name', v)} /><//>
      <${Field} label="Starts" hint="Leave empty for a debt you already have"><${DateIn} value=${d.start} onInput=${v => set('start', v)} /><//>
      ${!(future && toDebt && d.transferAll) ? html`<${Field} label=${future ? 'Amount borrowed ($)' : 'Balance today ($)'}><${Num} value=${d.balance} onInput=${v => set('balance', v)} /><//>` : null}
      ${future ? html`
        <${Field} label="Money goes to" hint="An account, or another debt it pays off (balance transfer, refinance)">
          <${Select} value=${d.proceedsTo} empty="Nowhere (already spent)" onChange=${v => set('proceedsTo', v)} options=${[...accountOptions(plan), ...plan.debts.filter(x => x.id !== d.id).map(x => ({ value: x.id, label: `Pay off ${x.name}` }))]} />
        <//>
        ${toDebt ? html`<${Field} label=" "><label class="check"><input type="checkbox" checked=${!!d.transferAll} onChange=${e => set('transferAll', e.target.checked)} /> Transfer the whole balance</label><//>` : null}
        <${Field} label="Upfront fee (%)" hint="Added to the balance (e.g. 3% transfer fee)"><${Num} value=${d.feePct} onInput=${v => set('feePct', v)} /><//>` : null}
      <${Field} label="Credit limit ($)" hint="Set for a line of credit you can draw from (HELOC, card)"><${Num} value=${d.creditLimit} onInput=${v => set('creditLimit', v)} /><//>
    </div>
    <div>
      <div class="section-label">Interest</div>
      <div class="form-grid">
        <${Field} label="Rate (%/yr)"><${Num} value=${d.rate} onInput=${v => set('rate', v)} /><//>
      </div>
      <div style="margin-top:10px"><${RateSteps} steps=${d.rateSteps || []} onChange=${v => set('rateSteps', v)} /></div>
    </div>
    <div>
      <div class="section-label">Payments</div>
      <div class="form-grid">
        <${Field} label="How payments work"><${Select} value=${rule} onChange=${v => set('paymentRule', v)} options=${PAYMENT_RULES.map(r => ({ value: r.id, label: r.label }))} /><//>
        ${rule === 'fixed' ? html`<${Field} label="Monthly payment ($)"><${Num} value=${d.payment} onInput=${v => set('payment', v)} /><//>` : null}
        ${rule === 'minimum' ? html`<${Field} label="Minimum (% of balance)" hint="Plus interest, at least the $ floor"><${Num} value=${d.minPct ?? 1} onInput=${v => set('minPct', v)} /><//><${Field} label="Minimum floor ($)"><${Num} value=${d.payment} onInput=${v => set('payment', v)} /><//>` : null}
        ${rule === 'amortize' ? html`<${Field} label="Term (months)" hint="Payment is recalculated if the rate changes"><${Num} value=${d.termMonths} min="1" step="1" onInput=${v => set('termMonths', v)} /><//>` : null}
        <${Field} label="Payment day"><${Num} value=${d.paymentDay} min="1" step="1" onInput=${v => set('paymentDay', v)} /><//>
        <${Field} label="Pay off in full on" hint="e.g. the end of a 0% promo"><${DateIn} value=${d.payoffDate} onInput=${v => set('payoffDate', v)} /><//>
        <${Field} label="Payments come from" wide><${Waterfall} plan=${plan} value=${d.payFrom} onChange=${v => set('payFrom', v)} /><//>
      </div>
    </div>
    <div class="form-grid">
      <${Field} label="Secured by" hint="Paid off from the proceeds when this asset is sold"><${Select} value=${d.securedBy} empty="Nothing" onChange=${v => set('securedBy', v)} options=${accountOptions(plan, a => a.kind === 'property' || a.kind === 'other')} /><//>
      ${isLine ? html`<${Field} label=" "><label class="check"><input type="checkbox" checked=${(plan.settings.safetyNet || []).includes(d.id)} onChange=${e => store.update(p => {
        const list = new Set(p.settings.safetyNet || []);
        if (e.target.checked) list.add(d.id); else list.delete(d.id);
        p.settings.safetyNet = [...list];
      }, { skipHistory: false })} /> Use as a safety net when cash runs out</label><//>` : null}
    </div>`;
}

function RateSteps({ steps = [], onChange }) {
  return html`<div class="stack" style="gap:8px">
    ${steps.map((st, i) => html`<div class="row" key=${i}>
      <span class="small muted" style="width:46px">From</span>
      <div style="flex:1"><${DateIn} value=${st.date} onInput=${v => onChange(steps.map((x, j) => (j === i ? { ...x, date: v } : x)))} /></div>
      <div style="flex:1"><${Num} value=${st.rate} placeholder="Rate %" onInput=${v => onChange(steps.map((x, j) => (j === i ? { ...x, rate: v } : x)))} /></div>
      <button type="button" class="btn sm icon ghost" aria-label="Remove rate change" onClick=${() => onChange(steps.filter((_, j) => j !== i))}>×</button>
    </div>`)}
    <div><button type="button" class="btn sm" onClick=${() => onChange([...steps, { date: todayYMD(), rate: null }])}>+ Add a rate change (promo ends, reset…)</button></div>
  </div>`;
}

function flowDirection(d) {
  if (d.to && !(d.from || []).length) return 'income';
  if (d.to && (d.from || []).length) return 'transfer';
  return 'expense';
}

function FlowForm({ plan, d, set, setD }) {
  const dir = flowDirection(d);
  const setDir = v => setD(prev => {
    const n = clone(prev);
    if (v === 'income') { n.from = []; n.to = n.to || plan.settings.primaryCashId; }
    if (v === 'expense') { n.to = null; }
    if (v === 'transfer') { n.from = n.from?.length ? n.from : [plan.settings.primaryCashId].filter(Boolean); n.to = n.to || plan.accounts.find(a => a.id !== plan.settings.primaryCashId)?.id || null; }
    return n;
  });
  const unit = plan.units.find(u => u.id === d.unitId);
  const yearly = (Number(d.amount) || 0) * perYear(d.schedule) * (unit ? unit.price : 1);
  const toOptions = [...accountOptions(plan), ...debtOptions(plan).map(o => ({ ...o, label: `${o.label} · debt` }))];
  const acctTo = plan.accounts.some(a => a.id === d.to);
  return html`
    <div class="seg" role="tablist" aria-label="Direction">
      ${[['expense', 'Expense'], ['income', 'Income'], ['transfer', 'Transfer']].map(([k, l]) => html`<button type="button" class=${dir === k ? 'on' : ''} onClick=${() => setDir(k)}>${l}</button>`)}
    </div>
    <div class="form-grid">
      <${Field} label="Name" wide><${Text} value=${d.name} onInput=${v => set('name', v)} /><//>
      <${Field} label=${unit ? `Amount (${unit.symbol} shares)` : d.pay ? 'Gross pay ($)' : 'Amount ($)'} hint=${yearly ? `≈ ${money(yearly)}/yr today${d.pay ? ' before taxes' : ''}` : null}><${Num} value=${d.amount} onInput=${v => set('amount', v)} /><//>
      <${Field} label="Denominated in"><${Select} value=${d.unitId} empty="US dollars" onChange=${v => set('unitId', v)} options=${plan.units.map(u => ({ value: u.id, label: `${u.name} shares` }))} /><//>
      <${Field} label="Grows (%/yr)" hint="Inflation, raises"><${Num} value=${d.growth} onInput=${v => set('growth', v)} /><//>
      <${Field} label="Group"><${GroupSelect} plan=${plan} value=${d.group} onChange=${v => set('group', v)} /><//>
      ${dir !== 'expense' ? html`<${Field} label="Goes to"><${Select} value=${d.to} onChange=${v => set('to', v || null)} options=${toOptions} /><//>` : null}
    </div>
    <div><div class="section-label">When</div><${ScheduleEditor} value=${d.schedule} onChange=${v => set('schedule', v)} /></div>
    ${dir === 'income' && acctTo ? html`<div class="paybox">
      <label class="check"><input type="checkbox" checked=${!!d.pay} onChange=${e => set('pay', e.target.checked ? newPay(plan, d) : undefined)} />
        <span><b>This is a paycheck</b> <span class="small muted">— enter gross pay; payroll taxes, withholding and deductions come out automatically</span></span></label>
      ${d.pay ? html`<${PaycheckEditor} plan=${plan} d=${d} set=${set} unit=${unit} />` : null}
    </div>` : null}
    ${dir !== 'income' ? html`<div><div class="section-label">${dir === 'transfer' ? 'Comes from' : 'Paid from (in order)'}</div>
      <${Waterfall} plan=${plan} value=${d.from} onChange=${v => set('from', v)} fallbackNote=${dir === 'expense'} />
      ${dir === 'expense' ? html`<div class="row" style="margin-top:8px"><span class="small muted">Qualified for</span>
        <div class="seg">${[[undefined, 'None'], ['education', 'Education (529)'], ['medical', 'Medical (HSA)']].map(([k, l]) => html`<button type="button" class=${d.qualified === k ? 'on' : ''} onClick=${() => set('qualified', k)}>${l}</button>`)}</div></div>` : null}
    </div>` : null}
    <details class="more" open=${!!(d.steps?.length || d.whileOwned || d.taxed || d.withholdPct)}>
      <summary>${d.pay ? 'Raises, pay changes & ownership' : 'Changes over time, ownership & taxes'}</summary>
      <div class="stack">
        <div><div class="section-label">Amount changes</div><${StepsEditor} steps=${d.steps || []} onChange=${v => set('steps', v)} /></div>
        <div class="form-grid">
          <${Field} label="Only while I own" hint="Stops automatically when this asset is sold"><${Select} value=${d.whileOwned} empty="—" onChange=${v => set('whileOwned', v)} options=${accountOptions(plan, a => a.kind === 'property' || a.kind === 'other' || a.kind === 'equity')} /><//>
          ${dir === 'income' && !d.pay ? html`<${Field} label="Income tax"><${Select} value=${d.taxed} empty="Already net of tax" onChange=${v => set('taxed', v)} options=${[{ value: 'ordinary', label: 'Taxed at my ordinary rate' }]} /><//>` : null}
          ${dir === 'income' && unit && !d.pay ? html`<${Field} label="Shares withheld for tax (%)" hint="Sell-to-cover at vest"><${Num} value=${d.withholdPct} onInput=${v => set('withholdPct', v)} /><//>` : null}
        </div>
      </div>
    </details>`;
}

// ---------- paychecks ----------
const DEDUCTION_PRESETS = [
  { key: '401k', label: '401(k) / 403(b)', make: (plan, deds) => ({ name: '401(k)', pct: 6, to: plan.accounts.find(a => a.kind === 'traditional')?.id, pretax: true, annualLimit: PAYROLL.limit401k, employerPct: 0 }) },
  { key: 'roth401k', label: 'Roth 401(k)', make: (plan, deds) => ({ name: 'Roth 401(k)', pct: 6, to: plan.accounts.find(a => a.kind === 'roth')?.id, pretax: false, annualLimit: PAYROLL.limit401k, limitWith: deds.find(x => /401|403/.test(x.name) && x.pretax)?.id }) },
  { key: 'hsa', label: 'HSA', make: plan => ({ name: 'HSA', amount: 150, to: plan.accounts.find(a => a.kind === 'hsa')?.id, pretax: true, annualLimit: 8750, ficaExempt: true }) },
  { key: 'insurance', label: 'Health insurance', make: () => ({ name: 'Health insurance', amount: 200, pretax: true, ficaExempt: true }) },
  { key: 'other', label: 'Other', make: () => ({ name: 'Deduction', amount: 100, pretax: false }) }
];

function newPay(plan, d) {
  const employer = plan.flows.find(f => f.pay && f.id !== d.id)?.pay.employer || 'Main job';
  const pay = { employer, fica: true, fedPct: null, statePct: plan.settings.tax.state ?? 0, ytdGross: null, deductions: [] };
  pay.fedPct = suggestedFedPct(plan, { ...d, pay }) ?? 15;
  return pay;
}

function PaycheckEditor({ plan, d, set, unit }) {
  const pay = d.pay;
  const setPay = (k, v) => set(`pay.${k}`, v);
  const deds = pay.deductions || [];
  const setDed = (i, patch) => setPay('deductions', deds.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const asOfYear = parseYMD(plan.asOf).getUTCFullYear();
  const suggestion = useMemo(() => suggestedFedPct(plan, d), [plan, d]);
  const tax = plan.settings.tax;
  return html`<div class="stack" style="gap:12px;margin-top:10px">
    <div class="form-grid">
      <${Field} label="Employer" hint=${`Paychecks and stock vests from the same employer share Social Security's ${money(ssWageBase(asOfYear, plan.settings.inflation))} wage base`}><${Text} value=${pay.employer} onInput=${v => setPay('employer', v)} /><//>
      <${Field} label="Federal withholding (% of taxable pay)" hint=${suggestion != null ? html`Estimated tax on this pay alone is ≈${suggestion}%${Number(pay.fedPct) !== suggestion ? html` · <button type="button" class="linkish" onClick=${() => setPay('fedPct', suggestion)}>use ${suggestion}%</button>` : ''}. Bonuses and vests usually withhold 22%.` : 'From your pay stub'}><${Num} value=${pay.fedPct} onInput=${v => setPay('fedPct', v)} /><//>
      <${Field} label="State withholding (%)" hint=${`Your state rate in Settings is ${tax.state ?? 0}%`}><${Num} value=${pay.statePct} onInput=${v => setPay('statePct', v)} /><//>
      <${Field} label=${`Paid so far in ${asOfYear} ($, gross)`} hint="Before the plan's as-of date — so this year's caps and tax estimate start in the right place. Check-ins keep it current."><${Num} value=${pay.ytdGross} onInput=${v => setPay('ytdGross', v)} /><//>
    </div>
    <label class="check"><input type="checkbox" checked=${pay.fica !== false} onChange=${e => setPay('fica', e.target.checked)} /> Withhold Social Security (6.2% up to the wage base) & Medicare (1.45%, +0.9% over $200k)</label>
    ${unit ? html`<p class="small muted" style="margin:0">Taxes are covered by withholding shares at the vest-day price (sell-to-cover).</p>` : html`<div>
      <div class="section-label">Payroll deductions</div>
      <div class="stack" style="gap:8px">
        ${deds.map((x, i) => html`<div class="ded" key=${x.id}>
          <div class="ded-head">
            <input type="text" value=${x.name} aria-label="Deduction name" onInput=${e => setDed(i, { name: e.target.value })} />
            <button type="button" class="btn sm icon ghost" aria-label="Remove deduction" onClick=${() => setPay('deductions', deds.filter((_, j) => j !== i).map(o => (o.limitWith === x.id ? { ...o, limitWith: undefined } : o)))}>×</button>
          </div>
          <div class="form-grid">
            <${Field} label="Amount">
              <div class="row" style="gap:6px;flex-wrap:nowrap">
                <div class="seg sm">${[['pct', '%'], ['amount', '$']].map(([k, l]) => html`<button type="button" class=${(k === 'pct') === (x.pct != null) ? 'on' : ''} onClick=${() => setDed(i, k === 'pct' ? { pct: x.pct ?? 5, amount: undefined } : { amount: x.amount ?? 100, pct: undefined })}>${l}</button>`)}</div>
                <${Num} value=${x.pct != null ? x.pct : x.amount} onInput=${v => setDed(i, x.pct != null ? { pct: v ?? '' } : { amount: v })} />
              </div>
            <//>
            <${Field} label="Goes to"><${Select} value=${x.to} empty="Nowhere (a cost, like insurance)" onChange=${v => setDed(i, { to: v })} options=${accountOptions(plan, a => a.kind !== 'property')} /><//>
            <${Field} label="Annual limit ($)" hint="Stops for the rest of the year once reached"><${Num} value=${x.annualLimit} placeholder="No limit" onInput=${v => setDed(i, { annualLimit: v })} /><//>
            ${deds.length > 1 ? html`<${Field} label="Shares its limit with" hint="e.g. pre-tax and Roth 401(k) share one limit"><${Select} value=${x.limitWith} empty="Nothing (own limit)" onChange=${v => setDed(i, { limitWith: v })} options=${deds.filter(o => o.id !== x.id && !o.limitWith).map(o => ({ value: o.id, label: o.name }))} /><//>` : null}
            ${x.to ? html`<${Field} label="Employer adds (% of pay)" hint="Match or contribution, while you contribute"><${Num} value=${x.employerPct} onInput=${v => setDed(i, { employerPct: v })} /><//>` : null}
          </div>
          <label class="check small"><input type="checkbox" checked=${!!x.pretax} onChange=${e => setDed(i, { pretax: e.target.checked })} /> Pre-tax (lowers taxable pay)</label>
          ${x.pretax ? html`<label class="check small"><input type="checkbox" checked=${!!x.ficaExempt} onChange=${e => setDed(i, { ficaExempt: e.target.checked })} /> Also exempt from Social Security & Medicare (HSA, health premiums — not 401(k))</label>` : null}
        </div>`)}
        <div><select value="" aria-label="Add a deduction" onChange=${e => { const pr = DEDUCTION_PRESETS.find(p => p.key === e.target.value); e.target.value = ''; if (pr) setPay('deductions', [...deds, { id: newId('ded'), ...pr.make(plan, deds) }]); }}>
          <option value="">+ Add a deduction…</option>
          ${DEDUCTION_PRESETS.map(p => html`<option value=${p.key}>${p.label}</option>`)}
        </select></div>
      </div>
    </div>`}
    <${PayPreview} plan=${plan} d=${d} unit=${unit} />
  </div>`;
}

const shortDate = dt => dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function PayPreview({ plan, d, unit }) {
  const year = parseYMD(plan.asOf).getUTCFullYear() + 1;
  const pv = useMemo(() => payPreview(plan, d, year), [plan, d, year]);
  if (!pv || !pv.rows.length) return html`<p class="small muted">No paychecks in ${year}.</p>`;
  const rows = pv.rows;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const total = k => rows.reduce((s, r) => s + r[k], 0);
  const dedNames = first.deductions.map(x => x.name);
  const dedTotal = (r, j) => r.deductions[j]?.amount || 0;
  const employerTotal = total('employerAdds');
  const showLast = rows.length > 1;
  const notes = [];
  const ssStop = rows.findIndex(r => r.ss === 0 && r.gross > 0);
  if (pay(d).fica !== false && ssStop > 0) notes.push(`No Social Security from the ${shortDate(rows[ssStop].date)} ${unit ? 'vest' : 'paycheck'} on — ${pv.peers.length ? 'this employer’s' : 'your'} wages for the year pass ${money(ssWageBase(year, plan.settings.inflation))}. It restarts in January.`);
  const medStart = rows.findIndex(r => r.addlMedicare > 0);
  if (medStart >= 0) notes.push(`Extra 0.9% Medicare from ${shortDate(rows[medStart].date)} (wages over $200k).`);
  first.deductions.forEach((x, j) => {
    const k = rows.findIndex(r => r.deductions[j]?.capped);
    if (k >= 0) notes.push(`${x.name} reaches its annual limit on ${shortDate(rows[k].date)}${x.employer ? '; the employer contribution stops too' : ''}.`);
  });
  const line = (label, f, cls2) => html`<tr class=${cls2 || ''}><td>${label}</td><td>${money(f(first))}</td>${showLast ? html`<td>${money(f(last))}</td>` : null}<td>${money(rows.reduce((s, r) => s + f(r), 0))}</td></tr>`;
  return html`<div class="paystub">
    <div class="small muted" style="margin-bottom:6px">${unit ? 'Vests' : 'Paychecks'} in ${year}: ${rows.length}${unit ? ` · at today's ${unit.symbol} price of ${money(unit.price, true)}` : ''}${pv.peers.length ? ` · shares the wage base with ${pv.peers.join(', ')}` : ''}</div>
    <div class="scroll-x"><table class="tbl compact">
      <thead><tr><th></th><th>First<div class="faint">${shortDate(first.date)}</div></th>${showLast ? html`<th>Last<div class="faint">${shortDate(last.date)}</div></th>` : null}<th>Year<div class="faint">${year}</div></th></tr></thead>
      <tbody>
        ${line('Gross', r => r.gross)}
        ${line('Social Security', r => -r.ss)}
        ${line('Medicare', r => -(r.medicare + r.addlMedicare))}
        ${line('Federal withholding', r => -r.fed)}
        ${line('State withholding', r => -r.state)}
        ${dedNames.map((n, j) => line(n, r => -dedTotal(r, j)))}
        ${line(unit ? 'Value kept (shares)' : 'Take-home', r => r.net, 'total')}
        ${employerTotal > 0 ? line('Employer adds', r => r.employerAdds, 'muted') : null}
      </tbody>
    </table></div>
    ${notes.length ? html`<ul class="small paynotes">${notes.map(n => html`<li>${n}</li>`)}</ul>` : null}
    <p class="small faint" style="margin:6px 0 0">Withholding is trued up each April against an estimate of the year's tax — see “Paychecks & taxes” on the Overview.</p>
  </div>`;
}
const pay = d => d.pay || {};

export function GroupSelect({ plan, value, onChange }) {
  return html`<select value=${value || ''} onChange=${e => {
    if (e.target.value === '__new') {
      const name = prompt('New group name');
      if (name && name.trim()) {
        const id = newId('grp');
        store.update(p => { p.groups.push({ id, name: name.trim() }); }, { skipHistory: true });
        onChange(id);
      } else e.target.value = value || '';
      return;
    }
    onChange(e.target.value || undefined);
  }}>
    <option value="">No group</option>
    ${plan.groups.map(g => html`<option value=${g.id}>${g.name}</option>`)}
    <option value="__new">+ New group…</option>
  </select>`;
}

const EVENT_TYPES = [
  { value: 'sell', label: 'Sell an asset' },
  { value: 'buy', label: 'Buy an asset' },
  { value: 'payoff', label: 'Pay off a debt' },
  { value: 'liquidate', label: 'Sell shares (once or on a schedule)' }
];

function EventForm({ plan, d, set }) {
  return html`<div class="form-grid">
    <${Field} label="Type"><${Select} value=${d.type} onChange=${v => set('type', v)} options=${EVENT_TYPES} /><//>
    <${Field} label="Name"><${Text} value=${d.name} onInput=${v => set('name', v)} /><//>
    ${d.type === 'sell' ? html`
      <${Field} label="Asset"><${Select} value=${d.assetId} empty="Choose…" onChange=${v => set('assetId', v)} options=${accountOptions(plan, a => a.kind === 'property' || a.kind === 'other' || a.kind === 'brokerage')} /><//>
      <${Field} label="Date"><${DateIn} value=${d.date} onInput=${v => set('date', v)} /><//>
      <${Field} label="Sale price ($)" hint="Empty = modeled value on that date"><${Num} value=${d.price} onInput=${v => set('price', v)} /><//>
      <${Field} label="Selling costs (% of price)"><${Num} value=${d.costPct} onInput=${v => set('costPct', v)} /><//>
      <${Field} label="Fixed costs ($)"><${Num} value=${d.fixedCost} onInput=${v => set('fixedCost', v)} /><//>
      <${Field} label="Proceeds go to"><${Select} value=${d.to} empty="Primary cash" onChange=${v => set('to', v)} options=${accountOptions(plan)} /><//>
      <${Field} label=" " wide><label class="check"><input type="checkbox" checked=${!!d.useExclusion} onChange=${e => set('useExclusion', e.target.checked)} /> Apply the primary-residence gain exclusion</label><//>` : null}
    ${d.type === 'buy' ? html`
      <${Field} label="Asset being bought" hint="Create it as an account first (balance 0)"><${Select} value=${d.assetId} empty="Choose…" onChange=${v => set('assetId', v)} options=${accountOptions(plan)} /><//>
      <${Field} label="Date"><${DateIn} value=${d.date} onInput=${v => set('date', v)} /><//>
      <${Field} label="Price ($)"><${Num} value=${d.price} onInput=${v => set('price', v)} /><//>
      <${Field} label="Closing costs (%)"><${Num} value=${d.closingPct} onInput=${v => set('closingPct', v)} /><//>
      <${Field} label="Mortgage" hint="Create it as a debt first"><${Select} value=${d.debtId} empty="Pay cash" onChange=${v => set('debtId', v)} options=${debtOptions(plan)} /><//>
      <${Field} label="Loan amount ($)"><${Num} value=${d.loanAmount} onInput=${v => set('loanAmount', v)} /><//>
      <${Field} label="Down payment from" wide><${Waterfall} plan=${plan} value=${d.from} onChange=${v => set('from', v)} /><//>` : null}
    ${d.type === 'payoff' ? html`
      <${Field} label="Debt"><${Select} value=${d.debtId} empty="Choose…" onChange=${v => set('debtId', v)} options=${debtOptions(plan)} /><//>
      <${Field} label="Date"><${DateIn} value=${d.date} onInput=${v => set('date', v)} /><//>
      <${Field} label="Paid from" wide><${Waterfall} plan=${plan} value=${d.from} onChange=${v => set('from', v)} /><//>` : null}
    ${d.type === 'liquidate' ? html`
      <${Field} label="Holding"><${Select} value=${d.assetId} empty="Choose…" onChange=${v => set('assetId', v)} options=${accountOptions(plan, a => a.kind === 'equity' || a.kind === 'brokerage')} /><//>
      <${Field} label="Sell"><${Select} value=${d.mode || 'shares'} onChange=${v => set('mode', v)} options=${[{ value: 'shares', label: 'A number of shares' }, { value: 'usd', label: 'A dollar amount' }, { value: 'percent', label: 'A % of what I hold' }]} /><//>
      <${Field} label=${d.mode === 'usd' ? 'Amount ($, before tax)' : d.mode === 'percent' ? 'Percent of holding' : 'Shares'}><${Num} value=${d.amount} onInput=${v => set('amount', v)} /><//>
      <${Field} label="Tax rate on gains (%)" hint="Empty = long-term capital-gains rate"><${Num} value=${d.taxRate} onInput=${v => set('taxRate', v)} /><//>
      <${Field} label="Proceeds go to"><${Select} value=${d.to} empty="Primary cash" onChange=${v => set('to', v)} options=${accountOptions(plan)} /><//>
      <div class="wide"><div class="section-label">When</div><${ScheduleEditor} value=${d.schedule || { freq: 'once', start: d.date || todayYMD() }} onChange=${v => set('schedule', v)} /></div>` : null}
  </div>`;
}

function UnitForm({ plan, d, set, setD }) {
  const asm = plan.assumptions.find(a => a.id === d.assumptionId);
  const [caseId, setCaseId] = useState(asm?.cases[0]?.id || '');
  const targets = (d.paths || {})[caseId] || [];
  const setTargets = list => setD(prev => ({ ...prev, paths: { ...(prev.paths || {}), [caseId]: list } }));
  return html`<div class="form-grid">
      <${Field} label="Name"><${Text} value=${d.name} onInput=${v => set('name', v)} /><//>
      <${Field} label="Symbol"><${Text} value=${d.symbol} onInput=${v => set('symbol', v)} /><//>
      <${Field} label="Price today ($)"><${Num} value=${d.price} onInput=${v => set('price', v)} /><//>
      <${Field} label="Growth after the last target (%/yr)"><${Num} value=${d.growth} onInput=${v => set('growth', v)} /><//>
      <${Field} label="Price cases come from" wide hint="An assumption whose cases (e.g. Bear / Mid / Bull) each have their own price path">
        <${Select} value=${d.assumptionId} empty="No assumption (single path)" onChange=${v => set('assumptionId', v)} options=${plan.assumptions.map(a => ({ value: a.id, label: a.name }))} />
      <//>
    </div>
    ${asm ? html`<div>
      <div class="section-label">Price targets</div>
      <div class="seg" style="margin-bottom:10px">${asm.cases.map(c => html`<button type="button" class=${c.id === caseId ? 'on' : ''} onClick=${() => setCaseId(c.id)}>${c.name}</button>`)}</div>
      <div class="stack" style="gap:8px">
        ${targets.map((t, i) => html`<div class="row" key=${i}>
          <div style="flex:1"><${DateIn} value=${t.date} onInput=${v => setTargets(targets.map((x, j) => (j === i ? { ...x, date: v } : x)))} /></div>
          <div style="flex:1"><${Num} value=${t.price} placeholder="Price" onInput=${v => setTargets(targets.map((x, j) => (j === i ? { ...x, price: v } : x)))} /></div>
          <button type="button" class="btn sm icon ghost" aria-label="Remove target" onClick=${() => setTargets(targets.filter((_, j) => j !== i))}>×</button>
        </div>`)}
        <div><button type="button" class="btn sm" onClick=${() => setTargets([...targets, { date: todayYMD(), price: d.price }])}>+ Add target</button></div>
        <span class="hint small faint">Prices move in a straight line between targets, then grow at the rate above.</span>
      </div>
    </div>` : null}`;
}

export { describeSchedule, flowDirection };
void useMemo;
