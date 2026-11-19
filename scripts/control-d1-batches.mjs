import { fail } from "./control-d1-codec.mjs";

/** A row-count hint packs COMPLETE contiguous mapper units; it never caps a valid source unit. */
export function importBatches(records, rowHint) {
  if (!Number.isSafeInteger(rowHint) || rowHint < 1 || rowHint > 1000) fail("CHUNK_ROWS");
  const units = [],
    seen = new Set();
  for (let offset = 0; offset < records.length; ) {
    const first = records[offset],
      group = first.atomicGroup;
    const deferred = first.deferForeignKeys ?? false;
    if (typeof deferred !== "boolean" || (deferred && group === undefined)) fail("ATOMIC_UNIT");
    if (
      group !== undefined &&
      (typeof group !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/u.test(group) || seen.has(group))
    )
      fail("ATOMIC_UNIT");
    if (group !== undefined) seen.add(group);
    let end = offset + 1;
    if (group !== undefined)
      while (end < records.length && records[end].atomicGroup === group) {
        if ((records[end].deferForeignKeys ?? false) !== deferred) fail("ATOMIC_UNIT");
        end += 1;
      }
    units.push({ offset, records: records.slice(offset, end), group, deferred });
    offset = end;
  }
  const batches = [];
  let current;
  for (const unit of units) {
    // A deferred graph has its own transaction, so its final FK check cannot borrow a later unit's parent.
    if (
      !current ||
      unit.deferred ||
      current.deferred ||
      current.records.length + unit.records.length > rowHint
    ) {
      current = { offset: unit.offset, records: [], groups: [], deferred: unit.deferred };
      batches.push(current);
    }
    for (const record of unit.records) current.records.push(record);
    if (unit.group !== undefined) current.groups.push(unit.group);
  }
  return batches;
}
