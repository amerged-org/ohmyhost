import { test } from "node:test";
import assert from "node:assert/strict";
import { originalControlFixture } from "./support/control-conversion-fixture.mjs";
import {
  parseMeteringUuidArray,
  meteringUuidArrayText,
} from "../scripts/control-d1-metering-array.mjs";
import { tableProof } from "../scripts/control-d1-codec.mjs";
const UUID = "00000000-0000-4000-8000-000000000042";
test("roundtrips the actual PG18 stored UUID-array dimensions, NULLs and nondefault lower bounds without changing source proof framing", async () => {
  const fixture = await originalControlFixture("metering-uuid-array");
  try {
    assert.deepEqual(
      (
        await fixture.pool.query(
          "SELECT format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid='project_database_compute_changes'::regclass AND attname='provider_operation_ids'",
        )
      ).rows,
      [{ type: "uuid[]" }],
    );
    const grid = [
        [UUID, null],
        [UUID, UUID],
      ],
      nested6 = [[[[[[UUID]]]]]],
      cases = [
        { source: null, bounds: null },
        { source: [], bounds: null },
        { source: [UUID, null, UUID], bounds: null },
        { source: grid, bounds: null },
        { source: nested6, bounds: null },
        { source: `[0:2]={${UUID},NULL,${UUID}}`, bounds: [0] },
        { source: `[0:1][-2:-1]={{${UUID},NULL},{${UUID},${UUID}}}`, bounds: [0, -2] },
        { source: `[-2147483648:-2147483648]={${UUID}}`, bounds: [-2147483648] },
        { source: `[2147483646:2147483646]={${UUID}}`, bounds: [2147483646] },
        {
          source: "[1:1][1:1][1:1][1:1][1:1][0:0]=" + "{".repeat(6) + UUID + "}".repeat(6),
          bounds: [1, 1, 1, 1, 1, 0],
        },
      ];
    const column = {
      name: "provider_operation_ids",
      sourceType: "uuid[]",
      pgType: "uuid[]",
      kind: "array",
    };
    for (const entry of cases) {
      const row = (
          await fixture.pool.query(
            "SELECT $1::uuid[]::text AS text,to_json($1::uuid[]) AS value,array_dims($1::uuid[]) AS dimensions",
            [entry.source],
          )
        ).rows[0],
        parsed = parseMeteringUuidArray(row.text),
        restored = meteringUuidArrayText(parsed.values, parsed.bounds);
      assert.deepEqual(parsed, { values: row.value, bounds: entry.bounds });
      assert.equal(restored, row.text);
      assert.deepEqual(tableProof([column], [[restored]]), tableProof([column], [[row.text]]));
      if (parsed.bounds !== null)
        assert.equal(
          row.dimensions,
          parsed.bounds
            .map((lower, index) => `[${lower}:${lower + shape(parsed.values)[index] - 1}]`)
            .join(""),
        );
    }
    const zero = (
      await fixture.pool.query(
        "SELECT array_fill($1::uuid,ARRAY[0],ARRAY[17])::text AS text,array_dims(array_fill($1::uuid,ARRAY[0],ARRAY[17])) AS dimensions",
        [UUID],
      )
    ).rows[0];
    assert.deepEqual(zero, { text: "{}", dimensions: null });
    assert.deepEqual(parseMeteringUuidArray(zero.text), { values: [], bounds: null });
    for (const invalid of [
      `{${"g".repeat(36)}}`,
      `{${UUID},{${UUID}}}`,
      `{{${UUID}},{${UUID},${UUID}}}`,
      `{{${UUID},${UUID}},{{${UUID}},{${UUID}}}}`,
      `{{NULL,NULL},{{${UUID}},{NULL}}}`,
      `{{{{{{{${UUID}}}}}}}`,
      `[2147483647:2147483647]={${UUID}}`,
      `[2147483646:2147483647]={${UUID},${UUID}}`,
      `[-2147483649:-2147483649]={${UUID}}`,
      `[0:1]={${UUID}}`,
    ]) {
      await assert.rejects(() => fixture.pool.query("SELECT $1::uuid[]", [invalid]));
      assert.throws(
        () => parseMeteringUuidArray(invalid),
        /CONTROL_D1_METERING_UUID_ARRAY_UNREPRESENTABLE/u,
      );
    }
    // Native input syntax may normalize, but capture is actual canonical array_out; no source bytes are repaired.
    for (const input of [`{"${UUID}"}`, `[1:1]={${UUID}}`, "{{},{}}"]) {
      const text = (await fixture.pool.query("SELECT $1::uuid[]::text AS text", [input])).rows[0]
        .text;
      assert.notEqual(text, input);
      assert.throws(() => parseMeteringUuidArray(input));
      assert.equal(meteringUuidArrayText(parseMeteringUuidArray(text).values, null), text);
    }
    for (const invalid of [
      undefined,
      17,
      "",
      `[x:1]={${UUID}}`,
      `[0:0]{${UUID}}`,
      `{${UUID}}trailing`,
      `{${UUID},}`,
      `[0:0][0:0]={${UUID}}`,
    ])
      assert.throws(() => parseMeteringUuidArray(invalid));
    for (const [values, bounds] of [
      [null, [0]],
      [[], []],
      [[UUID], [1]],
      [[UUID], [0, 0]],
      [[UUID], [0.5]],
      [[UUID], [2147483647]],
      [[UUID], [-2147483649]],
      [[UUID, [UUID]], null],
      [[[UUID], [UUID, UUID]], null],
      [[[[[[[[UUID]]]]]]], null],
      [["bad"], null],
      [[true], null],
      [[{ id: UUID }], null],
      [Array.from({ length: 17 }, () => UUID), null],
    ])
      assert.throws(() => meteringUuidArrayText(values, bounds));
  } finally {
    await fixture.dispose();
  }
});
function shape(value) {
  return Array.isArray(value) && value.length > 0
    ? [value.length, ...(Array.isArray(value[0]) ? shape(value[0]) : [])]
    : [];
}
