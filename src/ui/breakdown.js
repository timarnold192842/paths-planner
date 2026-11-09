// "Why": where a change in net worth comes from, and what drives the difference between scenarios.
import { html, compact, signed, cls } from './h.js';
import { attributionUpTo } from '../engine/simulate.js';
import { durationLabel } from './chart.js';

export const KIND_META = {
  income: { label: 'Income', color: '#16a34a' },
  spending: { label: 'Spending', color: '#ea580c' },
  taxes: { label: 'Taxes', color: '#dc2626' },
  interest: { label: 'Interest on debt', color: '#b91c1c' },
  costs: { label: 'Fees & transaction costs', color: '#9f1239' },
  growth: { label: 'Growth & appreciation', color: '#2563eb' },
  other: { label: 'Other', color: '#64748b' }
};
const KIND_ORDER = ['income', 'spending', 'taxes', 'interest', 'costs', 'growth', 'other'];

// Bucket totals for the first `years` years, grouped by kind.
export function summarize(run, years) {
  const items = [...attributionUpTo(run, years).values()];
  const byKind = Object.fromEntries(KIND_ORDER.map(k => [k, 0]));
  for (const b of items) byKind[b.kind] += b.total;
  return { items, byKind };
}

// Per-year totals by kind (an annual income statement).
export function yearly(run) {
  const Y = run.attribution.years;
  const rows = Array.from({ length: Y }, () => Object.fromEntries(KIND_ORDER.map(k => [k, 0])));
  for (const b of run.attribution.buckets) for (let y = 0; y < Y; y++) rows[y][b.kind] += b.values[y];
  return rows;
}

function Bars({ rows, max }) {
  return html`<div class="bars">${rows.map(r => html`<div class="bar-row">
    <span class="bar-label" title=${r.label}>${r.label}</span>
    <span class="bar-track"><span class=${cls('bar-fill', r.value < 0 && 'neg')} style=${`width:${Math.max(1.5, Math.abs(r.value) / max * 100)}%;background:${r.color}`}></span></span>
    <span class=${cls('bar-value num', r.value > 0 ? 'pos' : r.value < 0 ? 'neg' : '')}>${signed(r.value)}</span>
  </div>`)}</div>`;
}

// One scenario: where the net-worth change over `years` came from.
export function Breakdown({ run, years }) {
  const { byKind, items } = summarize(run, years);
  const rows = KIND_ORDER.filter(k => Math.abs(byKind[k]) >= 1).map(k => ({ label: KIND_META[k].label, value: byKind[k], color: KIND_META[k].color }));
  const max = Math.max(1, ...rows.map(r => Math.abs(r.value)));
  const spending = items.filter(b => b.kind === 'spending').sort((a, b) => a.total - b.total).slice(0, 6);
  const growth = items.filter(b => b.kind === 'growth' && Math.abs(b.total) >= 1).sort((a, b) => b.total - a.total);
  const net = Object.values(byKind).reduce((s, v) => s + v, 0);
  return html`<div class="card-pad">
    <${Bars} rows=${rows} max=${max} />
    <div class="bar-total"><span>Change in net worth</span><b class=${cls('num', net >= 0 ? 'pos' : 'neg')}>${signed(net)}</b></div>
    <div class="grid-2" style="margin-top:14px">
      <div><div class="section-label">Biggest spending</div>${spending.map(b => html`<div class="mini-row"><span>${b.label}</span><span class="num">${compact(-b.total)}</span></div>`)}</div>
      <div><div class="section-label">Growth by asset type</div>${growth.map(b => html`<div class="mini-row"><span>${b.label}</span><span class=${cls('num', b.total < 0 && 'neg')}>${signed(b.total)}</span></div>`)}</div>
    </div>
  </div>`;
}

// Difference in each bucket between a challenger and the reference, largest first.
export function drivers(refRun, run, years, limit = 8) {
  const a = attributionUpTo(refRun, years);
  const b = attributionUpTo(run, years);
  const keys = new Set([...a.keys(), ...b.keys()]);
  const list = [...keys].map(k => {
    const x = b.get(k) || a.get(k);
    return { key: k, kind: x.kind, label: x.label, value: (b.get(k)?.total || 0) - (a.get(k)?.total || 0) };
  }).filter(d => Math.abs(d.value) >= 1).sort((p, q) => Math.abs(q.value) - Math.abs(p.value));
  const top = list.slice(0, limit);
  const rest = list.slice(limit).reduce((s, d) => s + d.value, 0);
  if (Math.abs(rest) >= 1) top.push({ key: 'rest', kind: 'other', label: `${list.length - limit} smaller differences`, value: rest });
  return top;
}

export function DriversView({ refRun, run, years, refName, name, start }) {
  const list = drivers(refRun, run, years);
  if (!list.length) return html`<div class="card-pad small muted">No differences in this period.</div>`;
  const max = Math.max(1, ...list.map(d => Math.abs(d.value)));
  const total = list.reduce((s, d) => s + d.value, 0);
  return html`<div class="card-pad">
    <p class="small muted" style="margin:0 0 10px">How ${name} differs from ${refName} over the first ${start ? durationLabel(years, start) : `${years} years`} — positive bars help ${name}.</p>
    <${Bars} rows=${list.map(d => ({ label: `${d.label}`, value: d.value, color: KIND_META[d.kind]?.color || '#64748b' }))} max=${max} />
    <div class="bar-total"><span>Net difference in net worth</span><b class=${cls('num', total >= 0 ? 'pos' : 'neg')}>${signed(total)}</b></div>
  </div>`;
}
