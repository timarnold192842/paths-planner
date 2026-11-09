// Shared helper: run the OLD Forecast engine (../budget-pages) in a sandbox, for parity checks.
// Skipped automatically when the old app isn't checked out next to this repo.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const legacyRoot = process.env.LEGACY_FORECAST_DIR || path.resolve(here, '../../budget-pages');
export const legacyAvailable = fs.existsSync(path.join(legacyRoot, 'assets/finance.js'));

export function legacyEmbedded() {
  const html = fs.readFileSync(path.join(legacyRoot, 'index.html'), 'utf8');
  return JSON.parse(html.match(/<script id="embedded-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
}

export function runLegacy(data, asOfIso) {
  const fixed = `${asOfIso}T16:00:00Z`;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return new Date(fixed).getTime(); }
  }
  const elements = new Map([['save-status', { dataset: {}, setAttribute() {} }], ['today-panel', { innerHTML: '' }]]);
  const context = vm.createContext({
    Date: FixedDate,
    console: { log() {}, error() {}, warn() {} },
    performance, structuredClone, setTimeout, clearTimeout, Event,
    document: { addEventListener() {}, querySelectorAll: () => [], getElementById: id => elements.get(id) || null },
    localStorage: { setItem() {}, getItem: () => null, removeItem() {} }
  });
  vm.runInContext(fs.readFileSync(path.join(legacyRoot, 'assets/finance.js'), 'utf8'), context);
  context.payload = JSON.parse(JSON.stringify(data));
  vm.runInContext('applyImportedData(payload)', context);
  return JSON.parse(vm.runInContext(`(() => {
    const d = calculateBalances();
    const nw = computeNetWorthSeries(d);
    return JSON.stringify({ dates: d.dates.map(x => toYMD(x)), nw: Array.from(nw), cash: Array.from(d.accountBalances.Cash), accounts: Object.fromEntries(Object.entries(d.accountBalances).map(([k, v]) => [k, Array.from(v)])), loans: Object.fromEntries(Object.entries(d.loanBalances).map(([k, v]) => [k, Array.from(v)])) });
  })()`, context));
}
