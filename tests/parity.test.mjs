// Parity with the old Forecast engine, using the old app's embedded plan.
// Skipped when ../budget-pages isn't present (the plan data never lives in this repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyAvailable, legacyEmbedded, runLegacy } from './legacy-harness.mjs';
import { importLegacy } from '../src/engine/legacy.js';
import { runScenario } from '../src/engine/metrics.js';

const asOf = '2026-10-27';
const skip = legacyAvailable ? false : 'old Forecast app not found next to this repo';

test('new engine matches the old engine within 0.05% over 30 years once known old-app quirks are neutralized', { skip }, () => {
  const data = legacyEmbedded();
  // Known, intentional differences (see docs/DESIGN.md "Import notes"):
  data.fees = []; // fee % applied to sale price (new) vs to equity after the mortgage (old)
  const names = new Set(data.accounts.map(a => a.name));
  for (const l of data.loans) if (names.has(l.name)) l.name += ' (loan)'; // old app double-credits payments when names collide
  for (const t of data.transactions) { delete t.split_amount; delete t.split_month; } // old split amount reset every January
  const old = runLegacy(data, asOf);
  const { plan } = importLegacy(data, { asOf });
  plan.settings.tax.enabled = false;
  const r = runScenario(plan, 'baseline');
  assert.equal(r.run.N, old.nw.length);
  for (let i = 0; i < old.nw.length; i += 7) {
    const rel = Math.abs(r.run.series.netWorth[i] - old.nw[i]) / Math.abs(old.nw[i]);
    assert.ok(rel < 0.0005, `${old.dates[i]}: new ${r.run.series.netWorth[i].toFixed(0)} vs old ${old.nw[i].toFixed(0)}`);
  }
});

test('importing fixes the old double-count of mortgage payments into same-named properties', { skip }, () => {
  const data = legacyEmbedded();
  data.fees = [];
  const old = runLegacy(data, asOf);
  const { plan, report } = importLegacy(data, { asOf });
  plan.settings.tax.enabled = false;
  const r = runScenario(plan, 'baseline');
  // The property whose same-named mortgage has the largest payment.
  const collided = data.loans.filter(l => data.accounts.some(a => a.name === l.name) && l.isEnabled !== false && Number(l.monthly_payment) > 0);
  const loan = collided.sort((a, b) => b.monthly_payment - a.monthly_payment)[0];
  assert.ok(loan, 'fixture has a property and a debt with the same name');
  const home = plan.accounts.find(a => a.name === loan.name);
  const i = Math.round(365.25);
  // The old value includes about a year of mortgage payments credited to the house.
  const inflated = old.accounts[loan.name][i] - r.run.accounts[home.id][i];
  const yearOfPayments = loan.monthly_payment * 12;
  assert.ok(inflated > yearOfPayments * 0.85 && inflated < yearOfPayments * 1.15, `old app inflated the property by ${inflated.toFixed(0)} in a year (payments ≈ ${yearOfPayments})`);
  assert.ok(report.some(x => /both an account and a debt/.test(x.message)));
  // The imported sale date became a decision with a ready-made comparison.
  assert.equal(plan.decisions.length, 1);
  assert.equal(plan.scenarios.length, 2);
  assert.equal(plan.comparisons.length, 1);
});
