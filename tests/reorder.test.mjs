import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveItem } from '../src/ui/reorder.js';

const ids = l => l.map(x => x.id).join(',');
const flows = [{ id: 'a', group: 'g1' }, { id: 'b', group: 'g1' }, { id: 'c', group: 'g2' }, { id: 'd' }];
const G = { groupOf: f => f.group || '', setGroup: (f, g) => { if (g) f.group = g; else delete f.group; } };

test('moves before / after a row', () => {
  assert.equal(ids(moveItem(flows, 'a', { id: 'b', pos: 'after', group: 'g1' }, G)), 'b,a,c,d');
  assert.equal(ids(moveItem(flows, 'd', { id: 'a', pos: 'before', group: 'g1' }, G)), 'd,a,b,c');
});

test('moving onto a row in another group changes the group', () => {
  const out = moveItem(flows, 'a', { id: 'c', pos: 'after', group: 'g2' }, G);
  assert.equal(ids(out), 'b,c,a,d');
  assert.equal(out.find(x => x.id === 'a').group, 'g2');
  assert.equal(flows[0].group, 'g1', 'input not mutated');
});

test('dropping on a group header appends to that group (or ungroups)', () => {
  const out = moveItem(flows, 'c', { header: 'g1', group: 'g1' }, G);
  assert.equal(ids(out), 'a,b,c,d');
  assert.equal(out[2].group, 'g1');
  const ungrouped = moveItem(flows, 'a', { header: '', group: '' }, G);
  assert.equal(ids(ungrouped), 'b,c,d,a');
  assert.equal(ungrouped[3].group, undefined);
  const empty = moveItem(flows, 'a', { header: 'g9', group: 'g9' }, G);
  assert.equal(ids(empty), 'b,c,d,a');
  assert.equal(empty[3].group, 'g9');
});

test('without a setGroup, groups never change', () => {
  const out = moveItem(flows, 'a', { id: 'c', pos: 'before', group: 'g2' });
  assert.equal(out.find(x => x.id === 'a').group, 'g1');
});
