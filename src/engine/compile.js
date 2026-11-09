// Scenario compilation: plan + scenario -> one concrete plan the simulator can run,
// plus diagnostics (conflicts, stale references). Scenarios never copy the plan; they only
// store choices, so plan edits apply to every scenario automatically.

import { clone, getPath, setPath, COLLECTIONS } from './model.js';

export function scenarioChain(plan, scenarioId, diagnostics = []) {
  const chain = [];
  const seen = new Set();
  let s = plan.scenarios.find(x => x.id === scenarioId);
  while (s) {
    if (seen.has(s.id)) {
      diagnostics.push({ level: 'error', code: 'cycle', message: `Scenario "${s.name}" inherits from itself (cycle) — inheritance ignored past this point.` });
      break;
    }
    seen.add(s.id);
    chain.unshift(s);
    s = s.basedOn ? plan.scenarios.find(x => x.id === s.basedOn) : null;
  }
  return chain;
}

// Effective choices/cases/patches of a scenario after applying its basedOn chain.
export function effectiveSelections(plan, scenarioId, diagnostics = []) {
  const chain = scenarioChain(plan, scenarioId, diagnostics);
  const choices = {};
  const cases = {};
  const patches = [];
  for (const s of chain) {
    Object.assign(choices, s.choices || {});
    Object.assign(cases, s.cases || {});
    for (const p of s.patches || []) {
      const i = patches.findIndex(x => x.id === p.id && x.field === p.field);
      if (i >= 0) patches.splice(i, 1);
      patches.push(p);
    }
  }
  for (const d of plan.decisions) {
    if (!choices[d.id] || !d.alternatives.some(a => a.id === choices[d.id])) {
      if (choices[d.id]) diagnostics.push({ level: 'warn', code: 'stale-choice', message: `A scenario picks an alternative of "${d.name}" that no longer exists — using the default.` });
      choices[d.id] = d.defaultAlt && d.alternatives.some(a => a.id === d.defaultAlt) ? d.defaultAlt : d.alternatives[0]?.id;
    }
  }
  for (const a of plan.assumptions) {
    if (!cases[a.id] || !a.cases.some(c => c.id === cases[a.id])) {
      cases[a.id] = a.defaultCase && a.cases.some(c => c.id === a.defaultCase) ? a.defaultCase : a.cases[0]?.id;
    }
  }
  return { choices, cases, patches, chain };
}

// `when` = { decisionId: [altId, ...] }. All listed decisions must match (AND); each list is OR.
export function isActive(item, choices) {
  if (!item || item.enabled === false) return false;
  const when = item.when;
  if (!when) return true;
  return Object.entries(when).every(([decId, alts]) => {
    const list = Array.isArray(alts) ? alts : [alts];
    return !list.length || list.includes(choices[decId]);
  });
}

function applyPatches(out, patches, source, owners, diagnostics) {
  for (const p of patches || []) {
    const label = source;
    if (p.id === 'settings') {
      setPath(out.settings, p.field, clone(p.value));
      continue;
    }
    let target = null;
    for (const coll of COLLECTIONS) {
      target = out[coll].find(x => x.id === p.id);
      if (target) break;
    }
    if (!target) {
      diagnostics.push({ level: 'warn', code: 'stale-patch', message: `${label} changes an item that doesn't exist (or is switched off here) — ignored.`, ref: p.id });
      continue;
    }
    const key = `${p.id}::${p.field}`;
    if (owners.has(key) && owners.get(key).source !== source && owners.get(key).kind === 'choice') {
      diagnostics.push({
        level: 'warn',
        code: 'conflict',
        message: `"${owners.get(key).source}" and "${source}" both change ${target.name || target.type}.${p.field}; "${source}" wins.`,
        ref: p.id
      });
    }
    owners.set(key, { source, kind: 'choice' });
    setPath(target, p.field, clone(p.value));
  }
}

// opts.caseOverrides: { assumptionId: caseId } — used by stress tests to vary one assumption.
export function compile(plan, scenarioId, opts = {}) {
  const diagnostics = [];
  const sel = effectiveSelections(plan, scenarioId, diagnostics);
  const cases = { ...sel.cases, ...(opts.caseOverrides || {}) };
  const out = {
    ...plan,
    settings: clone(plan.settings),
    units: clone(plan.units),
    accounts: plan.accounts.filter(x => isActive(x, sel.choices)).map(clone),
    debts: plan.debts.filter(x => isActive(x, sel.choices)).map(clone),
    flows: plan.flows.filter(x => isActive(x, sel.choices)).map(clone),
    events: plan.events.filter(x => isActive(x, sel.choices)).map(clone)
  };
  const owners = new Map();
  for (const d of plan.decisions) {
    const alt = d.alternatives.find(a => a.id === sel.choices[d.id]);
    if (alt) applyPatches(out, alt.patches, `${d.name}: ${alt.name}`, owners, diagnostics);
  }
  for (const a of plan.assumptions) {
    const c = a.cases.find(x => x.id === cases[a.id]);
    if (c) applyPatches(out, c.patches, `${a.name}: ${c.name}`, new Map(), diagnostics);
  }
  if (sel.patches.length) applyPatches(out, sel.patches, 'Scenario tweak', new Map(), diagnostics);

  // Assets activated by a buy event are owned from the purchase date.
  for (const e of out.events) {
    if (e.type !== 'buy') continue;
    const asset = out.accounts.find(a => a.id === e.assetId);
    if (asset) { asset.ownedFrom = e.date; asset.balance = 0; }
    const debt = out.debts.find(x => x.id === e.debtId);
    if (debt) { debt.start = e.date; debt.balance = Number(e.loanAmount) || 0; }
  }
  // Each unit uses the price path of its assumption's selected case.
  for (const u of out.units) {
    u.caseId = u.assumptionId ? cases[u.assumptionId] : null;
  }
  // References to accounts/debts that are not active in this scenario.
  const ids = new Set([...out.accounts.map(a => a.id), ...out.debts.map(d => d.id)]);
  for (const f of out.flows) {
    for (const ref of [...(f.from || []), f.to, f.whileOwned].filter(Boolean)) {
      if (!ids.has(ref)) diagnostics.push({ level: 'warn', code: 'missing-account', message: `"${f.name}" refers to an account or debt that isn't part of this scenario.`, ref: f.id });
    }
  }
  return { plan: out, choices: sel.choices, cases, diagnostics, chain: sel.chain.map(s => s.id) };
}

// Human-readable list of what distinguishes scenario B from scenario A.
export function scenarioDiff(plan, aId, bId) {
  const a = effectiveSelections(plan, aId);
  const b = effectiveSelections(plan, bId);
  const lines = [];
  for (const d of plan.decisions) {
    if (a.choices[d.id] !== b.choices[d.id]) {
      const name = id => d.alternatives.find(x => x.id === id)?.name || '—';
      lines.push({ kind: 'decision', label: d.name, a: name(a.choices[d.id]), b: name(b.choices[d.id]) });
    }
  }
  for (const as of plan.assumptions) {
    if (a.cases[as.id] !== b.cases[as.id]) {
      const name = id => as.cases.find(x => x.id === id)?.name || '—';
      lines.push({ kind: 'assumption', label: as.name, a: name(a.cases[as.id]), b: name(b.cases[as.id]) });
    }
  }
  const key = p => `${p.id}::${p.field}`;
  const am = new Map(a.patches.map(p => [key(p), p]));
  const bm = new Map(b.patches.map(p => [key(p), p]));
  for (const k of new Set([...am.keys(), ...bm.keys()])) {
    const pa = am.get(k);
    const pb = bm.get(k);
    if (JSON.stringify(pa?.value) === JSON.stringify(pb?.value)) continue;
    const p = pa || pb;
    lines.push({ kind: 'tweak', label: `${itemLabel(plan, p.id)} · ${p.field}`, a: pa ? String(pa.value) : '(plan)', b: pb ? String(pb.value) : '(plan)' });
  }
  return lines;
}

function itemLabel(plan, id) {
  if (id === 'settings') return 'Settings';
  for (const coll of COLLECTIONS) {
    const x = plan[coll].find(i => i.id === id);
    if (x) return x.name || x.type;
  }
  return id;
}

export { getPath };
