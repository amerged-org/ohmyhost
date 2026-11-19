import assert from "node:assert/strict";
import test from "node:test";
import {
  allowedEdit,
  allowedOutbound,
  authorized,
  createId,
  parseControl,
  previewId,
  signId,
  validateCreate,
  verifyId,
} from "../protocol.mjs";

const secret = "a-private-local-test-token-at-least-32-bytes";

test("control routes require the exact bearer credential and match only the spike API", async () => {
  assert.equal(await authorized(`Bearer ${secret}`, secret), true);
  assert.equal(await authorized(`Bearer ${secret}x`, secret), false);
  assert.equal(await authorized(`Bearer short`, "short"), false);
  assert.deepEqual(parseControl("/\u005f\u005fspike/sessions"), { action: "create" });
  assert.deepEqual(parseControl("/\u005f\u005fspike/sessions/example/edit"), {
    action: "edit",
    id: "example",
  });
  assert.equal(parseControl("/\u005f\u005fspike/sessions/example/edit/more"), null);
});

test("signed session hostnames cannot be forged or moved outside the configured domain", async () => {
  const id = createId();
  assert.equal(id.length, 32);
  const label = await signId(id, secret);
  assert.equal(label.length, 57);
  assert.equal(await verifyId(label, secret), true);
  assert.equal(
    await verifyId(`${label.slice(0, -1)}${label.endsWith("0") ? "1" : "0"}`, secret),
    false,
  );
  assert.equal(await verifyId(label, `${secret}x`), false);
  assert.equal(previewId(`${label}.preview.dev.omh.st`, "preview.dev.omh.st"), label);
  assert.equal(previewId(`${label}.preview.dev.omh.st.attacker.test`, "preview.dev.omh.st"), null);
  assert.equal(previewId(`other.${label}.preview.dev.omh.st`, "preview.dev.omh.st"), null);
});

test("sessions, source writes and egress admit only narrow fixture inputs", () => {
  assert.deepEqual(validateCreate({ fixture: "next-edge", instance: "basic" }), {
    fixture: "next-edge",
    instance: "basic",
    inactivityMs: 600_000,
    cacheMode: "seeded",
    idleMode: "product",
  });
  assert.equal(
    validateCreate({ fixture: "next-edge", instance: "basic", idleMode: "sdk" }).idleMode,
    "sdk",
  );
  assert.equal(
    validateCreate({ fixture: "next-edge", instance: "basic", idleMode: "other" }),
    null,
  );
  assert.equal(
    validateCreate({ fixture: "next-edge", instance: "basic", cacheMode: "empty" }).cacheMode,
    "empty",
  );
  assert.equal(
    validateCreate({ fixture: "next-edge", instance: "basic", cacheMode: "unknown" }),
    null,
  );
  assert.equal(validateCreate({ fixture: "unknown", instance: "basic" }), null);
  assert.equal(validateCreate({ fixture: "next-edge", instance: "arbitrary" }), null);
  assert.equal(validateCreate({ fixture: "next-edge", instance: "basic", inactivityMs: 1 }), null);
  assert.equal(allowedEdit("src/app/page.tsx", "hello"), true);
  assert.equal(allowedEdit("src/a..b.ts", "hello"), false);
  assert.equal(allowedEdit("src/../../etc/passwd", "hello"), false);
  assert.equal(allowedEdit("src/../package.json", "hello"), false);
  assert.equal(allowedEdit("package.json", "hello"), false);
  assert.equal(allowedEdit("src/app/page.tsx", "x".repeat(65_537)), false);
  assert.equal(allowedOutbound("https://registry.npmjs.org/package"), true);
  assert.equal(allowedOutbound("https://registry.npmjs.org.attacker.test/package"), false);
  assert.equal(allowedOutbound("https://registry.npmjs.org:444/package"), false);
  assert.equal(allowedOutbound("http://registry.npmjs.org/package"), false);
});
