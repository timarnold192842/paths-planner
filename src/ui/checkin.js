// Check-in: refresh balances to actuals, re-baseline the plan to today, and keep a record of
// how reality compared with what the plan expected.
import { useMemo, useState } from 'preact/hooks';
import { html, money, compact, signed, cls } from './h.js';
import { store } from '../store.js';
import { getRun } from './runs.js';
import { todayYMD, parseYMD, formatDate, yearsBetween } from '../engine/dates.js';
import { kindInfo } from '../engine/model.js';
import { rebaseline } from '../engine/rebaseline.js';
import { effectiveSelections, isActive } from '../engine/compile.js';
import { navigate } from './nav.js';
import { toast } from './toast.js';

export function CheckIn() {
  const plan = store.plan;
  const today = todayYMD();
  const refId = plan.scenarios[0]?.id;
  const r = getRun(plan, refId);
  const i = Math.max(0, Math.min(r.run.N - 1, Math.round((parseYMD(today) - parseYMD(plan.asOf)) / 86400000)));
  const compiled = r.compiled.plan;

  // What the plan expects each balance to be today (native units for share accounts).
  const expected = useMemo(() => {
    const out = {};
    for (const a of compiled.accounts) {
      const usd = r.run.accounts[a.id]?.[i] ?? 0;
      const price = a.unitId ? (r.run.units[a.unitId]?.[i] || 1) : 1;
      out[a.id] = usd / price;
    }
    for (const d of compiled.debts) out[d.id] = r.run.debts[d.id]?.[i] ?? 0;
    for (const u of compiled.units) out[u.id] = r.run.units[u.id]?.[i] ?? u.price;
    return out;
  }, [r, i]);

  const [actual, setActual] = useState({});
  const [shift, setShift] = useState(true);
  const val = id => (actual[id] ?? Math.round((expected[id] ?? 0) * 100) / 100);
  const choices = effectiveSelections(plan, refId).choices;
  const inGap = d => !!d && d > plan.asOf && d <= today;
  const passed = plan.events.filter(e => e.enabled !== false && inGap(e.date) && isActive(e, choices, true));
  const scenarioOnly = [...plan.debts.filter(d => inGap(d.start)), ...plan.events.filter(e => inGap(e.date))].filter(x => !isActive(x, choices, true));
  const days = Math.round((parseYMD(today) - parseYMD(plan.asOf)) / 86400000);

  const plannedNW = r.run.series.netWorth[i];
  const actualNW = useMemo(() => {
    let A = 0;
    let L = 0;
    for (const a of compiled.accounts) {
      const price = a.unitId ? (actual[a.unitId] ?? expected[a.unitId] ?? 1) : 1;
      A += (actual[a.id] ?? expected[a.id] ?? 0) * price;
    }
    for (const d of compiled.debts) L += actual[d.id] ?? expected[d.id] ?? 0;
    return A - L;
  }, [actual, expected]);

  const apply = () => {
    const balances = {};
    const prices = {};
    for (const a of compiled.accounts) if (!(a.ownedFrom && a.ownedFrom > today)) balances[a.id] = val(a.id);
    for (const d of compiled.debts) if (!(d.start && d.start > today)) balances[d.id] = val(d.id);
    for (const u of compiled.units) prices[u.id] = val(u.id);
    const res = rebaseline(plan, { balances, prices }, today, { shiftScenarioOnly: shift, referenceId: refId, plannedNetWorth: plannedNW, actualNetWorth: actualNW });
    store.replace(res.plan);
    toast(`Balances updated. You're ${signed(actualNW - plannedNW)} vs. what the plan expected.${res.shifted.length ? ` Moved ${res.shifted.length} scenario-only item(s) to tomorrow.` : ''}`, 'ok', 7000);
    navigate('overview');
  };

  const row = (id, name, sub, isDebt, unit) => {
    const exp = expected[id] ?? 0;
    const v = val(id);
    const diff = v - exp;
    return html`<tr key=${id}>
      <td>${name}<div class="small faint">${sub}</div></td>
      <td>${unit ? `${round(exp)} ${unit}` : money(exp)}</td>
      <td style="width:170px"><input type="number" step="any" value=${v} onInput=${e => setActual(a => ({ ...a, [id]: e.target.value === '' ? 0 : Number(e.target.value) }))} aria-label=${`Actual ${name}`} /></td>
      <td class=${cls(Math.abs(diff) > 0.5 && ((diff > 0) !== isDebt ? 'pos' : 'neg'))}>${Math.abs(diff) > 0.5 ? (unit ? `${diff > 0 ? '+' : ''}${round(diff)}` : signed(diff, money)) : '—'}</td>
    </tr>`;
  };

  return html`<div class="stack">
    <div class="page-head">
      <div>
        <h2>Check in</h2>
        <p>Enter today's real balances. Paths re-baselines the plan to today and keeps a record of how you're tracking against what it expected. Last updated ${formatDate(plan.asOf)}${days > 0 ? ` (${days} days ago)` : ''}.</p>
      </div>
      <div class="row"><button class="btn" onClick=${() => navigate('overview')}>Cancel</button><button class="btn primary" onClick=${apply}>Update to today</button></div>
    </div>
    <div class="kpis">
      <div class="card kpi"><div class="label">Plan expected today</div><div class="value">${compact(plannedNW)}</div><div class="sub">Net worth · ${plan.scenarios[0]?.name}</div></div>
      <div class="card kpi"><div class="label">Your actual balances</div><div class="value">${compact(actualNW)}</div></div>
      <div class="card kpi"><div class="label">Difference</div><div class=${cls('value', actualNW - plannedNW >= 0 ? 'pos' : 'neg')}>${signed(actualNW - plannedNW)}</div><div class="sub">${days > 30 ? `≈ ${signed((actualNW - plannedNW) / Math.max(1, yearsBetween(parseYMD(plan.asOf), parseYMD(today)) * 12))}/month` : ''}</div></div>
    </div>
    ${passed.length ? html`<div class="notice"><span>⚠</span><div>These events in your plan were due between your last update and today, so they won't run again. Make sure today's balances reflect them: ${passed.map(e => `${e.name || e.type} (${formatDate(e.date)})`).join(', ')}.</div></div>` : null}
    ${scenarioOnly.length ? html`<div class="notice info"><span>↻</span><div>
      These alternatives were dated between your last update and today but aren't part of ${plan.scenarios[0]?.name}: ${scenarioOnly.map(x => `${x.name || x.type} (${formatDate(x.start || x.date)})`).join(', ')}.
      <label class="check" style="margin-top:6px"><input type="checkbox" checked=${shift} onChange=${e => setShift(e.target.checked)} /> Move them to tomorrow so comparing them still means "do it now"</label>
    </div></div>` : null}
    <div class="card"><div class="scroll-x"><table class="tbl">
      <thead><tr><th>Account</th><th>Plan expected</th><th>Actual today</th><th>Difference</th></tr></thead>
      <tbody>
        <tr class="sec"><td colspan="4">Accounts</td></tr>
        ${compiled.accounts.filter(a => !(a.ownedFrom && a.ownedFrom > today)).map(a => {
          const unit = compiled.units.find(u => u.id === a.unitId);
          return row(a.id, a.name, kindInfo(a.kind).label, false, unit?.symbol);
        })}
        ${compiled.debts.filter(d => !(d.start && d.start > today)).length ? html`<tr class="sec"><td colspan="4">Debts</td></tr>` : null}
        ${compiled.debts.filter(d => !(d.start && d.start > today)).map(d => row(d.id, d.name, `${d.rate || 0}%`, true))}
        ${compiled.units.length ? html`<tr class="sec"><td colspan="4">Prices</td></tr>` : null}
        ${compiled.units.map(u => row(u.id, `${u.name} price`, 'per share', false))}
      </tbody>
    </table></div></div>
    ${(plan.history || []).length ? html`<div class="card">
      <div class="card-head"><h3>Past check-ins</h3></div>
      <div class="scroll-x"><table class="tbl">
        <thead><tr><th>Date</th><th>Plan expected</th><th>Actual</th><th>Difference</th></tr></thead>
        <tbody>${[...plan.history].reverse().map(h => html`<tr><td>${formatDate(h.date)}</td><td>${compact(h.plannedNetWorth)}</td><td>${compact(h.netWorth)}</td><td class=${h.netWorth - h.plannedNetWorth >= 0 ? 'pos' : 'neg'}>${signed(h.netWorth - h.plannedNetWorth)}</td></tr>`)}</tbody>
      </table></div>
    </div>` : null}
  </div>`;
}

function round(n) {
  return Math.round(n * 100) / 100;
}
