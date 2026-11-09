// "Edit plan" panel: the plan as a compact list docked beside the chart. Amounts, on/off and
// dates are edited in place and the plan re-runs as you type; names open the full editor.
// A strip at the top shows what the edits since opening did, with a one-click revert.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html, money, compact, signed, cls } from './h.js';
import { store, useUI } from '../store.js';
import { describeSchedule, perYear } from '../engine/schedule.js';
import { formatMonthYear } from '../engine/dates.js';
import { ItemSheet, flowDirection, whenLabel } from './editors.js';
import { getRun, scenarioName } from './runs.js';

const TABS = [['flows', 'Cash flows'], ['accounts', 'Accounts'], ['debts', 'Debts'], ['events', 'Events']];

// A number box that keeps its own text while focused and commits shortly after typing stops.
function LiveNum({ value, onCommit, label, width = 92, suffix }) {
  const [text, setText] = useState(value ?? '');
  const focused = useRef(false);
  const timer = useRef(0);
  useEffect(() => { if (!focused.current) setText(value ?? ''); }, [value]);
  const commit = t => { const n = t === '' ? null : Number(t); if (t === '' || Number.isFinite(n)) onCommit(n); };
  const mag = Math.abs(Number(value) || 0);
  const step = mag >= 10000 ? 500 : mag >= 1000 ? 50 : mag >= 100 ? 10 : mag >= 10 ? 1 : 0.25;
  return html`<label class="live-num" style=${`width:${width}px`}>
    <input type="number" inputmode="decimal" step=${step} value=${text} aria-label=${label}
      onFocus=${() => { focused.current = true; }}
      onBlur=${e => { focused.current = false; clearTimeout(timer.current); commit(e.target.value); }}
      onInput=${e => { const t = e.target.value; setText(t); clearTimeout(timer.current); timer.current = setTimeout(() => commit(t), 250); }}
      onKeyDown=${e => { if (e.key === 'Enter') { clearTimeout(timer.current); commit(e.target.value); e.target.blur(); } }} />
    ${suffix ? html`<span class="suffix">${suffix}</span>` : null}
  </label>`;
}

function LiveDate({ value, onCommit, label }) {
  return html`<input type="date" class="live-date" value=${value || ''} aria-label=${label} onChange=${e => onCommit(e.target.value || undefined)} />`;
}

function Switch({ on, onChange, label }) {
  return html`<button type="button" role="switch" aria-checked=${on} aria-label=${label} class=${cls('switch', on && 'on')} onClick=${e => { e.stopPropagation(); onChange(!on); }}><span></span></button>`;
}

const edit = (coll, id, path, value) => store.update(p => {
  const item = p[coll].find(x => x.id === id);
  if (!item) return;
  const keys = path.split('.');
  let o = item;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  if (value === undefined || value === null && path !== 'enabled') delete o[keys.at(-1)]; else o[keys.at(-1)] = value;
}, { coalesce: `${id}.${path}` });

function Impact({ base, scenarioId, onRebase }) {
  const plan = store.plan;
  if (base === plan) return html`<div class="impact quiet small muted"><span>Edits re-run <b>${scenarioName(plan, scenarioId)}</b> as you type and apply to every scenario. ⌘Z undoes.</span></div>`;
  const a = getRun(base, scenarioId).metrics;
  const b = getRun(plan, scenarioId).metrics;
  const d10 = (b.at[10]?.afterTaxReal ?? 0) - (a.at[10]?.afterTaxReal ?? 0);
  const dEnd = b.end.afterTaxReal - a.end.afterTaxReal;
  const dCash = b.minCashNear.value - a.minCashNear.value;
  const tone = v => (Math.abs(v) < 1 ? '' : v > 0 ? 'pos' : 'neg');
  if ([d10, dEnd, dCash].every(v => Math.abs(v) < 0.5)) return html`<div class="impact quiet small muted"><span>No change yet from when you opened this panel. Edits re-run <b>${scenarioName(plan, scenarioId)}</b> as you type and apply to every scenario.</span></div>`;
  return html`<div class="impact" title=${`Change since you opened this panel · ${scenarioName(plan, scenarioId)} · after tax, today's dollars`}>
    <div class="impact-row">
      <span class="muted">Since opening:</span>
      <span>10 yrs <b class=${tone(d10)}>${signed(d10)}</b></span>
      <span>${plan.horizonYears} yrs <b class=${tone(dEnd)}>${signed(dEnd)}</b></span>
      <span>Low cash <b class=${tone(dCash)}>${signed(dCash)}</b>${b.minCashNear.value < 0 ? html` <span class="neg">(${compact(b.minCashNear.value)} ${formatMonthYear(b.minCashNear.date)})</span>` : ''}</span>
    </div>
    <div class="impact-actions">
      <button type="button" class="btn sm" onClick=${() => { store.replace(base); onRebase(); }}>Revert</button>
      <button type="button" class="btn sm ghost" title="Keep these edits and measure further changes from here" onClick=${onRebase}>Keep as new start</button>
    </div>
  </div>`;
}

export function EditPanel({ scenarioId, onClose }) {
  const plan = store.plan;
  const [tab, setTab] = useUI('panelTab', 'flows');
  const [q, setQ] = useState('');
  const [sheet, setSheet] = useState(null);
  const [open, setOpen] = useState(null); // id of the row showing more fields
  const [collapsed, setCollapsed] = useUI('panelCollapsed', {});
  const [base, setBase] = useState(() => store.plan);
  const match = x => !q || (x.name || '').toLowerCase().includes(q.toLowerCase());
  const name = id => plan.accounts.find(a => a.id === id)?.name || plan.debts.find(d => d.id === id)?.name || '—';

  const groups = useMemo(() => {
    if (tab !== 'flows') return [];
    return [...plan.groups, { id: '', name: 'Ungrouped' }].map(g => ({ ...g, items: plan.flows.filter(f => (f.group || '') === g.id && match(f)) })).filter(g => g.items.length);
  }, [plan, tab, q]);

  const row = (coll, item, fields, meta, more) => {
    const off = item.enabled === false;
    return html`<div class=${cls('prow', off && 'off')} key=${item.id}>
      <${Switch} on=${!off} label=${`${off ? 'Include' : 'Exclude'} ${item.name}`} onChange=${v => edit(coll, item.id, 'enabled', v)} />
      <div class="prow-main">
        <button type="button" class="prow-name" title="Open the full editor" onClick=${() => setSheet({ coll, id: item.id })}>${item.name || item.type}</button>
        <div class="prow-meta">${meta}${item.when ? html` · <span class="badge blue">Only if: ${whenLabel(plan, item.when)}</span>` : ''}</div>
      </div>
      <div class="prow-fields">${fields}
        ${more ? html`<button type="button" class=${cls('more-btn', open === item.id && 'on')} aria-expanded=${open === item.id} aria-label="More fields" title="Dates & growth" onClick=${() => setOpen(open === item.id ? null : item.id)}>⋯</button>` : null}
      </div>
      ${more && open === item.id ? html`<div class="prow-more">${more}</div>` : null}
    </div>`;
  };

  const flowRow = f => {
    const dir = flowDirection(f);
    const unit = plan.units.find(u => u.id === f.unitId);
    const yearly = (Number(f.amount) || 0) * perYear(f.schedule) * (unit ? unit.price : 1);
    return row('flows', f,
      html`<span class=${cls('sign', dir === 'income' ? 'pos' : '')}>${dir === 'income' ? '+' : dir === 'expense' ? '−' : '⇄'}</span><${LiveNum} value=${f.amount} label=${`${f.name} amount`} suffix=${unit ? unit.symbol : null} onCommit=${v => edit('flows', f.id, 'amount', v ?? 0)} />`,
      `${describeSchedule(f.schedule)}${yearly && f.schedule?.freq !== 'once' ? ` · ${compact(yearly)}/yr` : ''}${f.pay ? ' · gross pay' : ''}`,
      html`<label>${f.schedule?.freq === 'once' ? 'Date' : 'Starts'} <${LiveDate} value=${f.schedule?.start} label="Start date" onCommit=${v => v && edit('flows', f.id, 'schedule.start', v)} /></label>
        ${f.schedule?.freq !== 'once' ? html`<label>Ends <${LiveDate} value=${f.schedule?.end} label="End date" onCommit=${v => edit('flows', f.id, 'schedule.end', v)} /></label>
        <label>Grows <${LiveNum} value=${f.growth} width=${70} suffix="%/yr" label="Growth per year" onCommit=${v => edit('flows', f.id, 'growth', v ?? 0)} /></label>` : null}`);
  };

  let body;
  if (tab === 'flows') {
    body = groups.map(g => {
      const key = g.id || 'none';
      const isOpen = q || !collapsed[key];
      return html`<div key=${key}>
        <button type="button" class="pgroup" aria-expanded=${!!isOpen} onClick=${() => setCollapsed({ ...collapsed, [key]: !collapsed[key] })}>
          <span class="chev">${isOpen ? '▾' : '▸'}</span>${g.name}<span class="faint">${g.items.length}</span>
        </button>
        ${isOpen ? g.items.map(flowRow) : null}
      </div>`;
    });
  } else if (tab === 'accounts') {
    body = plan.accounts.filter(match).map(a => {
      const unit = plan.units.find(u => u.id === a.unitId);
      return row('accounts', a,
        html`<${LiveNum} value=${a.balance} label=${`${a.name} balance`} suffix=${unit ? unit.symbol : null} onCommit=${v => edit('accounts', a.id, 'balance', v ?? 0)} />`,
        `${a.growth ? `${a.growth}%/yr` : 'no growth'}${unit ? ` · ${money(a.balance * unit.price)}` : ''}`,
        html`<label>Grows <${LiveNum} value=${a.growth} width=${70} suffix="%/yr" label="Growth per year" onCommit=${v => edit('accounts', a.id, 'growth', v ?? 0)} /></label>`);
    });
  } else if (tab === 'debts') {
    body = plan.debts.filter(match).map(d => row('debts', d,
      html`<${LiveNum} value=${d.balance} label=${`${d.name} balance`} onCommit=${v => edit('debts', d.id, 'balance', v ?? 0)} />`,
      `${d.rate || 0}% · ${d.paymentRule && d.paymentRule !== 'fixed' ? d.paymentRule : `${money(d.payment)}/mo`}${d.payoffDate ? ` · paid off ${formatMonthYear(d.payoffDate)}` : ''}`,
      html`<label>Rate <${LiveNum} value=${d.rate} width=${70} suffix="%" label="Interest rate" onCommit=${v => edit('debts', d.id, 'rate', v ?? 0)} /></label>
        <label>Payment <${LiveNum} value=${d.payment} width=${84} label="Monthly payment" onCommit=${v => edit('debts', d.id, 'payment', v ?? 0)} /></label>
        <label>Pay off on <${LiveDate} value=${d.payoffDate} label="Payoff date" onCommit=${v => edit('debts', d.id, 'payoffDate', v)} /></label>
        ${d.start || d.proceedsTo ? html`<label>Starts <${LiveDate} value=${d.start} label="Start date" onCommit=${v => edit('debts', d.id, 'start', v)} /></label>` : null}`));
  } else {
    body = plan.events.filter(match).map(e => row('events', e,
      e.type === 'liquidate' && e.schedule ? html`<span class="small muted">${describeSchedule(e.schedule)}</span>` : html`<${LiveDate} value=${e.date} label=${`${e.name} date`} onCommit=${v => v && edit('events', e.id, 'date', v)} />`,
      `${{ sell: 'Sale', buy: 'Purchase', payoff: 'Payoff', liquidate: 'Share sale' }[e.type] || e.type}${e.assetId ? ` · ${name(e.assetId)}` : ''}${e.debtId ? ` · ${name(e.debtId)}` : ''}`,
      e.type === 'sell' || e.type === 'buy' ? html`<label>Price <${LiveNum} value=${e.price} width=${100} label="Price (empty = modeled value)" onCommit=${v => edit('events', e.id, 'price', v)} /></label>
        ${e.type === 'sell' ? html`<label>Costs <${LiveNum} value=${e.costPct} width=${64} suffix="%" label="Selling costs" onCommit=${v => edit('events', e.id, 'costPct', v ?? 0)} /></label>` : null}` : null));
  }

  return html`<aside class="edit-panel" aria-label="Edit plan">
    <div class="ep-head">
      <div class="ep-grip" aria-hidden="true"></div>
      <h3>Edit plan</h3>
      <a class="small" href="#/plan">Full list</a>
      <button type="button" class="btn sm icon ghost" aria-label="Close the edit panel" onClick=${onClose}>×</button>
    </div>
    <${Impact} base=${base} scenarioId=${scenarioId} onRebase=${() => setBase(store.plan)} />
    <div class="ep-tools">
      <div class="seg sm" role="tablist">${TABS.map(([k, l]) => html`<button role="tab" aria-selected=${tab === k} class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}</div>
      <input type="search" placeholder="Filter…" value=${q} onInput=${e => setQ(e.target.value)} aria-label="Filter the plan" />
    </div>
    <div class="ep-list">${body}${!body.length ? html`<div class="empty small">Nothing here${q ? ' matches' : ' yet'}.</div>` : null}</div>
    ${sheet ? html`<${ItemSheet} coll=${sheet.coll} id=${sheet.id} onClose=${() => setSheet(null)} />` : null}
  </aside>`;
}
