// Thin uPlot wrapper: responsive width, downsampling, money axes, optional cursor sync.
import { useEffect, useRef } from 'preact/hooks';
import uPlot from 'uplot';
import { html, compact } from './h.js';
import { useUI } from '../store.js';

const EMPTY_VIEW = { hidden: [], right: [] };
import { windowDays } from './range.js';

export { windowDays, nudgeWindow, durationLabel } from './range.js';

const MAX_POINTS = 900;

// Pick evenly spaced buckets between i0..i1; for each series take the bucket's last value,
// or its minimum when `agg === 'min'` (so a short cash dip is never hidden by sampling).
function sample(dates, series, i0, i1) {
  const span = Math.max(1, i1 - i0 + 1);
  const step = Math.max(1, Math.ceil(span / MAX_POINTS));
  const xs = [];
  const ys = series.map(() => []);
  for (let b = i0; b <= i1; b += step) {
    const e = Math.min(i1, b + step - 1);
    xs.push(dates[e].getTime() / 1000);
    series.forEach((s, k) => {
      const v = s.values;
      if (s.constant != null) ys[k].push(s.constant);
      else if (s.agg === 'min') {
        let m = Infinity;
        for (let i = b; i <= e; i++) if (v[i] < m) m = v[i];
        ys[k].push(m);
      } else ys[k].push(v[e]);
    });
  }
  return [xs, ...ys];
}

// A line that changes color where it crosses a value (e.g. cash: green above $0, red below).
function thresholdStroke(u, si, s) {
  const { top, height } = u.bbox;
  if (!height) return s.color;
  const y = u.valToPos(s.threshold ?? 0, u.series[si].scale, true);
  const f = Math.min(1, Math.max(0, (y - top) / height));
  const g = u.ctx.createLinearGradient(0, top, 0, top + height);
  g.addColorStop(0, s.color); g.addColorStop(f, s.color);
  g.addColorStop(f, s.below); g.addColorStop(1, s.below);
  return g;
}

// A heavier line at $0 on the left axis, drawn under the data lines.
function zeroLine(u, color) {
  const sc = u.scales.y;
  if (!(sc && sc.min < 0 && sc.max > 0) && !(sc && (sc.min === 0 || sc.max === 0))) return;
  const y = Math.round(u.valToPos(0, 'y', true));
  const { left, width } = u.bbox;
  const ctx = u.ctx;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(left + width, y);
  ctx.stroke();
  ctx.restore();
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * series: [{ key?, label, values: Float64Array, color, width?, dash?, fill?, agg?, axis?: 'right',
 *            below?: color under `threshold` (default 0) }]
 * dates: Date[]; range: [i0, i1] day indices
 * refLines: [{ value, label, color }] horizontal reference lines (left axis)
 * viewKey: remember which lines are hidden (and on the right axis) across rebuilds and visits.
 *   view/onView can be passed instead to control that state from outside.
 */
export function Chart({ series, dates, range, height = 300, refLines = [], syncKey, yLabel, viewKey, view: viewProp, onView }) {
  const host = useRef(null);
  const plot = useRef(null);
  const [stored, setStored] = useUI(viewKey ? `chart:${viewKey}` : '__chart-unsaved', EMPTY_VIEW);
  const local = useRef(EMPTY_VIEW);
  const view = viewProp || (viewKey ? stored : local.current);
  const setView = onView || (viewKey ? setStored : v => { local.current = v; });
  const viewRef = useRef({ view, setView });
  viewRef.current = { view, setView };
  const hidden = new Set(view.hidden || []);
  const right = new Set(view.right || []);

  useEffect(() => {
    const el = host.current;
    if (!el || !dates?.length) return undefined;
    const [i0, i1] = range || [0, dates.length - 1];
    const all = [...series, ...refLines.map(r => ({ key: `ref:${r.label}`, label: r.label, constant: r.value, color: r.color, dash: [6, 5], width: 1.5 }))];
    const keys = all.map(s => s.key || s.label);
    const onRight = all.map((s, k) => !s.constant && (s.axis === 'right' || right.has(keys[k])));
    const anyRight = onRight.some((r, k) => r && !hidden.has(keys[k]));
    const data = sample(dates, all, i0, i1);
    const grid = cssVar('--border', '#e5e7eb');
    const axisColor = cssVar('--muted', '#6b7280');
    const zeroColor = cssVar('--faint', '#94a0ae');
    const rightOnly = all.filter((s, k) => onRight[k] && !hidden.has(keys[k]));
    const opts = {
      width: Math.max(280, el.clientWidth),
      height,
      cursor: { sync: syncKey ? { key: syncKey } : undefined, points: { size: 7 } },
      legend: { live: true, markers: { stroke: (u, i) => (i > 0 ? all[i - 1]?.color : undefined) } },
      scales: { x: { time: true }, y: {}, r: {} },
      axes: [
        { stroke: axisColor, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } },
        { scale: 'y', stroke: axisColor, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 64, values: (u, vals) => vals.map(v => compact(v)), label: yLabel },
        ...(anyRight ? [{ scale: 'r', side: 1, stroke: rightOnly.length === 1 ? rightOnly[0].color : axisColor, grid: { show: false }, ticks: { stroke: grid }, size: 64, values: (u, vals) => vals.map(v => compact(v)) }] : [])
      ],
      series: [
        { value: (u, v) => (v == null ? '' : new Date(v * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })) },
        ...all.map((s, k) => ({
          label: onRight[k] ? `${s.label} (right)` : s.label,
          scale: onRight[k] ? 'r' : 'y',
          show: !hidden.has(keys[k]),
          stroke: s.below ? (u, si) => thresholdStroke(u, si, s) : s.color,
          width: s.width ?? 2,
          dash: s.dash,
          fill: s.fill,
          points: { show: false },
          value: (u, v) => (v == null ? '' : compact(v))
        }))
      ],
      hooks: {
        drawAxes: [u => zeroLine(u, zeroColor)],
        // Clicking a name in the legend shows/hides it; remember that for the next rebuild.
        setSeries: [(u, idx, o) => {
          if (idx == null || !o || !('show' in o)) return;
          const key = keys[idx - 1];
          const { view: cur, setView: save } = viewRef.current;
          const h = new Set(cur.hidden || []);
          if (o.show) h.delete(key); else h.add(key);
          save({ ...cur, hidden: [...h] });
        }]
      }
    };
    plot.current = new uPlot(opts, data, el);
    const ro = new ResizeObserver(() => {
      if (plot.current) plot.current.setSize({ width: Math.max(280, el.clientWidth), height });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
  }, [series, dates, range?.[0], range?.[1], height, JSON.stringify(refLines), syncKey, (view.right || []).join('|'), viewProp || viewKey ? (view.hidden || []).join('|') : '']);

  return html`<div class="chart-wrap" ref=${host}></div>`;
}

// Index range for the window from the run start.
export function rangeFor(run, years) {
  if (!run) return [0, 0];
  if (!years || years === 'all') return [0, run.N - 1];
  return [0, Math.min(run.N - 1, windowDays(years, run.start))];
}
