import { useEffect, useState } from 'preact/hooks';
import { html, cls } from './h.js';

let toasts = [];
const subs = new Set();
let n = 0;

export function toast(message, kind = '', ms = 4200) {
  const id = ++n;
  toasts = [...toasts, { id, message, kind }];
  subs.forEach(f => f());
  setTimeout(() => { toasts = toasts.filter(t => t.id !== id); subs.forEach(f => f()); }, ms);
}

export function Toasts() {
  const [, set] = useState(0);
  useEffect(() => { const f = () => set(x => x + 1); subs.add(f); return () => subs.delete(f); }, []);
  return html`<div class="toasts" role="status" aria-live="polite">${toasts.map(t => html`<div key=${t.id} class=${cls('toast', t.kind)}>${t.message}</div>`)}</div>`;
}
