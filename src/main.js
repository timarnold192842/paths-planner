import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { html, cls } from './ui/h.js';
import { store, useStore, useUI } from './store.js';
import { useRoute } from './ui/nav.js';
import { loadFromQuery } from './ui/importer.js';
import { Overview } from './ui/overview.js';
import { Compare } from './ui/compare.js';
import { Scenarios } from './ui/scenarios.js';
import { Decisions } from './ui/decisions.js';
import { Plan } from './ui/plan.js';
import { Settings } from './ui/settings.js';
import { CheckIn } from './ui/checkin.js';
import { Toasts } from './ui/toast.js';
import { Icon } from './ui/icons.js';
import { EditPanel } from './ui/editpanel.js';

const NAV = [
  ['overview', 'Overview'],
  ['compare', 'Compare'],
  ['scenarios', 'Scenarios'],
  ['decisions', 'Decisions'],
  ['plan', 'Plan'],
  ['settings', 'Settings']
];
const MOBILE_NAV = ['overview', 'compare', 'scenarios', 'decisions', 'plan'];

function SaveStatus() {
  const s = store.saveState;
  if (s.status === 'error') return html`<span class="badge neg" title=${s.error}>Not saved — export a backup</span>`;
  return html`<span class="small faint hide-sm">${s.status === 'saving' ? 'Saving…' : 'Saved in this browser'}</span>`;
}

function App() {
  useStore();
  const plan = store.plan;
  const [page, sub] = useRoute();
  const [scenarioId, setScenarioId] = useUI('scenarioId', 'baseline');
  const activeScenario = plan.scenarios.some(s => s.id === scenarioId) ? scenarioId : plan.scenarios[0]?.id;
  const [navCollapsed, setNavCollapsed] = useUI('navCollapsed', false);
  const [panelOpen, setPanelOpen] = useUI('editPanel', false);
  const panelPage = page === 'overview' || page === 'compare' || page === '';
  const showPanel = panelOpen && panelPage;

  useEffect(() => {
    const onKey = e => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== 'z') return;
      if (e.target.closest?.('input, textarea, select')) return;
      e.preventDefault();
      if (e.shiftKey) store.redo(); else store.undo();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => { document.title = `${plan.name} · Paths`; }, [plan.name]);

  let body;
  switch (page) {
    case 'compare': body = html`<${Compare} />`; break;
    case 'scenarios': body = html`<${Scenarios} />`; break;
    case 'decisions': body = html`<${Decisions} />`; break;
    case 'plan': body = html`<${Plan} tab=${sub || 'flows'} />`; break;
    case 'settings': body = html`<${Settings} />`; break;
    case 'checkin': body = html`<${CheckIn} />`; break;
    default: body = html`<${Overview} scenarioId=${activeScenario} />`;
  }

  return html`<div class=${cls('shell', navCollapsed && 'nav-collapsed', showPanel && 'with-panel')}>
    <nav class="sidenav" aria-label="Main">
      <div class="brand"><span class="brand-mark"><${Icon} name="scenarios" /></span><span class="nav-label">Paths</span></div>
      ${NAV.map(([k, l]) => html`<a class=${cls('navlink', page === k && 'active')} href=${`#/${k}`} title=${navCollapsed ? l : undefined} aria-label=${navCollapsed ? l : undefined} aria-current=${page === k ? 'page' : undefined}><${Icon} name=${k} /><span class="nav-label">${l}</span></a>`)}
      <div class="nav-spacer"></div>
      <div class="small faint nav-label" style="padding:0 12px">${plan.scenarios.length} scenarios · ${plan.decisions.length} decisions</div>
      <button type="button" class="navlink nav-toggle" aria-label=${navCollapsed ? 'Expand the sidebar' : 'Collapse the sidebar'} title=${navCollapsed ? 'Expand the sidebar' : 'Collapse the sidebar'} onClick=${() => setNavCollapsed(!navCollapsed)}>
        <span class="chev-ico" aria-hidden="true">${navCollapsed ? '»' : '«'}</span><span class="nav-label">Collapse</span>
      </button>
    </nav>
    <div class="main">
      <header class="topbar">
        <h1>${plan.name}</h1>
        <div class="spacer"></div>
        ${page === 'overview' ? html`<select value=${activeScenario} onChange=${e => setScenarioId(e.target.value)} aria-label="Scenario to view" style="width:auto;max-width:220px">
          ${plan.scenarios.map(s => html`<option value=${s.id}>${s.name}</option>`)}
        </select>` : null}
        ${panelPage ? html`<button type="button" class=${cls('btn sm', panelOpen ? 'primary' : '')} aria-pressed=${panelOpen} title="Edit amounts, dates and on/off beside the chart" onClick=${() => setPanelOpen(!panelOpen)}><${Icon} name="plan" /><span class="hide-sm">Edit plan</span></button>` : null}
        <${SaveStatus} />
        <button class="btn sm icon ghost" title="Undo (⌘Z)" aria-label="Undo" disabled=${!store.canUndo()} onClick=${() => store.undo()}>${html`<${Icon} name="undo" />`}</button>
        <button class="btn sm icon ghost" title="Redo (⇧⌘Z)" aria-label="Redo" disabled=${!store.canRedo()} onClick=${() => store.redo()}>${html`<${Icon} name="redo" />`}</button>
        <a class="btn sm icon ghost" href="#/settings" title="Settings & data" aria-label="Settings and data"><${Icon} name="settings" /></a>
      </header>
      <div class="workspace">
        <main class="page" id="main">${body}</main>
        ${showPanel ? html`<${EditPanel} key=${activeScenario} scenarioId=${page === 'compare' ? plan.scenarios[0]?.id : activeScenario} onClose=${() => setPanelOpen(false)} />` : null}
      </div>
    </div>
    <nav class="tabbar" aria-label="Main">
      ${MOBILE_NAV.map(k => {
        const [, l] = NAV.find(n => n[0] === k);
        return html`<a class=${page === k ? 'active' : ''} href=${`#/${k}`} aria-current=${page === k ? 'page' : undefined}><${Icon} name=${k} />${l}</a>`;
      })}
    </nav>
    <${Toasts} />
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
loadFromQuery();
