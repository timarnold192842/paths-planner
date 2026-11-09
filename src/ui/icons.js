// Minimal stroke icons (24×24 grid, drawn for this app).
import { html } from './h.js';

const P = {
  overview: 'M4 19h16M6 15l4-4 3 3 5-6',
  compare: 'M7 7h12m0 0-3-3m3 3-3 3M17 17H5m0 0 3 3m-3-3 3-3',
  scenarios: 'M6 4v6a4 4 0 0 0 4 4h4m-8-4v10M18 14m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M6 4m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  decisions: 'M12 3l9 9-9 9-9-9z',
  plan: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  settings: 'M4 7h10m4 0h2M4 17h2m4 0h10M16 5v4M8 15v4',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3'
};

export function Icon({ name, label }) {
  return html`<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden=${label ? undefined : 'true'} role=${label ? 'img' : undefined} aria-label=${label}><path d=${P[name]} /></svg>`;
}
