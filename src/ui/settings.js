import { useState } from 'preact/hooks';
import { html } from './h.js';
import { store, downloadJSON, setUIValues } from '../store.js';
import { normalizePlan, SCHEMA } from '../engine/model.js';
import { importLegacy, isLegacyForecast } from '../engine/legacy.js';
import { demoPlan } from '../demo.js';
import { todayYMD } from '../engine/dates.js';
import { Field, Num, Text, DateIn, Select, Waterfall, accountOptions } from './editors.js';
import { toast } from './toast.js';
import { FILING } from '../engine/payroll.js';
import { navigate } from './nav.js';

export function Settings() {
  const plan = store.plan;
  const s = plan.settings;
  const [report, setReport] = useState(null);
  const set = (path, v) => store.update(p => {
    const keys = path.split('.');
    let o = p;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys[keys.length - 1]] = v;
  });

  const onFile = async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    let json;
    try { json = JSON.parse(await file.text()); } catch { toast('That file is not valid JSON.', 'err'); return; }
    if (json?.schema === SCHEMA) {
      if (!confirm(`Replace the current plan with "${json.name || file.name}"? You can undo this.`)) return;
      store.replace(normalizePlan(json));
      setReport(null);
      toast('Plan restored.', 'ok');
    } else if (isLegacyForecast(json)) {
      const { plan: imported, report: rep, ui } = importLegacy(json, { name: file.name.replace(/\.json$/i, ''), asOf: todayYMD() });
      if (!confirm(`Import "${file.name}" from the old Forecast app? This replaces the current plan (you can undo).`)) return;
      store.replace(imported);
      if (ui) setUIValues(ui);
      setReport(rep);
      toast(`Imported ${imported.accounts.length} accounts, ${imported.debts.length} debts and ${imported.flows.length} cash flows.`, 'ok', 6000);
    } else {
      toast("This file isn't a Paths plan or a Forecast export.", 'err');
    }
  };

  return html`<div class="stack">
    <div class="page-head"><div><h2>Settings & data</h2><p>Assumptions that apply everywhere, back-of-the-envelope taxes, and your data.</p></div></div>

    ${report ? html`<div class="card">
      <div class="card-head"><h3>Import notes</h3><button class="btn sm ghost" onClick=${() => setReport(null)}>Dismiss</button></div>
      <div class="card-pad stack" style="gap:14px">
        ${[['change', 'Upgraded to Paths features'], ['warn', 'Please check'], ['info', 'Good to know'], ['absent', 'Not carried over']].map(([lvl, title]) => {
          const items = report.filter(r => (r.level || 'info') === lvl);
          return items.length ? html`<div><div class="section-label">${title}</div><div class="stack" style="gap:8px">${items.map(r => html`<div class=${lvl === 'warn' ? 'notice' : 'notice info'}>${r.message}</div>`)}</div></div>` : null;
        })}
      </div>
    </div>` : null}

    <div class="card">
      <div class="card-head"><h3>Plan</h3></div>
      <div class="card-pad form-grid">
        <${Field} label="Plan name"><${Text} value=${plan.name} onInput=${v => set('name', v)} /><//>
        <${Field} label="Balances as of" hint="Update this when you refresh balances"><${DateIn} value=${plan.asOf} onInput=${v => v && set('asOf', v)} /><//>
        <${Field} label="Horizon (years)"><${Num} value=${plan.horizonYears} min="1" step="1" onInput=${v => v && set('horizonYears', Math.min(60, Math.max(1, Math.round(v))))} /><//>
        <${Field} label="Primary cash account" hint="Pays anything not covered by a funding order; the only account allowed to go negative"><${Select} value=${s.primaryCashId} onChange=${v => set('settings.primaryCashId', v)} options=${accountOptions(plan)} /><//>
        <${Field} label="Cash safety floor ($)" hint="Warn when operating cash drops below this"><${Num} value=${s.cashFloor} onInput=${v => set('settings.cashFloor', v ?? 0)} /><//>
        <${Field} label="Inflation (%/yr)" hint="For today's-dollars views"><${Num} value=${s.inflation} onInput=${v => set('settings.inflation', v ?? 0)} /><//>
        <${Field} label="'Negligible' difference (%)" hint="Comparisons within this % of end wealth are called negligible"><${Num} value=${s.negligiblePct} onInput=${v => set('settings.negligiblePct', v ?? 0)} /><//>
        <${Field} label="Safety net" wide hint="If cash would go negative, draw from these credit lines first (mark a debt as a credit line by giving it a limit).">
          <${Waterfall} plan=${{ ...plan, accounts: [] }} value=${s.safetyNet || []} fallbackNote=${false} placeholder=${plan.debts.some(d => Number(d.creditLimit) > 0) ? '+ Add a credit line…' : 'No credit lines yet'} onChange=${v => set('settings.safetyNet', v)} />
        <//>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Taxes (back of the envelope)</h3><label class="check"><input type="checkbox" checked=${s.tax.enabled} onChange=${e => set('settings.tax.enabled', e.target.checked)} /> Estimate taxes</label></div>
      <div class="card-pad form-grid">
        <${Field} label="Filing status" hint="Paychecks are taxed with the 2026 federal brackets and standard deduction"><${Select} value=${s.tax.filing || 'mfj'} onChange=${v => set('settings.tax.filing', v || 'mfj')} options=${FILING.map(f => ({ value: f.id, label: f.label }))} /><//>
        <${Field} label="Ordinary income rate (%)" hint="Federal marginal rate for withdrawals and other taxed income (the Overview's “Paychecks & taxes” shows your bracket)"><${Num} value=${s.tax.ordinary} onInput=${v => set('settings.tax.ordinary', v ?? 0)} /><//>
        <${Field} label="Long-term capital gains (%)"><${Num} value=${s.tax.ltcg} onInput=${v => set('settings.tax.ltcg', v ?? 0)} /><//>
        <${Field} label="State income tax (%)" hint="Added to both rates"><${Num} value=${s.tax.state} onInput=${v => set('settings.tax.state', v ?? 0)} /><//>
        <${Field} label="Your birth date" hint="Early-withdrawal penalties before 59½ (65 for HSA)"><${DateIn} value=${s.tax.birthDate} onInput=${v => set('settings.tax.birthDate', v || '')} /><//>
        <${Field} label="Home-sale gain exclusion ($)" hint="$250k single, $500k married"><${Num} value=${s.tax.residenceExclusion} onInput=${v => set('settings.tax.residenceExclusion', v ?? 0)} /><//>
        <${Field} label="Selling costs for after-tax value (%)" hint="Used to value property 'as if sold'"><${Num} value=${s.tax.propertySellingCostPct} onInput=${v => set('settings.tax.propertySellingCostPct', v ?? 0)} /><//>
      </div>
      <div class="card-pad" style="padding-top:0">
        <details class="more"><summary>How taxes are estimated</summary>
          <ul class="small muted" style="margin:0;padding-left:18px;line-height:1.6">
            <li><b>401(k) / Traditional IRA</b> withdrawals: ordinary + state rate, plus 10% before 59½. Withdrawals are grossed up so the bill you're paying is fully covered.</li>
            <li><b>Brokerage & company stock</b>: capital-gains rate on the gain over average cost basis.</li>
            <li><b>529</b>: tax-free for expenses marked "qualified: education"; otherwise ordinary + 10% on earnings. <b>HSA</b>: tax-free for "qualified: medical"; otherwise ordinary + 20% before 65. <b>Roth</b>: tax-free.</li>
            <li><b>Property sales</b>: capital-gains tax on price − selling costs − cost basis (− exclusion for your primary home).</li>
            <li><b>Paychecks</b> (income marked “This is a paycheck”): gross pay minus Social Security (6.2% until the year's wages from that employer reach the wage base — $184,500 in 2026), Medicare (1.45%, plus 0.9% over $200k), your federal and state withholding %, and payroll deductions (401(k), HSA, insurance…; capped ones stop at their annual limit). These reset every January, so take-home pay steps up late in the year.</li>
            <li><b>April true-up</b>: each year's wages are taxed with the federal brackets and standard deduction for your filing status, plus your state rate, and compared with what was withheld. The difference is a refund into, or a payment out of, primary cash on April 15.</li>
            <li><b>Stock vests</b> marked as paychecks have their taxes withheld in shares (sell-to-cover); vested shares get the vest-day price as cost basis. Other income can be marked as taxed at your ordinary rate (e.g. rent).</li>
            <li>Dollar thresholds are 2026 figures, indexed with inflation in later years.</li>
            <li><b>After-tax net worth</b> = what you'd keep if everything were sold that day. Not modeled: credits, itemized deductions, RMDs, depreciation recapture, AMT, NIIT.</li>
          </ul>
        </details>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Data</h3></div>
      <div class="card-pad stack" style="gap:12px">
        <p class="small muted" style="margin:0">Your plan is saved automatically in this browser. Export a backup to move it to another device. Syncing across devices through a server is planned next.</p>
        <div class="row">
          <button class="btn" onClick=${() => downloadJSON(plan, `paths-${plan.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${todayYMD()}.json`)}>Export backup (JSON)</button>
          <label class="btn">Import… <input type="file" accept=".json,application/json" class="sr-only" onChange=${onFile} /></label>
        </div>
        <p class="small muted" style="margin:0">Import accepts a Paths backup or an export from the old <b>Forecast</b> app (accounts, loans, transactions, stock price targets, fees, groups, sale dates).</p>
        <div class="row">
          <button class="btn ghost" onClick=${() => { if (confirm('Replace your plan with the demo household? You can undo.')) { store.replace(demoPlan()); navigate('overview'); } }}>Load demo plan</button>
        </div>
      </div>
    </div>
  </div>`;
}
