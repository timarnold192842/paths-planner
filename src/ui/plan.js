import { useState } from 'preact/hooks';
import { html, money, compact, cls } from './h.js';
import { store } from '../store.js';
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

  return html`<div class="stack">
    <div class="page-head">
      <div>
        <h2>Plan</h2>
        <p>Everything lives here exactly once. Items marked with a decision badge exist only in some alternatives.</p>
      </div>
      <div class="row">
        <input type="search" placeholder="Filter…" value=${q} onInput=${e => setQ(e.target.value)} style="width:180px" aria-label="Filter items" />
        <button class="btn primary" onClick=${() => add(tab)}>+ Add</button>
      </div>
    </div>
    <div class="seg" role="tablist">${TABS.map(([k, l]) => html`<button role="tab" aria-selected=${tab === k} class=${tab === k ? 'on' : ''} onClick=${() => navigate(`plan/${k}`)}>${l} <span class="faint">${plan[k].length}</span></button>`)}</div>

    ${tab === 'accounts' ? html`<div class="card"><div class="list">
      ${ACCOUNT_KINDS.map(k => {
        const list = plan.accounts.filter(a => a.kind === k.id && match(a));
        if (!list.length) return null;
        return html`<div class="group-title">${k.label}</div>${list.map(a => {
          const unit = plan.units.find(u => u.id === a.unitId);
          return html`<div class="list-item" onClick=${() => open('accounts', a.id)}>
            <div class="title"><span class="name">${a.name}</span>${a.id === plan.settings.primaryCashId ? html`<span class="badge blue">Primary cash</span>` : null}${a.when ? html`<span class="badge blue" title=${whenLabel(plan, a.when, true)}>Only if: ${whenLabel(plan, a.when)}</span>` : null}${a.primaryResidence ? html`<span class="badge">Home</span>` : null}</div>
            <div class="meta">${a.growth ? `${a.growth}%/yr` : 'No growth'}${unit ? ` · ${a.balance.toLocaleString()} ${unit.symbol} @ ${money(unit.price, true)}` : ''}${a.costBasis != null && a.costBasis !== '' ? ` · basis ${compact(a.costBasis)}` : ''}${a.ownedFrom ? ` · from ${formatDate(a.ownedFrom)}` : ''}</div>
            <div class="amount">${money((a.balance || 0) * (unit ? unit.price : 1))}</div>
          </div>`;
        })}`;
      })}
      ${!plan.accounts.length ? html`<div class="empty">No accounts yet.</div>` : null}
    </div></div>` : null}

    ${tab === 'debts' ? html`<div class="card"><div class="list">
      ${plan.debts.filter(match).map(d => html`<div class=${cls('list-item', d.enabled === false && 'off')} onClick=${() => open('debts', d.id)}>
        <div class="title"><span class="name">${d.name}</span>${Number(d.creditLimit) > 0 ? html`<span class="badge">Credit line ${compact(d.creditLimit)}</span>` : null}${(plan.settings.safetyNet || []).includes(d.id) ? html`<span class="badge pos">Safety net</span>` : null}${d.securedBy ? html`<span class="badge">Secured by ${name(d.securedBy)}</span>` : null}${d.when ? html`<span class="badge blue" title=${whenLabel(plan, d.when, true)}>Only if: ${whenLabel(plan, d.when)}</span>` : null}${d.enabled === false ? html`<span class="badge">Off</span>` : null}</div>
        <div class="meta">${d.rate || 0}%${(d.rateSteps || []).length ? ` → ${d.rateSteps.map(x => `${x.rate}% from ${formatDate(x.date)}`).join(', ')}` : ''} · ${{ amortize: `paid off over ${d.termMonths || '?'} months`, interestOnly: 'interest only', minimum: `minimum ${d.minPct ?? 1}% (≥ ${money(d.payment)})` }[d.paymentRule] || `${money(d.payment)}/mo`}${d.payoffDate ? ` · paid off ${formatDate(d.payoffDate)}` : ''}${d.start ? ` · starts ${formatDate(d.start)}` : ''}${d.proceedsTo ? ` · → ${name(d.proceedsTo)}` : ''}</div>
        <div class="amount">${money(d.balance)}</div>
      </div>`)}
      ${!plan.debts.length ? html`<div class="empty">No debts.</div>` : null}
    </div></div>` : null}

    ${tab === 'flows' ? html`<div class="card"><div class="list">
      ${[...plan.groups, { id: undefined, name: 'Ungrouped' }].map(g => {
        const list = plan.flows.filter(f => (f.group || undefined) === g.id && match(f));
        if (!list.length) return null;
        const yearly = list.filter(f => f.enabled !== false).reduce((s, f) => {
          const dir = flowDirection(f);
          const unit = plan.units.find(u => u.id === f.unitId);
          const v = (Number(f.amount) || 0) * perYear(f.schedule) * (unit ? unit.price : 1);
          return s + (dir === 'income' ? v : dir === 'expense' ? -v : 0);
        }, 0);
        return html`<div class="group-title" style="display:flex;justify-content:space-between"><span>${g.name}</span><span class="num">${yearly ? `${yearly > 0 ? '+' : '−'}${compact(Math.abs(yearly))}/yr` : ''}</span></div>
          ${list.map(f => {
            const dir = flowDirection(f);
            const unit = plan.units.find(u => u.id === f.unitId);
            return html`<div class=${cls('list-item', f.enabled === false && 'off')} onClick=${() => open('flows', f.id)}>
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
          })}`;
      })}
      ${!plan.flows.length ? html`<div class="empty">No cash flows yet. Add your paycheck and regular expenses.</div>` : null}
    </div></div>` : null}

    ${tab === 'events' ? html`<div class="card"><div class="list">
      ${plan.events.filter(match).map(e => html`<div class=${cls('list-item', e.enabled === false && 'off')} onClick=${() => open('events', e.id)}>
        <div class="title"><span class="name">${e.name || e.type}</span><span class="badge">${{ sell: 'Sale', buy: 'Purchase', payoff: 'Payoff', liquidate: 'Share sale' }[e.type] || e.type}</span>${e.when ? html`<span class="badge blue" title=${whenLabel(plan, e.when, true)}>Only if: ${whenLabel(plan, e.when)}</span>` : null}</div>
        <div class="meta">${e.type === 'liquidate' && e.schedule ? describeSchedule(e.schedule) : formatDate(e.date)}${e.assetId ? ` · ${name(e.assetId)}` : ''}${e.debtId ? ` · ${name(e.debtId)}` : ''}</div>
        <div class="amount">${e.price ? money(e.price) : e.type === 'liquidate' ? (e.mode === 'percent' ? `${e.amount}%` : e.mode === 'usd' ? money(e.amount) : `${e.amount} sh`) : ''}</div>
      </div>`)}
      ${!plan.events.length ? html`<div class="empty">No events. Sales, purchases and payoffs are usually created from a decision template.</div>` : null}
    </div></div>` : null}

    ${tab === 'units' ? html`<div class="card"><div class="list">
      ${plan.units.filter(match).map(u => {
        const asm = plan.assumptions.find(a => a.id === u.assumptionId);
        return html`<div class="list-item" onClick=${() => open('units', u.id)}>
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
