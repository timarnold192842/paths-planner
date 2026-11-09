// "Add a line" to a chart: autocomplete over accounts, debts and totals; chosen lines show as
// removable chips. Keys: acct:<id>, debt:<id>, kind:<accountKind>, total:<series>.
import { useMemo, useRef, useState } from 'preact/hooks';
import { html, cls } from './h.js';
import { kindInfo } from '../engine/model.js';
import { deflator, LENSES } from '../engine/metrics.js';

const PALETTE = ['#9333ea', '#db2777', '#0891b2', '#ca8a04', '#0d9488', '#7c3aed', '#be123c', '#475569'];
const TOTALS = [
  ['assets', 'Total assets'],
  ['accessible', 'Accessible money', 'cash + brokerage & stock after tax'],
  ['creditAvailable', 'Credit available', 'unused credit lines'],
  ['netWorth', 'Net worth (nominal)'],
  ['afterTax', 'After-tax net worth (nominal)']
];

export function lineOptions(plan) {
  const kinds = new Map();
  for (const a of plan.accounts) kinds.set(a.kind, (kinds.get(a.kind) || 0) + 1);
  return [
    ...plan.accounts.map(a => ({ key: `acct:${a.id}`, label: a.name, sub: kindInfo(a.kind).label })),
    ...plan.debts.map(d => ({ key: `debt:${d.id}`, label: d.name, sub: Number(d.creditLimit) > 0 ? 'Credit line' : 'Loan / debt' })),
    ...[...kinds].filter(([, n]) => n > 1).map(([k]) => ({ key: `kind:${k}`, label: `All ${kindInfo(k).label}`, sub: 'Total by account type' })),
    ...TOTALS.map(([k, l, sub]) => ({ key: `total:${k}`, label: l, sub: sub || 'Plan total' }))
  ];
}

// Chart series for the chosen keys (skips anything this run doesn't have).
export function customSeries(run, plan, keys, lensId) {
  const real = LENSES.find(l => l.id === lensId)?.real;
  const def = real ? deflator(run, plan.settings.inflation) : null;
  const opts = new Map(lineOptions(plan).map(o => [o.key, o]));
  const out = [];
  keys.forEach((key, n) => {
    const [type, id] = key.split(/:(.*)/s);
    let values = null;
    if (type === 'acct') values = run.accounts[id];
    else if (type === 'debt') values = run.debts[id];
    else if (type === 'total') values = run.series[id];
    else if (type === 'kind') {
      const ids = plan.accounts.filter(a => a.kind === id).map(a => a.id).filter(x => run.accounts[x]);
      if (ids.length) {
        values = new Float64Array(run.N);
        for (const x of ids) { const v = run.accounts[x]; for (let i = 0; i < run.N; i++) values[i] += v[i]; }
      }
    }
    if (!values || !opts.has(key)) return;
    if (def && !(type === 'total' && /nominal/i.test(opts.get(key).label))) {
      const v = new Float64Array(run.N);
      for (let i = 0; i < run.N; i++) v[i] = values[i] / def[i];
      values = v;
    }
    out.push({ label: opts.get(key).label, values, color: lineColor(n), width: 1.75, dash: type === 'debt' ? [5, 4] : undefined });
  });
  return out;
}

export const lineColor = n => PALETTE[n % PALETTE.length];

function rank(o, q) {
  const label = o.label.toLowerCase();
  const hay = `${label} ${o.sub.toLowerCase()}`;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.every(w => hay.includes(w))) return -1;
  if (label.startsWith(words[0] || '')) return 3;
  if (label.split(/[\s()/·-]+/).some(w => w.startsWith(words[0] || ''))) return 2;
  return 1;
}

function Highlight({ text, q }) {
  const w = q.trim().split(/\s+/)[0];
  const i = w ? text.toLowerCase().indexOf(w.toLowerCase()) : -1;
  if (i < 0) return text;
  return html`${text.slice(0, i)}<mark>${text.slice(i, i + w.length)}</mark>${text.slice(i + w.length)}`;
}

export function LineChips({ plan, value, onChange }) {
  const opts = useMemo(() => new Map(lineOptions(plan).map(o => [o.key, o])), [plan]);
  const live = value.filter(k => opts.has(k));
  if (!live.length) return null;
  return html`<div class="line-chips">
    ${live.map(k => html`<span class="line-chip" key=${k}>
      <span class="dot" style=${`background:${lineColor(value.indexOf(k))}`}></span>${opts.get(k).label}
      <button type="button" aria-label=${`Remove ${opts.get(k).label} from the chart`} onClick=${() => onChange(value.filter(x => x !== k))}>×</button>
    </span>`)}
    ${live.length > 1 ? html`<button type="button" class="linkish small" onClick=${() => onChange([])}>Clear</button>` : null}
    <span class="small faint">Tip: click a name in the chart legend to hide that line.</span>
  </div>`;
}

export function AddLine({ plan, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef(null);
  const all = useMemo(() => lineOptions(plan), [plan]);
  const matches = all
    .filter(o => !value.includes(o.key))
    .map(o => [o, q ? rank(o, q) : 1])
    .filter(([, r]) => r > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([o]) => o);
  const pick = o => { if (!o) return; onChange([...value, o.key]); setQ(''); setActive(0); input.current?.focus(); };
  const close = () => { setOpen(false); setQ(''); setActive(0); };

  if (!open) return html`<button type="button" class="btn sm add-line" onClick=${() => setOpen(true)}>+ Add line…</button>`;
  return html`<div class="combo">
    <input ref=${el => { if (el && input.current !== el) { input.current = el; el.focus(); } }} type="text" role="combobox" aria-expanded="true" aria-controls="add-line-list" aria-autocomplete="list"
      aria-activedescendant=${matches[active] ? `opt-${active}` : undefined}
      placeholder="Account, loan or total…" value=${q}
      onInput=${e => { setQ(e.target.value); setActive(0); }}
      onBlur=${close}
      onKeyDown=${e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(matches.length - 1, a + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
        else if (e.key === 'Enter') { e.preventDefault(); pick(matches[active]); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'Backspace' && !q && value.length) onChange(value.slice(0, -1));
      }} />
    <ul class="combo-list" id="add-line-list" role="listbox">
      ${matches.length ? matches.map((o, i) => html`<li id=${`opt-${i}`} role="option" aria-selected=${i === active} class=${cls(i === active && 'active')}
          onMouseDown=${e => { e.preventDefault(); pick(o); }} onMouseEnter=${() => setActive(i)}>
          <span class="name"><${Highlight} text=${o.label} q=${q} /></span><span class="sub">${o.sub}</span>
        </li>`) : html`<li class="none">No matches</li>`}
    </ul>
  </div>`;
}
