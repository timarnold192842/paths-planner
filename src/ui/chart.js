// Thin uPlot wrapper: responsive width, downsampling, money axes, optional cursor sync.
import { useEffect, useRef } from 'preact/hooks';
import uPlot from 'uplot';
import { html, compact } from './h.js';
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

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * series: [{ label, values: Float64Array, color, width?, dash?, fill?, agg? }]
 * dates: Date[]; range: [i0, i1] day indices
 * refLines: [{ value, label, color }] horizontal reference lines
 */
export function Chart({ series, dates, range, height = 300, refLines = [], syncKey, yLabel }) {
  const host = useRef(null);
  const plot = useRef(null);

  useEffect(() => {
    const el = host.current;
    if (!el || !dates?.length) return undefined;
    const [i0, i1] = range || [0, dates.length - 1];
    const all = [...series, ...refLines.map(r => ({ label: r.label, constant: r.value, color: r.color, dash: [6, 5], width: 1.5 }))];
    const data = sample(dates, all, i0, i1);
    const grid = cssVar('--border', '#e5e7eb');
    const axisColor = cssVar('--muted', '#6b7280');
    const opts = {
      width: Math.max(280, el.clientWidth),
      height,
      cursor: { sync: syncKey ? { key: syncKey } : undefined, points: { size: 7 } },
      legend: { live: true },
      scales: { x: { time: true } },
      axes: [
        { stroke: axisColor, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } },
        { stroke: axisColor, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 64, values: (u, vals) => vals.map(v => compact(v)), label: yLabel }
      ],
      series: [
        { value: (u, v) => (v == null ? '' : new Date(v * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })) },
        ...all.map(s => ({
          label: s.label,
          stroke: s.color,
          width: s.width ?? 2,
          dash: s.dash,
          fill: s.fill,
          points: { show: false },
          value: (u, v) => (v == null ? '' : compact(v))
        }))
      ]
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
  }, [series, dates, range?.[0], range?.[1], height, JSON.stringify(refLines), syncKey]);

  return html`<div class="chart-wrap" ref=${host}></div>`;
}

// Index range for the window from the run start.
export function rangeFor(run, years) {
  if (!run) return [0, 0];
  if (!years || years === 'all') return [0, run.N - 1];
  return [0, Math.min(run.N - 1, windowDays(years, run.start))];
}
