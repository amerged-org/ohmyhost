import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { expect, it, vi } from "vitest";
import type { D1Database } from "../../src/d1-types.js";
import type { CatalogContext } from "../../src/catalog/common.js";
import {
  claimSignupFeedback,
  beginSignupFeedback,
  finishSignupFeedback,
} from "../../src/catalog/mail/signup-feedback.js";
import { splitStatements } from "../support/sql.js";
import { createSignupFeedbackDispatcher } from "../../../mail-gateway/src/signup-feedback-dispatch.js";
import { createD1SignupFeedbackPersistence } from "../../../mail-gateway/src/d1-signup-feedback-persistence.js";

it("delivers through the gated Core contract once and records the provider receipt", async () => {
  const worker = new Miniflare({
    modules: true,
    script: "export default {fetch() { return new Response('ok'); }}",
    d1Databases: { CONTROL_CORE: "core" },
  });
  try {
    const db = (await worker.getD1Database("CONTROL_CORE")) as unknown as D1Database;
    await db
      .prepare(
        "CREATE TABLE guard_fail(code TEXT NOT NULL, CONSTRAINT guard_precondition_changed CHECK(code <> 'precondition_changed'), CONSTRAINT guard_unregistered CHECK(length(code)<0)) STRICT",
      )
      .run();
    await db
      .prepare(
        "CREATE TABLE user_signup(workos_user_id TEXT PRIMARY KEY, origin_source TEXT, origin_present INTEGER NOT NULL DEFAULT 1, recorded_at TEXT NOT NULL) STRICT",
      )
      .run();
    const migration = readFileSync(
      new URL("../../migrations/core/0636_signup_feedback_mail.sql", import.meta.url),
      "utf8",
    );
    await db.batch(splitStatements(migration).map((sql) => db.prepare(sql)));
    const context = {
      directory: db,
      router: { assertLayout: async () => undefined },
    } as unknown as CatalogContext;
    const started = Date.now();
    let elapsed = 0;
    const now = () => new Date(started + elapsed);
    await db.prepare("UPDATE signup_feedback_mail_settings SET enabled=1 WHERE singleton=1").run();
    await db
      .prepare("INSERT INTO user_signup(workos_user_id,recorded_at) VALUES (?,?)")
      .bind("user_feedback_integration", now().toISOString().replace("Z", "000Z"))
      .run();
    const send = vi.fn(async () => ({ messageId: "provider_123" }));
    const dispatcher = createSignupFeedbackDispatcher({
      store: createD1SignupFeedbackPersistence({
        claim: (input: unknown) => claimSignupFeedback(context, input),
        begin: (input: unknown) => beginSignupFeedback(context, input),
        finish: (input: unknown) => finishSignupFeedback(context, input),
      }),
      recipients: {
        resolve: async () => ({ eligible: true, email: "user@example.com", firstName: "Test" }),
      },
      now,
      sender: { send },
    });
    expect(await dispatcher.sync()).toEqual({ claimed: 0, accepted: 0, skipped: 0, unresolved: 0 });
    elapsed = 3_600_000;
    expect(await dispatcher.sync()).toEqual({ claimed: 1, accepted: 1, skipped: 0, unresolved: 0 });
    expect(await dispatcher.sync()).toEqual({ claimed: 0, accepted: 0, skipped: 0, unresolved: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      await db
        .prepare(
          "SELECT state,provider_message_id FROM signup_feedback_mail WHERE workos_user_id=?",
        )
        .bind("user_feedback_integration")
        .first(),
    ).toMatchObject({ state: "accepted", provider_message_id: "provider_123" });
  } finally {
    await worker.dispose();
  }
}, 240_000);
