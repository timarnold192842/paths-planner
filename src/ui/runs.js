// Memoized scenario runs, keyed by the simulation-relevant content of the plan. Cosmetic edits
// (names, colors, notes, saved comparisons) don't trigger re-simulation; anything else does.
import { runScenario, stressTest } from '../engine/metrics.js';

const keyOf = new WeakMap();
const cache = new Map();
const MAX_ENTRIES = 60;

function simKey(plan) {
  let k = keyOf.get(plan);
  if (!k) {
    const { name, updatedAt, comparisons, groups, ...rest } = plan;
    rest.scenarios = plan.scenarios.map(({ name: n, color, notes, createdAt, updatedAt: u, ...s }) => s);
    k = JSON.stringify(rest);
    keyOf.set(plan, k);
    void name; void updatedAt; void comparisons; void groups;
  }
  return k;
}

function memo(plan, key, compute) {
  const full = `${key}\u0000${simKey(plan)}`;
  if (cache.has(full)) {
    const v = cache.get(full);
    cache.delete(full);
    cache.set(full, v);
    return v;
  }
  const v = compute();
  cache.set(full, v);
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return v;
}

export function getRun(plan, scenarioId, opts = {}) {
  return memo(plan, `run:${scenarioId}:${JSON.stringify(opts)}`, () => runScenario(plan, scenarioId, opts));
}

export function getStress(plan, scenarioIds, assumptionId, refId, lensId) {
  return memo(plan, `stress:${scenarioIds.join(',')}:${assumptionId}:${refId}:${lensId}`, () => stressTest(plan, scenarioIds, assumptionId, refId, lensId));
}

export function scenarioName(plan, id) {
  return plan.scenarios.find(s => s.id === id)?.name || 'Unknown scenario';
}

export function scenarioColor(plan, id) {
  return plan.scenarios.find(s => s.id === id)?.color || '#64748b';
}
