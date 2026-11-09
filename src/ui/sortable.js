// Drag-to-reorder for lists, with mouse, touch and keyboard. Pointer events (not HTML5 drag and
// drop) so it also works on phones.
//
// Rows carry data-sort-id and data-sort-group; group headers carry data-sort-header (the group
// key) so items can be dropped into an empty or collapsed group. The drag starts only from a
// handle (DragHandle). `canDrop(dragId, group)` can veto moves between groups.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html } from './h.js';

export { moveItem } from './reorder.js';

export function useSortable({ onMove, canDrop = () => true }) {
  const [drag, setDrag] = useState(null); // { id, group }
  const [over, setOver] = useState(null); // { id, pos: 'before'|'after' } or { header: key }
  const state = useRef({});
  state.current = { drag, over, onMove, canDrop };

  useEffect(() => {
    if (!drag) return undefined;
    let raf = 0;
    let lastY = 0;
    const scroll = () => {
      const edge = 60;
      const h = window.innerHeight;
      const dy = lastY < edge ? -(edge - lastY) / 3 : lastY > h - edge ? (lastY - (h - edge)) / 3 : 0;
      if (dy) window.scrollBy(0, dy);
      raf = requestAnimationFrame(scroll);
    };
    raf = requestAnimationFrame(scroll);
    const move = e => {
      lastY = e.clientY;
      const { drag: d, canDrop: ok } = state.current;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const row = el?.closest('[data-sort-id]');
      const head = el?.closest('[data-sort-header]');
      if (row && row.dataset.sortId !== d.id) {
        if (!ok(d.id, row.dataset.sortGroup)) return setOver(null);
        const r = row.getBoundingClientRect();
        setOver({ id: row.dataset.sortId, group: row.dataset.sortGroup, pos: e.clientY < r.top + r.height / 2 ? 'before' : 'after' });
      } else if (head) {
        setOver(ok(d.id, head.dataset.sortHeader) ? { header: head.dataset.sortHeader, group: head.dataset.sortHeader } : null);
      } else if (!row) setOver(null);
    };
    const up = () => {
      const { drag: d, over: o, onMove: commit } = state.current;
      if (d && o) commit(d.id, o);
      setDrag(null);
      setOver(null);
    };
    const key = e => { if (e.key === 'Escape') { setDrag(null); setOver(null); } };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('keydown', key);
    document.body.classList.add('is-sorting');
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('keydown', key);
      document.body.classList.remove('is-sorting');
    };
  }, [drag?.id]);

  const start = (id, group) => e => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setDrag({ id, group });
  };
  const rowClass = id => (drag?.id === id ? 'dragging' : over?.id === id ? `drop-${over.pos}` : '');
  const headerClass = group => (drag && over?.header === (group ?? '') ? 'drop-into' : '');
  return { start, rowClass, headerClass, dragging: !!drag };
}

// The grip. Arrow keys move the item up/down by one without a mouse.
export function DragHandle({ onPointerDown, onKeyMove, label }) {
  return html`<button type="button" class="drag-handle" aria-label=${`Reorder ${label}`} title="Drag to reorder (or use ↑/↓)"
    onPointerDown=${onPointerDown} onClick=${e => e.stopPropagation()}
    onKeyDown=${e => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); onKeyMove(e.key === 'ArrowUp' ? -1 : 1, e.currentTarget); }
    }}>
    <svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true"><g fill="currentColor"><circle cx="3.5" cy="3" r="1.4"/><circle cx="8.5" cy="3" r="1.4"/><circle cx="3.5" cy="8" r="1.4"/><circle cx="8.5" cy="8" r="1.4"/><circle cx="3.5" cy="13" r="1.4"/><circle cx="8.5" cy="13" r="1.4"/></g></svg>
  </button>`;
}
