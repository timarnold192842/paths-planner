import { useEffect, useMemo, useState } from 'preact/hooks';
import { html, money, cls } from './h.js';
import { store } from '../store.js';
import { ACCOUNT_KINDS, kindInfo, newId, clone, setPath, getPath } from '../engine/model.js';
import { FREQUENCIES, describeSchedule, perYear } from '../engine/schedule.js';
import { todayYMD } from '../engine/dates.js';

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
export function Waterfall({ plan, value = [], onChange, fallbackNote = true }) {
  const list = value || [];
  const primary = plan.accounts.find(a => a.id === plan.settings.primaryCashId);
  const available = plan.accounts.filter(a => kindInfo(a.kind).withdrawable && !list.includes(a.id));
  const move = (i, d) => { const n = [...list]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); onChange(n); };
  return html`<div class="waterfall">
    ${list.map((id, i) => {
      const a = plan.accounts.find(x => x.id === id);
      return html`<div class="wf-row" key=${id}>
        <span class="wf-n">${i + 1}</span>
        <span>${a ? a.name : html`<span class="neg">Missing account</span>`}</span>
        <button type="button" class="btn sm icon ghost" aria-label="Move up" disabled=${i === 0} onClick=${() => move(i, -1)}>↑</button>
        <button type="button" class="btn sm icon ghost" aria-label="Move down" disabled=${i === list.length - 1} onClick=${() => move(i, 1)}>↓</button>
        <button type="button" class="btn sm icon ghost" aria-label="Remove" onClick=${() => onChange(list.filter(x => x !== id))}>×</button>
      </div>`;
    })}
    <select value="" onChange=${e => { if (e.target.value) onChange([...list, e.target.value]); e.target.value = ''; }}>
      <option value="">${list.length ? '+ Then pay from…' : '+ Pay from… (default: primary cash)'}</option>
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

export function whenLabel(plan, when) {
  if (!when) return '';
  return Object.entries(when).map(([dId, alts]) => {
    const d = plan.decisions.find(x => x.id === dId);
    if (!d) return null;
    return `${d.name}: ${alts.map(a => d.alternatives.find(x => x.id === a)?.name || '?').join(' / ')}`;
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
          <summary>Only in some alternatives ${d.when ? html`<span class="badge blue">${whenLabel(plan, d.when)}</span>` : null}</summary>
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
  return html`<div class="form-grid">
    <${Field} label="Name" wide><${Text} value=${d.name} onInput=${v => set('name', v)} /><//>
    <${Field} label="Balance today ($)" hint=${d.start ? 'Original amount (starts on the start date)' : null}><${Num} value=${d.balance} onInput=${v => set('balance', v)} /><//>
    <${Field} label="Interest rate (%/yr)"><${Num} value=${d.rate} onInput=${v => set('rate', v)} /><//>
    <${Field} label="Monthly payment ($)"><${Num} value=${d.payment} onInput=${v => set('payment', v)} /><//>
    <${Field} label="Payment day"><${Num} value=${d.paymentDay} min="1" step="1" onInput=${v => set('paymentDay', v)} /><//>
    <${Field} label="Pay off in full on" hint="Remaining balance is paid in one lump sum"><${DateIn} value=${d.payoffDate} onInput=${v => set('payoffDate', v)} /><//>
    <${Field} label="Starts on" hint="Only for loans that begin in the future"><${DateIn} value=${d.start} onInput=${v => set('start', v)} /><//>
    <${Field} label="Secured by" hint="Paid off from the proceeds when this asset is sold"><${Select} value=${d.securedBy} empty="Nothing" onChange=${v => set('securedBy', v)} options=${accountOptions(plan, a => a.kind === 'property' || a.kind === 'other')} /><//>
    <${Field} label="Payments come from" wide><${Waterfall} plan=${plan} value=${d.payFrom} onChange=${v => set('payFrom', v)} /><//>
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
  return html`
    <div class="seg" role="tablist" aria-label="Direction">
      ${[['expense', 'Expense'], ['income', 'Income'], ['transfer', 'Transfer']].map(([k, l]) => html`<button type="button" class=${dir === k ? 'on' : ''} onClick=${() => setDir(k)}>${l}</button>`)}
    </div>
    <div class="form-grid">
      <${Field} label="Name" wide><${Text} value=${d.name} onInput=${v => set('name', v)} /><//>
      <${Field} label=${unit ? `Amount (${unit.symbol} shares)` : 'Amount ($)'} hint=${yearly ? `≈ ${money(yearly)}/yr today` : null}><${Num} value=${d.amount} onInput=${v => set('amount', v)} /><//>
      <${Field} label="Denominated in"><${Select} value=${d.unitId} empty="US dollars" onChange=${v => set('unitId', v)} options=${plan.units.map(u => ({ value: u.id, label: `${u.name} shares` }))} /><//>
      <${Field} label="Grows (%/yr)" hint="Inflation, raises"><${Num} value=${d.growth} onInput=${v => set('growth', v)} /><//>
      <${Field} label="Group"><${GroupSelect} plan=${plan} value=${d.group} onChange=${v => set('group', v)} /><//>
      ${dir !== 'expense' ? html`<${Field} label="Goes to"><${Select} value=${d.to} onChange=${v => set('to', v || null)} options=${toOptions} /><//>` : null}
    </div>
    <div><div class="section-label">When</div><${ScheduleEditor} value=${d.schedule} onChange=${v => set('schedule', v)} /></div>
    ${dir !== 'income' ? html`<div><div class="section-label">${dir === 'transfer' ? 'Comes from' : 'Paid from (in order)'}</div>
      <${Waterfall} plan=${plan} value=${d.from} onChange=${v => set('from', v)} fallbackNote=${dir === 'expense'} />
      ${dir === 'expense' ? html`<div class="row" style="margin-top:8px"><span class="small muted">Qualified for</span>
        <div class="seg">${[[undefined, 'None'], ['education', 'Education (529)'], ['medical', 'Medical (HSA)']].map(([k, l]) => html`<button type="button" class=${d.qualified === k ? 'on' : ''} onClick=${() => set('qualified', k)}>${l}</button>`)}</div></div>` : null}
    </div>` : null}
    <details class="more" open=${!!(d.steps?.length || d.whileOwned || d.taxed || d.withholdPct)}>
      <summary>Changes over time, ownership & taxes</summary>
      <div class="stack">
        <div><div class="section-label">Amount changes</div><${StepsEditor} steps=${d.steps || []} onChange=${v => set('steps', v)} /></div>
        <div class="form-grid">
          <${Field} label="Only while I own" hint="Stops automatically when this asset is sold"><${Select} value=${d.whileOwned} empty="—" onChange=${v => set('whileOwned', v)} options=${accountOptions(plan, a => a.kind === 'property' || a.kind === 'other' || a.kind === 'equity')} /><//>
          ${dir === 'income' ? html`<${Field} label="Income tax"><${Select} value=${d.taxed} empty="Already net of tax" onChange=${v => set('taxed', v)} options=${[{ value: 'ordinary', label: 'Taxed at my ordinary rate' }]} /><//>` : null}
          ${dir === 'income' && unit ? html`<${Field} label="Shares withheld for tax (%)" hint="Sell-to-cover at vest"><${Num} value=${d.withholdPct} onInput=${v => set('withholdPct', v)} /><//>` : null}
        </div>
      </div>
    </details>`;
}

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
