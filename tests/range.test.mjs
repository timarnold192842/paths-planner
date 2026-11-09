import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowDays, nudgeWindow, durationLabel } from '../src/ui/range.js';

const S = '2027-01-01';
const MAX = windowDays(30, S);

test('presets are exact calendar years', () => {
  assert.equal(windowDays(2, '2029-01-01'), 730);
  assert.equal(windowDays(2, '2026-11-09'), 731); // crosses Feb 29, 2028
  assert.equal(durationLabel(10, S), '10 years');
  assert.equal(durationLabel(1, S), '1 year');
});

test('nudges move the end by a calendar day, week, month or year', () => {
  let y = nudgeWindow(5, S, 'd', 1, MAX);
  assert.equal(windowDays(y, S), windowDays(5, S) + 1);
  assert.equal(durationLabel(y, S), '5 yrs 1 day');
  y = nudgeWindow(y, S, 'w', 1, MAX);
  assert.equal(durationLabel(y, S), '5 yrs 1 wk 1 day');
  y = nudgeWindow(5, S, 'm', 1, MAX);
  assert.equal(durationLabel(y, S), '5 yrs 1 mo');
  y = nudgeWindow(5, S, 'm', -1, MAX);
  assert.equal(durationLabel(y, S), '4 yrs 11 mo');
  y = nudgeWindow(y, S, 'y', 1, MAX);
  assert.equal(durationLabel(y, S), '5 yrs 11 mo');
  // − then + returns to the same end date
  assert.equal(windowDays(nudgeWindow(nudgeWindow(10, S, 'd', -1, MAX), S, 'd', 1, MAX), S), windowDays(10, S));
});

test('nudges stay within one day and the horizon', () => {
  assert.equal(nudgeWindow(30, S, 'y', 1, MAX), 30, 'already at the end: unchanged');
  assert.equal(windowDays(nudgeWindow(29.5, S, 'y', 1, MAX), S), MAX);
  const tiny = nudgeWindow(3 / 365.25, S, 'w', -1, MAX);
  assert.equal(windowDays(tiny, S), 1);
  assert.equal(durationLabel(tiny, S), '1 day');
  // a preset beyond a short horizon nudges back from the horizon's end
  assert.equal(windowDays(nudgeWindow(30, S, 'd', -1, 3652), S), 3651);
});
