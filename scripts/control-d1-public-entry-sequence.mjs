import { fail, integerText } from "./control-d1-codec.mjs";
export const PUBLIC_ENTRY_SEQUENCE = Object.freeze({
  kind: "original-beta-feature-position-v1",
  sourceName: "beta_feature_interests_position_seq",
  targetName: "beta_feature_vote_allocator",
  ownedTable: "beta_feature_interests",
  ownedColumn: "position",
  dataType: "bigint",
  minimum: "1",
  maximum: "9223372036854775807",
  increment: "1",
  cycle: false,
});
/** Exact original independent allocator state. Position is neither unique nor PK: never compare/repair against MAX(rows). */
export function publicEntrySequenceRow(restore) {
  const spec = PUBLIC_ENTRY_SEQUENCE;
  if (
    restore?.kind !== spec.kind ||
    restore.sourceName !== spec.sourceName ||
    restore.targetName !== spec.targetName ||
    typeof restore.isCalled !== "boolean"
  )
    fail("PUBLIC_ENTRY_SEQUENCE_MAPPING");
  const value = BigInt(integerText(restore.lastValue));
  if (value < 1n) fail("PUBLIC_ENTRY_SEQUENCE_STATE");
  return { singleton: "1", last_value: restore.lastValue, is_called: restore.isCalled ? "1" : "0" };
}
export function publicEntrySequences(capture, mapped) {
  const restores = [],
    gaps = [];
  if (!mapped.includes(PUBLIC_ENTRY_SEQUENCE.ownedTable)) return { restores, gaps };
  const sequences = capture.manifest.sequences.filter(
    (sequence) => sequence.name === PUBLIC_ENTRY_SEQUENCE.sourceName,
  );
  try {
    if (sequences.length !== 1) fail("PUBLIC_ENTRY_SEQUENCE_REQUIRED");
    const sequence = sequences[0],
      spec = PUBLIC_ENTRY_SEQUENCE;
    if (
      sequence.owned_table !== spec.ownedTable ||
      sequence.owned_column !== spec.ownedColumn ||
      sequence.data_type !== spec.dataType ||
      sequence.increment_by !== spec.increment ||
      sequence.min_value !== spec.minimum ||
      sequence.max_value !== spec.maximum ||
      sequence.cycle !== false ||
      typeof sequence.state?.is_called !== "boolean"
    )
      fail("PUBLIC_ENTRY_SEQUENCE_DEFINITION");
    const restore = {
      kind: spec.kind,
      sourceName: spec.sourceName,
      targetName: spec.targetName,
      lastValue: sequence.state.last_value,
      isCalled: sequence.state.is_called,
    };
    publicEntrySequenceRow(restore);
    restores.push(restore);
  } catch (error) {
    if (!/^CONTROL_D1_/u.test(error.message)) throw error;
    gaps.push({ group: "public-entry-sequence", code: error.message });
  }
  return { restores, gaps };
}
export async function readPublicEntrySequenceFacts(db) {
  const row = await db
    .prepare(
      "SELECT CAST(last_value AS TEXT) last_value,is_called FROM beta_feature_vote_allocator WHERE singleton=1",
    )
    .first();
  if (!row || (row.is_called !== 0 && row.is_called !== 1)) fail("PUBLIC_ENTRY_SEQUENCE_TARGET");
  const spec = PUBLIC_ENTRY_SEQUENCE,
    restore = {
      kind: spec.kind,
      sourceName: spec.sourceName,
      targetName: spec.targetName,
      lastValue: row.last_value,
      isCalled: row.is_called === 1,
    };
  publicEntrySequenceRow(restore);
  return [restore];
}
