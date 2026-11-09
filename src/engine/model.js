// Plan schema, defaults, and small helpers. A plan is one JSON document:
// everything (accounts, debts, flows, events, decisions, assumptions, scenarios,
// comparisons) lives here exactly once and is referenced by id.

import { todayYMD } from './dates.js';

export const SCHEMA = 'paths/1';

export const ACCOUNT_KINDS = [
  { id: 'cash', label: 'Cash / checking', liquid: true, withdrawable: true },
  { id: 'brokerage', label: 'Brokerage (taxable)', liquid: true, withdrawable: true },
  { id: 'equity', label: 'Company stock / units', liquid: true, withdrawable: true },
  { id: 'traditional', label: '401(k) / Traditional IRA', liquid: false, withdrawable: true },
  { id: 'roth', label: 'Roth IRA / Roth 401(k)', liquid: false, withdrawable: true },
  { id: 'hsa', label: 'HSA', liquid: false, withdrawable: true },
  { id: 'education', label: '529 / education', liquid: false, withdrawable: true },
  { id: 'property', label: 'Real estate', liquid: false, withdrawable: false },
  { id: 'other', label: 'Other asset', liquid: false, withdrawable: false }
];

export const kindInfo = kind => ACCOUNT_KINDS.find(k => k.id === kind) || ACCOUNT_KINDS[ACCOUNT_KINDS.length - 1];

export const COLLECTIONS = ['accounts', 'debts', 'flows', 'events', 'units'];

export const SCENARIO_COLORS = ['#2563eb', '#ea580c', '#16a34a', '#9333ea', '#db2777', '#0891b2', '#ca8a04', '#475569'];

let idCounter = 0;
export function newId(prefix = 'id') {
  idCounter = (idCounter + 1) % 1296;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 6)}`;
}

export function defaultSettings() {
  return {
    primaryCashId: null,
    cashFloor: 25000,
    inflation: 2.5,
    negligiblePct: 2,
    tax: {
      enabled: true,
      ordinary: 24,
      ltcg: 15,
      state: 3.07,
      birthDate: '',
      residenceExclusion: 250000,
      propertySellingCostPct: 6
    }
  };
}

export function emptyPlan(name = 'My plan') {
  return {
    schema: SCHEMA,
    id: newId('plan'),
    name,
    asOf: todayYMD(),
    horizonYears: 30,
    settings: defaultSettings(),
    groups: [],
    units: [],
    accounts: [],
    debts: [],
    flows: [],
    events: [],
    decisions: [],
    assumptions: [],
    scenarios: [{ id: 'baseline', name: 'Baseline', color: SCENARIO_COLORS[0], choices: {}, cases: {}, patches: [], notes: 'Default choice for every decision.' }],
    comparisons: [],
    updatedAt: new Date().toISOString()
  };
}

// Fill in anything missing so older or hand-edited documents still load.
export function normalizePlan(raw) {
  const p = { ...emptyPlan(raw?.name || 'My plan'), ...(raw || {}) };
  p.schema = SCHEMA;
  p.settings = { ...defaultSettings(), ...(raw?.settings || {}) };
  p.settings.tax = { ...defaultSettings().tax, ...(raw?.settings?.tax || {}) };
  for (const k of ['groups', 'units', 'accounts', 'debts', 'flows', 'events', 'decisions', 'assumptions', 'scenarios', 'comparisons']) {
    if (!Array.isArray(p[k])) p[k] = [];
  }
  p.accounts = p.accounts.map(a => ({ kind: 'cash', balance: 0, growth: 0, tags: [], ...a }));
  p.debts = p.debts.map(d => ({ balance: 0, rate: 0, payment: 0, paymentDay: 1, payFrom: [], ...d }));
  p.flows = p.flows.map(f => ({ enabled: true, growth: 0, steps: [], from: [], to: null, ...f, from: Array.isArray(f.from) ? f.from : (f.from ? [f.from] : []) }));
  p.events = p.events.map(e => ({ enabled: true, ...e }));
  p.units = p.units.map(u => ({ growth: 0, paths: {}, ...u }));
  p.decisions = p.decisions.map(d => ({ alternatives: [], ...d, alternatives: (d.alternatives || []).map(a => ({ patches: [], ...a })) }));
  p.assumptions = p.assumptions.map(a => ({ cases: [], ...a, cases: (a.cases || []).map(c => ({ patches: [], ...c })) }));
  if (!p.scenarios.length) p.scenarios = emptyPlan().scenarios;
  p.scenarios = p.scenarios.map((s, i) => ({ choices: {}, cases: {}, patches: [], color: SCENARIO_COLORS[i % SCENARIO_COLORS.length], ...s }));
  if (!p.settings.primaryCashId || !p.accounts.some(a => a.id === p.settings.primaryCashId)) {
    p.settings.primaryCashId = (p.accounts.find(a => a.kind === 'cash') || p.accounts[0] || {}).id || null;
  }
  return p;
}

export function findItem(plan, id) {
  for (const coll of COLLECTIONS) {
    const item = (plan[coll] || []).find(x => x.id === id);
    if (item) return { coll, item };
  }
  return null;
}

export function itemName(plan, id) {
  const hit = findItem(plan, id);
  return hit ? hit.item.name || hit.item.type || id : id;
}

// Read/write "a.b.c" paths on plain objects.
export function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

export const clone = v => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));
