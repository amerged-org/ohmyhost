import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControlStore } from "../src/store.js";
import { newUlid } from "../src/catalog/common.js";
import { storedTimestamp } from "../src/timestamps.js";
import { createTestControl, type TestControl } from "./support/control-d1.js";
import { fundOrganization } from "./support/mail-events-fixture.js";
import { seedProject } from "./support/platform-fixtures.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());

const sha = (character: string) => character.repeat(64);

describe("suspended workspace sender names", () => {
  it("keeps a reputation-suspended sender name away from every other organization, even after it is retired", async () => {
    const store = createControlStore(control.bindings),
      db = control.core,
      now = new Date().toISOString(),
      owner = await seedProject(control),
      rival = await seedProject(control),
      domainId = newUlid(),
      domain = `held-${domainId.slice(-10).toLowerCase()}.example.com`;
    for (const organizationId of [owner.organizationId, rival.organizationId])
      await fundOrganization(control, organizationId, now);
    await db
      .prepare(
        "INSERT INTO shared_mail_capabilities VALUES('same-domain-sharing-v1',1,'fixture',?) ON CONFLICT(capability) DO UPDATE SET enabled=1",
      )
      .bind(storedTimestamp(now))
      .run();

    expect(
      await store.sharedMail.createDomain({
        organizationId: owner.organizationId,
        idempotencyKey: "create-owner",
        principalId: "user:owner",
        requestSha256: sha("a"),
        now,
        domainId,
        domain,
      }),
    ).toEqual({ domainId, response: null });

    // Complaints suspended the name, then its owner retired the sender.
    await db
      .prepare(
        `UPDATE workspace_mail_domains SET status='retired', reputation_state='suspended', reputation_suspended_at=?2,
          reputation_suspension_reason='bounce_rate', reputation_triggering_event_id=?3, reputation_version=reputation_version+1,
          retired_at=?2 WHERE domain_id=?1`,
      )
      .bind(domainId, storedTimestamp(now), randomUUID())
      .run();

    await expect(
      store.sharedMail.createDomain({
        organizationId: rival.organizationId,
        idempotencyKey: "create-rival",
        principalId: "user:rival",
        requestSha256: sha("b"),
        now,
        domainId: newUlid(),
        domain,
      }),
    ).rejects.toThrow("mail_domain_conflict");
  });
});
