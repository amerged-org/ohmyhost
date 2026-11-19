import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectResendWebhook,
  RESEND_WEBHOOK_EVENTS,
  requireSecretSlot,
  saveVariable,
} from "../scripts/resend-webhook-setup.mjs";
import { appendFile, mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("provider webhook inventory is scoped to the selected platform endpoint", async () => {
  const calls = [];
  const provider = {
    listWebhooks: async (after) => {
      calls.push(after ?? null);
      return after
        ? {
            hasMore: false,
            items: [
              {
                id: "owned",
                endpoint: "https://dev.app.ohmyho.st/webhooks/resend",
                status: "enabled",
                events: [...RESEND_WEBHOOK_EVENTS],
              },
            ],
          }
        : {
            hasMore: true,
            items: [
              {
                id: "foreign",
                endpoint: "https://example.com/hook",
                status: "enabled",
                events: [...RESEND_WEBHOOK_EVENTS],
              },
            ],
          };
    },
  };
  const result = await inspectResendWebhook(provider, "dev");
  assert.equal(result.existing?.id, "owned");
  assert.deepEqual(calls, [null, "foreign"]);
});

test("misconfigured or duplicate provider endpoints fail closed", async () => {
  const endpoint = "https://app.ohmyho.st/webhooks/resend";
  await assert.rejects(
    inspectResendWebhook(
      {
        listWebhooks: async () => ({
          hasMore: false,
          items: [{ id: "one", endpoint, status: "disabled", events: [...RESEND_WEBHOOK_EVENTS] }],
        }),
      },
      "prod",
    ),
    /configuration_mismatch/u,
  );
  await assert.rejects(
    inspectResendWebhook(
      {
        listWebhooks: async () => ({
          hasMore: false,
          items: [
            { id: "one", endpoint, status: "enabled", events: [...RESEND_WEBHOOK_EVENTS] },
            { id: "two", endpoint, status: "enabled", events: [...RESEND_WEBHOOK_EVENTS] },
          ],
        }),
      },
      "prod",
    ),
    /duplicate_endpoint/u,
  );
  await assert.rejects(
    inspectResendWebhook({ listWebhooks: async () => ({ hasMore: true, items: [] }) }, "prod"),
    /inventory_incomplete/u,
  );
});

test("one-time signing secret is appended to the current local file without replacing it", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "resend-webhook-setup-"));
  const path = resolve(directory, ".env.local");
  try {
    await writeFile(path, "RESEND_API_KEY_DEV=re_test\n", { mode: 0o600 });
    const inode = (await stat(path)).ino;
    // Another process appends a credential before the save: the save must keep that line.
    await appendFile(path, "OTHER_TOKEN=kept\n");
    const signing = ["whsec", "dGVzdA=="].join("_");
    await saveVariable(path, "RESEND_WEBHOOK_SECRET_DEV", signing);
    const text = await readFile(path, "utf8");
    assert.match(text, /OTHER_TOKEN=kept\n/u);
    assert.ok(text.endsWith(`RESEND_WEBHOOK_SECRET_DEV=${signing}\n`));
    assert.equal((await stat(path)).ino, inode);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the signing-secret slot is checked before the provider creates the webhook", () => {
  assert.doesNotThrow(() =>
    requireSecretSlot("RESEND_API_KEY_DEV=re_test\n", "RESEND_WEBHOOK_SECRET_DEV"),
  );
  assert.throws(
    () => requireSecretSlot("RESEND_WEBHOOK_SECRET_DEV=\n", "RESEND_WEBHOOK_SECRET_DEV"),
    /already_set/u,
  );
  assert.throws(
    () =>
      requireSecretSlot(
        "RESEND_WEBHOOK_SECRET_DEV=\nRESEND_WEBHOOK_SECRET_DEV=\n",
        "RESEND_WEBHOOK_SECRET_DEV",
      ),
    /duplicate/u,
  );
});
