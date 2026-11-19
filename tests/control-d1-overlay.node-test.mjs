/* global URL */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { importOverlay, openLocalTarget, targetPin } from "../scripts/control-d1-target.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

test("the import overlay is the closed set of derived triggers of the Core and refuses any other bytes", async () => {
  const target = await openLocalTarget({ repositoryRoot });
  try {
    const pin = await targetPin(repositoryRoot);
    const overlay = await importOverlay(target.db, repositoryRoot, pin);
    assert.deepEqual(
      overlay.triggers.map((trigger) => trigger.name),
      [
        "github_grant_bind_source",
        "mark_mail_capabilities_dirty_insert",
        "mirror_legacy_workspace_mail",
        "pgcf_serving_interval_on_head_delete",
        "pgcf_serving_interval_on_head_insert",
        "pgcf_serving_interval_on_head_update",
      ],
    );

    // A migration whose bytes are not the qualified ones is refused before any trigger is read.
    const changedPin = {
      ...pin,
      migrations: pin.migrations.map((entry) =>
        entry.name === "0466_mail_original_management.sql"
          ? { ...entry, sha256: "00".repeat(32) }
          : entry,
      ),
    };
    await assert.rejects(
      importOverlay(target.db, repositoryRoot, changedPin),
      /OVERLAY_VERSION_UNQUALIFIED/u,
    );

    // A missing trigger of the set is a mismatch, not a smaller overlay.
    await target.db.prepare("DROP TRIGGER github_grant_bind_source").run();
    await assert.rejects(
      importOverlay(target.db, repositoryRoot, pin),
      /OVERLAY_TRIGGER_MISMATCH/u,
    );
  } finally {
    await target.dispose();
  }
});
