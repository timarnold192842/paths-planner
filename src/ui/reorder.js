// Pure reorder: move `id` relative to a target row, or to the end of a group (header drop).
// `groupOf(item)` / `setGroup(item, key)` let a move change the item's group (cash-flow groups).
export function moveItem(list, id, target, { groupOf = () => '', setGroup } = {}) {
  const from = list.findIndex(x => x.id === id);
  if (from < 0) return list;
  const item = { ...list[from] };
  const rest = list.filter(x => x.id !== id);
  if (setGroup && target.group != null && target.group !== groupOf(item)) setGroup(item, target.group);
  let at;
  if (target.header != null) {
    const lastInGroup = rest.map(groupOf).lastIndexOf(target.header);
    at = lastInGroup >= 0 ? lastInGroup + 1 : rest.length;
  } else {
    const t = rest.findIndex(x => x.id === target.id);
    if (t < 0) return list;
    at = target.pos === 'before' ? t : t + 1;
  }
  rest.splice(at, 0, item);
  return rest;
}
