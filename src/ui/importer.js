// One import path for files picked in Settings and for ?load=<path> links on a local server.
import { store, setUIValues } from '../store.js';
import { normalizePlan, SCHEMA } from '../engine/model.js';
import { importLegacy, isLegacyForecast } from '../engine/legacy.js';
import { todayYMD } from '../engine/dates.js';
import { toast } from './toast.js';
import { navigate } from './nav.js';

let lastReport = null;
// The notes from the most recent Forecast import (shown once on the Settings page).
export const takeImportReport = () => { const r = lastReport; lastReport = null; return r; };

// Replace the current plan with a Paths plan or an old Forecast export. Returns the import notes
// (or null), or false when nothing was imported.
export function importPlanJSON(json, filename = 'plan.json') {
  if (json?.schema === SCHEMA) {
    if (!confirm(`Replace the current plan with "${json.name || filename}"? You can undo this.`)) return false;
    store.replace(normalizePlan(json));
    toast('Plan restored.', 'ok');
    return null;
  }
  if (isLegacyForecast(json)) {
    const { plan, report, ui } = importLegacy(json, { name: 'My plan', asOf: todayYMD() });
    if (!confirm(`Import "${filename}" from the old Forecast app? This replaces the current plan (you can undo).`)) return false;
    store.replace(plan);
    if (ui) setUIValues(ui);
    toast(`Imported ${plan.accounts.length} accounts, ${plan.debts.length} debts and ${plan.flows.length} cash flows.`, 'ok', 6000);
    return report;
  }
  toast("This file isn't a Paths plan or a Forecast export.", 'err');
  return false;
}

// http://127.0.0.1:4340/?load=local/forecast-export.json — same-site relative paths only.
export async function loadFromQuery() {
  const params = new URLSearchParams(location.search);
  const src = params.get('load');
  if (!src) return;
  const clean = () => { params.delete('load'); history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`); };
  if (/^[a-z][a-z0-9+.-]*:|^\/\/|\.\./i.test(src)) { clean(); toast('Only files from this site can be loaded.', 'err'); return; }
  try {
    const res = await fetch(src, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const report = importPlanJSON(await res.json(), src.split('/').pop());
    clean();
    if (report) { lastReport = report; navigate('settings'); }
  } catch (e) {
    clean();
    toast(`Couldn't load ${src}: ${e.message}`, 'err', 8000);
  }
}
