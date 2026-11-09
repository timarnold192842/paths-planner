import { h } from 'preact';
import htm from 'htm';

export const html = htm.bind(h);

// ---------- formatting ----------
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2, minimumFractionDigits: 2 });

export function money(n, cents = false) {
  if (n == null || !Number.isFinite(n)) return '—';
  const v = Math.abs(n) < 0.5 && !cents ? 0 : n;
  return (cents ? usd2 : usd0).format(v);
}

export function compact(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${sign}$${Math.round(a / 1e3)}k`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}k`;
  return `${sign}$${Math.round(a)}`;
}

export function signed(n, fmt = compact) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) < 0.5) return fmt(0);
  return `${n > 0 ? '+' : '−'}${fmt(Math.abs(n)).replace(/^−/, '')}`;
}

export const pct = (n, digits = 1) => (n == null || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(digits)}%`);

export function tone(n, eps = 0.5) {
  if (!Number.isFinite(n) || Math.abs(n) < eps) return '';
  return n > 0 ? 'pos' : 'neg';
}

export const cls = (...xs) => xs.filter(Boolean).join(' ');
