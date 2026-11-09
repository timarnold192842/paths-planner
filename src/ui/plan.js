import { useState } from 'preact/hooks';
import { html, money, compact, cls } from './h.js';
import { store, useUI } from '../store.js';
import { useSortable, DragHandle, moveItem } from './sortable.js';
import { kindInfo, ACCOUNT_KINDS } from '../engine/model.js';
import { describeSchedule, perYear } from '../engine/schedule.js';
import { formatDate } from '../engine/dates.js';
import { ItemSheet, blankItem, whenLabel, flowDirection } from './editors.js';
import { navigate } from './nav.js';

const TABS = [['accounts', 'Accounts'], ['debts', 'Debts'], ['flows', 'Cash flows'], ['events', 'Events'], ['units', 'Prices']];

export function Plan({ tab = 'flows' }) {
  const plan = store.plan;
  const [sheet, setSheet] = useState(null);
  const [q, setQ] = useState('');
  const open = (coll, id) => setSheet({ coll, id });
  const add = (coll, extra) => setSheet({ coll, draft: blankItem(coll, plan, extra) });
  const name = id => plan.accounts.find(a => a.id === id)?.name || plan.debts.find(d => d.id === id)?.name || '—';
  const match = x => !q || (x.name || '').toLowerCase().includes(q.toLowerCase());

  // ---- reordering & collapsible groups ----
  const [collapsed, setCollapsed] = useUI('planCollapsed', {});
  const isOpen = key => q || !collapsed[`${tab}:${key}`];
  const toggle = key => setCollapsed(c => ({ ...c, [`${tab}:${key}`]: !c[`${tab}:${key}`] }));
  const GROUPING = {
    accounts: { groupOf: a => a.kind },
    flows: { groupOf: f => f.group || '', setGroup: (f, g) => { if (g) f.group = g; else delete f.group; } }
  };
  const opts = GROUPING[tab] || {};
  const reorder = (id, target) => store.update(p => { p[tab] = moveItem(p[tab], id, target, opts); });
  const sortable = useSortable({
    onMove: reorder,
    // accounts stay under their kind; cash flows can move between groups
    canDrop: (id, group) => tab !== 'accounts' || plan.accounts.find(a => a.id === id)?.kind === group
  });
  const canSort = !q;
  // One row's grip + drop attributes. `siblings` = ids in the same visible group, for ↑/↓ keys.
  const sortProps = (item, group) => ({
    'data-sort-id': item.id,
    'data-sort-group': group ?? '',
    key: item.id
  });
  const grip = (item, group, siblings) => (canSort ? html`<${DragHandle} label=${item.name || item.type}
    onPointerDown=${sortable.start(item.id, group ?? '')}
    onKeyMove=${dir => {
      const k = siblings.indexOf(item.id) + dir;
      if (k < 0 || k >= siblings.length) return;
      reorder(item.id, { id: siblings[k], pos: dir < 0 ? 'before' : 'after', group: group ?? '' });
      requestAnimationFrame(() => document.querySelector(`[data-sort-id="${item.id}"] .drag-handle`)?.focus());
    }} />` : null);
  const rowCls = (item, ...extra) => cls('list-item', canSort && 'sortable', sortable.rowClass(item.id), ...extra);
  const groupHead = (key, label, count, right) => html`<div class=${cls('group-title', 'collapsible', sortable.headerClass(key))} data-sort-header=${key}
      role="button" tabindex="0" aria-expanded=${!!isOpen(key)} onClick=${() => toggle(key)} onKeyDown=${e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(key); } }}>
      <span class="chev" aria-hidden="true">${isOpen(key) ? '▾' : '▸'}</span><span>${label}</span>${!isOpen(key) ? html`<span class="faint count">${count}</span>` : null}<span class="num">${right || ''}</span>
    </div>`;

  return html`<div class="stack">
    <div class="page-head">
      <div>
        <h2>Plan</h2>
        <p>Everything lives here exactly once. Items marked with a decision badge exist only in some alternatives. Drag <span aria-hidden="true">⠿</span> to reorder${tab === 'flows' ? ' or move between groups' : ''}; click a group to fold it.</p>
      </div>
      <div class="row">
        ${tab === 'flows' || tab === 'accounts' ? html`<button class="btn ghost sm" onClick=${() => {
          const keys = tab === 'flows' ? [...plan.groups.map(g => g.id), ''] : ACCOUNT_KINDS.map(k => k.id);
          const anyOpen = keys.some(k => !collapsed[`${tab}:${k}`]);
          setCollapsed(c => ({ ...c, ...Object.fromEntries(keys.map(k => [`${tab}:${k}`, anyOpen])) }));
        }}>${[...(tab === 'flows' ? [...plan.groups.map(g => g.id), ''] : ACCOUNT_KINDS.map(k => k.id))].some(k => !collapsed[`${tab}:${k}`]) ? 'Collapse all' : 'Expand all'}</button>` : null}
        <input type="search" placeholder="Filter…" value=${q} onInput=${e => setQ(e.target.value)} style="width:180px" aria-label="Filter items" />
        <button class="btn primary" onClick=${() => add(tab)}>+ Add</button>
      </div>
    </div>
    <div class="seg" role="tablist">${TABS.map(([k, l]) => html`<button role="tab" aria-selected=${tab === k} class=${tab === k ? 'on' : ''} onClick=${() => navigate(`plan/${k}`)}>${l} <span class="faint">${plan[k].length}</span></button>`)}</div>

    ${tab === 'accounts' ? html`<div class="card"><div class="list">
      ${ACCOUNT_KINDS.map(k => {
        const list = plan.accounts.filter(a => a.kind === k.id && match(a));
        if (!list.length) return null;
        const ids = list.map(a => a.id);
        const total = list.reduce((s2, a) => s2 + (a.balance || 0) * (plan.units.find(u => u.id === a.unitId)?.price || 1), 0);
        return html`${groupHead(k.id, k.label, list.length, compact(total))}${isOpen(k.id) ? list.map(a => {
          const unit = plan.units.find(u => u.id === a.unitId);
          return html`<div ...${sortProps(a, k.id, ids)} class=${rowCls(a)} onClick=${() => open('accounts', a.id)}>
            ${grip(a, k.id, ids)}
            <div class="title"><span class="name">${a.name}</span>${a.id === plan.settings.primaryCashId ? html`<span class="badge blue">Primary cash</span>` : null}${a.when ? html`<span class="badge blue" title=${whenLabel(plan, a.when, true)}>Only if: ${whenLabel(plan, a.when)}</span>` : null}${a.primaryResidence ? html`<span class="badge">Home</span>` : null}</div>
            <div class="meta">${a.growth ? `${a.growth}%/yr` : 'No growth'}${unit ? ` · ${a.balance.toLocaleString()} ${unit.symbol} @ ${money(unit.price, true)}` : ''}${a.costBasis != null && a.costBasis !== '' ? ` · basis ${compact(a.costBasis)}` : ''}${a.ownedFrom ? ` · from ${formatDate(a.ownedFrom)}` : ''}</div>
            <div class="amount">${money((a.balance || 0) * (unit ? unit.price : 1))}</div>
          </div>`;
        }) : null}`;
      })}
      ${!plan.accounts.length ? html`<div class="empty">No accounts yet.</div>` : null}
    </div></div>` : null}

    ${tab === 'debts' ? html`<div class="card"><div class="list">
      ${plan.debts.filter(match).map((d, _, arr) => html`<div ...${sortProps(d, '', arr.map(x => x.id))} class=${rowCls(d, d.enabled === false && 'off')} onClick=${() => open('debts', d.id)}>
        ${grip(d, '', arr.map(x => x.id))}
        <div class="title"><span class="name">${d.name}</span>${Number(d.creditLimit) > 0 ? html`<span class="badge">Credit line ${compact(d.creditLimit)}</span>` : null}${(plan.settings.safetyNet || []).includes(d.id) ? html`<span class="badge pos">Safety net</span>` : null}${d.securedBy ? html`<span class="badge">Secured by ${name(d.securedBy)}</span>` : null}${d.when ? html`<span class="badge blue" title=${whenLabel(plan, d.when, true)}>Only if: ${whenLabel(plan, d.when)}</span>` : null}${d.enabled === false ? html`<span class="badge">Off</span>` : null}</div>
        <div class="meta">${d.rate || 0}%${(d.rateSteps || []).length ? ` → ${d.rateSteps.map(x => `${x.rate}% from ${formatDate(x.date)}`).join(', ')}` : ''} · ${{ amortize: `paid off over ${d.termMonths || '?'} months`, interestOnly: 'interest only', minimum: `minimum ${d.minPct ?? 1}% (≥ ${money(d.payment)})` }[d.paymentRule] || `${money(d.payment)}/mo`}${d.payoffDate ? ` · paid off ${formatDate(d.payoffDate)}` : ''}${d.start ? ` · starts ${formatDate(d.start)}` : ''}${d.proceedsTo ? ` · → ${name(d.proceedsTo)}` : ''}</div>
        <div class="amount">${money(d.balance)}</div>
      </div>`)}
      ${!plan.debts.length ? html`<div class="empty">No debts.</div>` : null}
    </div></div>` : null}

    ${tab === 'flows' ? html`<div class="card"><div class="list">
      ${[...plan.groups, { id: undefined, name: 'Ungrouped' }].map(g => {
        const list = plan.flows.filter(f => (f.group || undefined) === g.id && match(f));
        if (!list.length && !(sortable.dragging && g.id)) return null;
        const yearly = list.filter(f => f.enabled !== false).reduce((s, f) => {
          const dir = flowDirection(f);
          const unit = plan.units.find(u => u.id === f.unitId);
          const v = (Number(f.amount) || 0) * perYear(f.schedule) * (unit ? unit.price : 1);
          return s + (dir === 'income' ? v : dir === 'expense' ? -v : 0);
        }, 0);
        const key = g.id || '';
        const ids = list.map(f => f.id);
        return html`${groupHead(key, g.name, list.length, yearly ? `${yearly > 0 ? '+' : '−'}${compact(Math.abs(yearly))}/yr` : '')}
          ${isOpen(key) ? list.map(f => {
            const dir = flowDirection(f);
            const unit = plan.units.find(u => u.id === f.unitId);
            return html`<div ...${sortProps(f, key, ids)} class=${rowCls(f, f.enabled === false && 'off')} onClick=${() => open('flows', f.id)}>
              ${grip(f, key, ids)}
              <div class="title"><span class="name">${f.name}</span>
                ${f.when ? html`<span class="badge blue" title=${whenLabel(plan, f.when, true)}>Only if: ${whenLabel(plan, f.when)}</span>` : null}
                ${f.whileOwned ? html`<span class="badge">While own ${name(f.whileOwned)}</span>` : null}
                ${f.pay && dir === 'income' ? html`<span class="badge" title="Gross pay; taxes and deductions are withheld">Paycheck</span>` : null}
                ${(f.steps || []).length ? html`<span class="badge">Changes ×${f.steps.length}</span>` : null}
                ${f.enabled === false ? html`<span class="badge">Off</span>` : null}
              </div>
              <div class="meta">${describeSchedule(f.schedule)}${f.schedule?.end ? ` until ${formatDate(f.schedule.end)}` : ''}${f.growth ? ` · +${f.growth}%/yr` : ''} · ${dir === 'income' ? `→ ${name(f.to)}` : dir === 'transfer' ? `${(f.from || []).map(name).join(' → ')} → ${name(f.to)}` : `from ${(f.from || []).length ? (f.from || []).map(name).join(', then ') + ', then cash' : 'cash'}`}</div>
              <div class=${cls('amount', dir === 'income' ? 'pos' : '')}>${dir === 'income' ? '+' : dir === 'expense' ? '−' : ''}${unit ? `${(f.amount || 0).toLocaleString()} ${unit.symbol}` : money(f.amount)}</div>
            </div>`;
          }) : null}`;
      })}
      ${!plan.flows.length ? html`<div class="empty">No cash flows yet. Add your paycheck and regular expenses.</div>` : null}
    </div></div>` : null}

    ${tab === 'events' ? html`<div class="card"><div class="list">
      ${plan.events.filter(match).map((e, _, arr) => html`<div ...${sortProps(e, '', arr.map(x => x.id))} class=${rowCls(e, e.enabled === false && 'off')} onClick=${() => open('events', e.id)}>
        ${grip(e, '', arr.map(x => x.id))}
        <div class="title"><span class="name">${e.name || e.type}</span><span class="badge">${{ sell: 'Sale', buy: 'Purchase', payoff: 'Payoff', liquidate: 'Share sale' }[e.type] || e.type}</span>${e.when ? html`<span class="badge blue" title=${whenLabel(plan, e.when, true)}>Only if: ${whenLabel(plan, e.when)}</span>` : null}</div>
        <div class="meta">${e.type === 'liquidate' && e.schedule ? describeSchedule(e.schedule) : formatDate(e.date)}${e.assetId ? ` · ${name(e.assetId)}` : ''}${e.debtId ? ` · ${name(e.debtId)}` : ''}</div>
        <div class="amount">${e.price ? money(e.price) : e.type === 'liquidate' ? (e.mode === 'percent' ? `${e.amount}%` : e.mode === 'usd' ? money(e.amount) : `${e.amount} sh`) : ''}</div>
      </div>`)}
      ${!plan.events.length ? html`<div class="empty">No events. Sales, purchases and payoffs are usually created from a decision template.</div>` : null}
    </div></div>` : null}

    ${tab === 'units' ? html`<div class="card"><div class="list">
      ${plan.units.filter(match).map((u, _, arr) => {
        const asm = plan.assumptions.find(a => a.id === u.assumptionId);
        return html`<div ...${sortProps(u, '', arr.map(x => x.id))} class=${rowCls(u)} onClick=${() => open('units', u.id)}>
          ${grip(u, '', arr.map(x => x.id))}
          <div class="title"><span class="name">${u.name}</span><span class="badge">${u.symbol}</span>${asm ? html`<span class="badge warn">${asm.cases.length} cases · ${asm.name}</span>` : null}</div>
          <div class="meta">${asm ? asm.cases.map(c => `${c.name}: ${(u.paths?.[c.id] || []).length} targets`).join(' · ') : 'Single price path'}${u.growth ? ` · then +${u.growth}%/yr` : ''}</div>
          <div class="amount">${money(u.price, true)}</div>
        </div>`;
      })}
      ${!plan.units.length ? html`<div class="empty">No price models. Add one for company stock or anything priced per share.</div>` : null}
    </div></div>` : null}

    ${sheet ? html`<${ItemSheet} coll=${sheet.coll} id=${sheet.id} draftItem=${sheet.draft} onClose=${() => setSheet(null)} />` : null}
  </div>`;
}

export { kindInfo };
