// App state: one plan document, undo/redo, and local autosave.
// Components subscribe with useStore(); every edit goes through update(fn) so it can be undone.

import { useEffect, useState } from 'preact/hooks';
import { normalizePlan, clone } from './engine/model.js';
import { demoPlan } from './demo.js';

const KEY = 'paths.plan.v1';
const UI_KEY = 'paths.ui.v1';
const MAX_HISTORY = 100;

const listeners = new Set();
let plan = load();
let past = [];
let future = [];
let saveTimer = null;
let saveState = { status: 'saved', at: Date.now(), error: null };

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return normalizePlan(JSON.parse(raw));
  } catch (e) {
    console.warn('Could not read saved plan', e);
  }
  return normalizePlan(demoPlan());
}

function emit() {
  for (const fn of listeners) fn();
}

function scheduleSave() {
  saveState = { ...saveState, status: 'saving' };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(plan));
      saveState = { status: 'saved', at: Date.now(), error: null };
    } catch (e) {
      saveState = { status: 'error', at: Date.now(), error: e.message || String(e) };
    }
    emit();
  }, 400);
}

export const store = {
  get plan() { return plan; },
  get saveState() { return saveState; },
  canUndo: () => past.length > 0,
  canRedo: () => future.length > 0,

  // fn receives a mutable draft copy of the plan; return nothing.
  update(fn, opts = {}) {
    const draft = clone(plan);
    fn(draft);
    draft.updatedAt = new Date().toISOString();
    if (!opts.skipHistory) {
      past.push(plan);
      if (past.length > MAX_HISTORY) past.shift();
      future = [];
    }
    plan = normalizePlan(draft);
    scheduleSave();
    emit();
  },

  replace(next, opts = {}) {
    if (!opts.skipHistory) { past.push(plan); future = []; }
    plan = normalizePlan(next);
    scheduleSave();
    emit();
  },

  undo() {
    if (!past.length) return;
    future.push(plan);
    plan = past.pop();
    scheduleSave();
    emit();
  },

  redo() {
    if (!future.length) return;
    past.push(plan);
    plan = future.pop();
    scheduleSave();
    emit();
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }
};

export function useStore() {
  const [, setTick] = useState(0);
  useEffect(() => store.subscribe(() => setTick(t => t + 1)), []);
  return store;
}

// Small persisted UI preferences (selected scenario, chart lens, ranges...).
let ui = (() => {
  try { return JSON.parse(localStorage.getItem(UI_KEY) || '{}'); } catch { return {}; }
})();
const uiListeners = new Set();
export function useUI(key, initial) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick(t => t + 1);
    uiListeners.add(fn);
    return () => uiListeners.delete(fn);
  }, []);
  const value = key in ui ? ui[key] : initial;
  const set = v => {
    ui = { ...ui, [key]: typeof v === 'function' ? v(value) : v };
    try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* ignore */ }
    for (const fn of uiListeners) fn();
  };
  return [value, set];
}

// Set several UI preferences at once (e.g. folded groups and chart lines from an import).
export function setUIValues(values) {
  ui = { ...ui, ...values };
  try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch { /* ignore */ }
  for (const fn of uiListeners) fn();
}

export function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
