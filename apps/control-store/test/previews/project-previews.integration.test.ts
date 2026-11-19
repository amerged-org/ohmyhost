import {
  parseRateCard,
  planPublish,
  planActivate,
  readState,
  applyPlan,
} from "../../../../scripts/credit-prices-model.mjs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createControlStore } from "../../src/store.js";
import { newUlid } from "../../src/catalog/common.js";
import { acceptedPreviewSourceStatements } from "../../src/catalog/previews/source.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { seedProductRuntimeFixture } from "../support/product-runtime-fixture.js";
import { losingWriteResponses, NOW, STORED_NOW } from "../support/platform-fixtures.js";
import { createEnvironmentSecretCipherKeyring, parseUlid } from "@ohmyhost/platform";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());
const token = (n: number, generation = 1) => ({
  lookupSha256: n.toString(16).padStart(2, "0").repeat(32),
  ciphertext: "A".repeat(91),
  nonce: "A".repeat(16),
  keyVersion: 1,
  tokenGeneration: generation,
});

it("durably budgets due usage, gives pending facts priority without starving revisions, and retries missing facts", async () => {
  const isolated = await createTestControl();
  try {
    const p = await setup(isolated),
      created = await p.store.previews.ensure({
        ...p.scope,
        environmentId: p.prodEnvironmentId,
        previewId: newUlid(),
        capability: token(20),
      }),
      id = created.preview.previewId;
    for (let index = 0; index < 33; index += 1) {
      const pending = index < 27,
        closedAt = pending ? STORED_NOW : "2026-10-26T10:00:00.000000Z";
      await p.db.batch([
        p.db
          .prepare(
            "INSERT INTO project_preview_runs(preview_id,runtime_generation,organization_id,project_id,environment_id,billing_epoch_id,application_id,started_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
          )
          .bind(
            id,
            index + 2,
            p.organizationId,
            p.projectId,
            p.prodEnvironmentId,
            p.billingEpochId,
            "a".repeat(32),
            closedAt,
          ),
        p.db
          .prepare(
            "INSERT INTO project_preview_usage_intervals(preview_id,runtime_generation,interval_id,reservation_id,seconds,hold_sequence,quoted_micros,state,container_start_attempted,active_milliseconds,cpu_milliseconds,charged_micros,provider_fact_id,provider_observed_at,created_at,closed_at,resolved_at,reconciliation_next_at) VALUES(?1,?2,?3,?3,60,1,1000000,?4,1,1000,?5,?9,?6,?7,?8,?8,?7,?8)",
          )
          .bind(
            id,
            index + 2,
            `due-${index}`,
            pending ? "awaiting_provider" : "settled",
            pending ? null : 100,
            pending ? null : "a".repeat(64),
            pending ? null : STORED_NOW,
            closedAt,
            Math.ceil(((1000 * 21120 + (pending ? 0 : 100) * 20000) * 2300) / 7000000),
          ),
      ]);
    }
    const cursor = { previewId: id, runtimeGeneration: 2, intervalId: "due-0" };
    expect(await p.store.previews.getReconciliationCursor(undefined)).toBeNull();
    await p.store.previews.setReconciliationCursor({ expected: null, next: cursor });
    expect(await p.store.previews.getReconciliationCursor(undefined)).toEqual(cursor);
    await expect(
      p.store.previews.setReconciliationCursor({ expected: null, next: null }),
    ).rejects.toThrow();
    expect(await p.store.previews.getReconciliationCursor(undefined)).toEqual(cursor);
    await p.store.previews.setReconciliationCursor({ expected: cursor, next: null });
    const initialBatches = await Promise.all([
      p.store.previews.listUsageForReconciliation({ limit: 100, now: NOW }),
      p.store.previews.listUsageForReconciliation({ limit: 100, now: NOW }),
    ]);
    const first = initialBatches.flat();
    expect(first).toHaveLength(20);
    expect(first.filter((run) => run.state === "awaiting_provider")).toHaveLength(16);
    expect(first.filter((run) => run.state === "settled")).toHaveLength(4);
    expect(await p.store.previews.listUsageForReconciliation({ limit: 100, now: NOW })).toEqual([]);

    // No completion is needed for a missing row, failed request, or lost scheduled execution.
    const nextMinute = "2026-10-28T10:01:00.000Z";
    const second = await p.store.previews.listUsageForReconciliation({
      limit: 100,
      now: nextMinute,
    });
    expect(new Set([...first, ...second].map((run) => run.intervalId)).size).toBe(33);
    const retried = second.find((run) =>
      first.some((prior) => prior.intervalId === run.intervalId),
    );
    if (!retried) throw new Error("missing fact was not retried");
    expect(
      await p.db
        .prepare(
          "SELECT state,cpu_milliseconds,reconciliation_attempts,reconciliation_next_at FROM project_preview_usage_intervals WHERE preview_id=?1 AND interval_id=?2",
        )
        .bind(id, retried.intervalId)
        .first(),
    ).toEqual({
      state: "awaiting_provider",
      cpu_milliseconds: null,
      reconciliation_attempts: 2,
      reconciliation_next_at: "2026-10-28T10:03:00.000000Z",
    });
    const revision = first.find((run) => run.state === "settled");
    if (!revision) throw new Error("revision starved");
    expect(
      await p.db
        .prepare(
          "SELECT reconciliation_next_at FROM project_preview_usage_intervals WHERE preview_id=?1 AND interval_id=?2",
        )
        .bind(id, revision.intervalId)
        .first(),
    ).toEqual({ reconciliation_next_at: "2026-10-29T10:00:00.000000Z" });
    await p.store.previews.observeUsage({
      previewId: id,
      runtimeGeneration: retried.runtimeGeneration,
      intervalId: retried.intervalId,
      cpuMilliseconds: 1,
      observedAt: nextMinute,
      providerFactId: "b".repeat(64),
      now: nextMinute,
    });
    expect(
      await p.db
        .prepare(
          "SELECT state,reconciliation_attempts,reconciliation_next_at FROM project_preview_usage_intervals WHERE preview_id=?1 AND interval_id=?2",
        )
        .bind(id, retried.intervalId)
        .first(),
    ).toEqual({
      state: "settled",
      reconciliation_attempts: 0,
      reconciliation_next_at: "2026-10-28T10:06:00.000000Z",
    });
  } finally {
    await isolated.dispose();
  }
});

async function setup(testControl = control) {
  const p = await seedProductRuntimeFixture(testControl),
    db = testControl.core,
    sourceConnectionId = newUlid(),
    grantId = newUlid();
  await db.batch([
    db
      .prepare(
        "INSERT INTO credit_account(organization_id,monthly_micros,monthly_ends_at,onetime_micros,reserved_micros,overrun_micros,paid_until,paid_source,updated_at) VALUES(?1,100000000,'2026-12-01T00:00:00.000000Z',0,0,0,'2027-01-01T00:00:00.000000Z','manual',?2)",
      )
      .bind(p.organizationId, STORED_NOW),
    db
      .prepare(
        "INSERT INTO source_connections(organization_id,source_connection_id,project_id,billing_epoch_id,provider,external_repository_id,created_at) VALUES(?1,?2,?3,?4,'managed','fixture/repo',?5)",
      )
      .bind(p.organizationId, sourceConnectionId, p.projectId, p.billingEpochId, STORED_NOW),
    db
      .prepare(
        "INSERT INTO repository_grants(organization_id,grant_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at) VALUES(?1,?2,?3,?4,?5,'managed',NULL,'fixture/repo','fixture','repo','contents:read',?6)",
      )
      .bind(
        p.organizationId,
        grantId,
        p.projectId,
        p.billingEpochId,
        sourceConnectionId,
        STORED_NOW,
      ),
    db
      .prepare(
        "INSERT INTO project_source_bindings(organization_id,project_id,source_connection_id,provider,generation,commit_sha,updated_at) VALUES(?1,?2,?3,'managed',1,?4,?5)",
      )
      .bind(p.organizationId, p.projectId, sourceConnectionId, "a".repeat(40), STORED_NOW),
  ]);
  const store = createControlStore(testControl.bindings),
    scope = {
      organizationId: p.organizationId,
      projectId: p.projectId,
      principalId: "user:user_consent",
      environment: "prod" as const,
      now: NOW,
    };
  return { ...p, db, store, scope, sourceConnectionId, grantId };
}

it("creates exactly one recoverable identity per authorized environment and denies stale or foreign scope", async () => {
  const p = await setup();
  const candidates = await Promise.all([
    p.store.previews.ensure({
      ...p.scope,
      environmentId: p.prodEnvironmentId,
      previewId: newUlid(),
      capability: token(1),
    }),
    p.store.previews.ensure({
      ...p.scope,
      environmentId: p.prodEnvironmentId,
      previewId: newUlid(),
      capability: token(2),
    }),
  ]);
  expect(candidates[0]).toEqual(candidates[1]);
  const dev = await p.store.previews.ensure({
    ...p.scope,
    environment: "dev",
    environmentId: p.devEnvironmentId,
    previewId: newUlid(),
    capability: token(3),
  });
  expect(dev.preview.previewId).not.toBe(candidates[0]?.preview.previewId);
  expect((await p.store.previews.get(p.scope))?.capability).toEqual(candidates[0]?.capability);
  await expect(
    p.store.previews.get({ ...p.scope, principalId: "user:user_wrong" }),
  ).rejects.toThrow();
  await p.db
    .prepare("UPDATE credit_account SET paid_until=?2 WHERE organization_id=?1")
    .bind(p.organizationId, "2026-10-28T09:59:59.000000Z")
    .run();
  await expect(p.store.previews.get({ ...p.scope, environment: "dev" })).rejects.toThrow();
  expect(await p.store.previews.get(p.scope)).not.toBeNull();
});

it("orders accepted source changes, fences revoked grants, and preserves atomic billing and rotation", async () => {
  const p = await setup(),
    created = await p.store.previews.ensure({
      ...p.scope,
      environmentId: p.prodEnvironmentId,
      previewId: newUlid(),
      capability: token(4),
    }),
    id = created.preview.previewId;
  await p.db.batch(
    acceptedPreviewSourceStatements(p.db, {
      organizationId: p.organizationId,
      projectId: p.projectId,
      eventId: "commit-2",
      sourceConnectionId: p.sourceConnectionId,
      sourceGeneration: 1,
      commitSha: "b".repeat(40),
      now: NOW,
    }),
  );
  await p.db.batch(
    acceptedPreviewSourceStatements(p.db, {
      organizationId: p.organizationId,
      projectId: p.projectId,
      eventId: `seed:${p.sourceConnectionId}:1:${"a".repeat(40)}`,
      sourceConnectionId: p.sourceConnectionId,
      sourceGeneration: 1,
      commitSha: "a".repeat(40),
      now: NOW,
    }),
  );
  const pending = await p.store.previews.listProjectPendingSources({
    organizationId: p.organizationId,
    projectId: p.projectId,
  });
  expect(pending).toEqual([{ previewId: id, sequence: 2 }]);
  expect(await p.store.previews.listPendingSources({ limit: 100 })).toContainEqual({
    previewId: id,
    sequence: 2,
  });
  await p.store.previews.acknowledgeSource({ previewId: id, sequence: 1 });
  expect(await p.store.previews.listPendingSources({ limit: 100 })).toContainEqual({
    previewId: id,
    sequence: 2,
  });
  await p.store.previews.acknowledgeSource({ previewId: id, sequence: 2 });
  expect(
    (await p.store.previews.listPendingSources({ limit: 100 })).some(
      (item) => item.previewId === id,
    ),
  ).toBe(false);
  const found = await p.store.previews.resolveTokenHash({
    tokenHash: token(4).lookupSha256,
    now: NOW,
  });
  expect(found?.targetSource?.commitSha).toBe("b".repeat(40));
  if (!found) throw new Error("preview missing");
  const applied = await p.store.previews.recordAppliedSource({
    previewId: id,
    runtimeGeneration: found.runtimeGeneration,
    tokenGeneration: found.tokenGeneration,
    expectedRowVersion: found.rowVersion,
    source: found.targetSource,
    now: NOW,
  });
  expect(applied.appliedSource?.sequence).toBe(2);
  expect(
    await p.store.previews.readSource({
      previewId: id,
      runtimeGeneration: applied.runtimeGeneration,
      tokenGeneration: applied.tokenGeneration,
      sequence: 2,
      now: NOW,
    }),
  ).toMatchObject({ sourceConnectionId: p.sourceConnectionId });
  if (!applied.targetSource) throw new Error("source missing");
  const nativeJob = await p.store.previews.queueNativePreparation({
    fence: {
      previewId: id,
      runtimeGeneration: applied.runtimeGeneration,
      tokenGeneration: applied.tokenGeneration,
    },
    source: applied.targetSource,
    buildPlanSha256: "f".repeat(64),
    authProvider: "omh-native",
    now: NOW,
  });
  expect(nativeJob.state).toBe("pending");
  expect(await p.store.previews.listPendingNativePreparations({ limit: 1 })).toEqual([
    {
      operationId: nativeJob.operationId,
      previewId: id,
      sourceSequence: applied.targetSource.sequence,
      state: "pending",
    },
  ]);
  expect(
    await p.store.previews.listPendingNativePreparations({
      limit: 1,
      after: nativeJob.operationId,
    }),
  ).toEqual([]);
  expect(await p.store.previews.getNativePreparationCursor(undefined)).toBeNull();
  await p.store.previews.setNativePreparationCursor({
    expected: null,
    next: nativeJob.operationId,
  });
  expect(await p.store.previews.getNativePreparationCursor(undefined)).toBe(nativeJob.operationId);
  await expect(
    p.store.previews.setNativePreparationCursor({ expected: null, next: null }),
  ).rejects.toThrow();
  expect(await p.store.previews.getNativePreparationCursor(undefined)).toBe(nativeJob.operationId);
  await p.store.previews.setNativePreparationCursor({
    expected: nativeJob.operationId,
    next: null,
  });
  const claimed = await p.store.previews.claimNativePreparation({
    operationId: nativeJob.operationId,
    now: NOW,
  });
  expect(claimed.state).toBe("running");
  const fakeDeployment = await p.db
    .prepare("SELECT 1 FROM product_command_intents WHERE operation_id=?1")
    .bind(nativeJob.operationId)
    .first();
  expect(fakeDeployment).toBeNull();
  await p.store.previews.finishNativePreparation({
    operationId: nativeJob.operationId,
    outcome: "failed",
    errorCode: "NATIVE_PREPARE_UNAVAILABLE",
    now: NOW,
  });

  const priceTime = Date.parse("2026-10-28T08:00:00.000Z"),
    startsAt = Date.parse("2026-10-28T09:00:00.000Z");
  const card = parseRateCard(
    JSON.stringify({
      id: "cloudflare-preview-standard-3-2026-11-09-v1",
      effective_from: "2026-10-28T09:00:00.000Z",
      rates: [
        {
          meter: "preview.container.standard-3",
          unit: "usd_pico",
          units_per_charge: "7000000",
          provider_cost_micros: "7",
          credit_micros: "2300",
        },
      ],
    }),
  );
  await applyPlan(p.db, planPublish(await readState(p.db), card, priceTime));
  await applyPlan(
    p.db,
    planActivate(
      await readState(p.db),
      { meter: "preview.container.standard-3", cardId: card.id, startsAtMs: startsAt },
      priceTime,
    ),
  );

  // A preview may reuse an existing environment mail key before any deployment installed
  // its project-level mail metadata. The startup reservation must initialize it atomically.
  const mailCipher = createEnvironmentSecretCipherKeyring({
    primaryKeyBase64: btoa("m".repeat(32)),
    currentKeyVersion: 1,
    crypto,
  });
  const sealedMail = await mailCipher.encrypt({
    organizationId: parseUlid(p.organizationId),
    projectId: parseUlid(p.projectId),
    environmentId: parseUlid(p.prodEnvironmentId),
    name: "OHMYHOST_MAIL_KEY",
    value: "p".repeat(43),
  });
  const mailDomain = newUlid();
  await p.db.batch([
    p.db
      .prepare(
        "INSERT INTO environment_secrets(organization_id,project_id,environment_id,name,ciphertext,nonce,value_sha256,key_version,revision,created_at,updated_at) VALUES(?1,?2,?3,'OHMYHOST_MAIL_KEY',?4,?5,?6,1,1,?7,?7)",
      )
      .bind(
        p.organizationId,
        p.projectId,
        p.prodEnvironmentId,
        sealedMail.ciphertext,
        sealedMail.nonce,
        sealedMail.valueSha256,
        STORED_NOW,
      ),
    p.db
      .prepare(
        "INSERT INTO workspace_mail_domains(domain_id,organization_id,domain,registrable_domain,custody_organization_id,custody_project_id,custody_environment_id,status,sending_status,configured_at) VALUES(?1,?2,'mail.example.test','example.test',?2,?3,?4,'active','ready',?5)",
      )
      .bind(mailDomain, p.organizationId, p.projectId, p.prodEnvironmentId, STORED_NOW),
    p.db
      .prepare(
        "INSERT INTO project_mail_domain_bindings(organization_id,project_id,environment_id,mail_domain_id,revision,state,sending,legacy,sender_addresses,configured_at,updated_at) VALUES(?1,?2,?3,?4,1,'active',1,1,'[]',?5,?5)",
      )
      .bind(p.organizationId, p.projectId, p.prodEnvironmentId, mailDomain, STORED_NOW),
  ]);
  const mailMetadata = () =>
    p.db
      .prepare(
        "SELECT (SELECT count(*) FROM mail_gateway_keys WHERE organization_id=?1 AND project_id=?2) keys, (SELECT count(*) FROM mail_reputation_states WHERE organization_id=?1 AND project_id=?2) reputation",
      )
      .bind(p.organizationId, p.projectId)
      .first();
  expect(await mailMetadata()).toEqual({ keys: 0, reputation: 0 });
  await expect(
    p.store.previews.reserveUsage({
      previewId: id,
      runtimeGeneration: applied.runtimeGeneration + 1,
      tokenGeneration: applied.tokenGeneration,
      expectedRowVersion: applied.rowVersion,
      intervalId: "stale-mail",
      applicationId: "a".repeat(32),
      seconds: 60,
      holdSequence: 1,
      start: true,
      now: NOW,
    }),
  ).rejects.toThrow("preview_version_conflict");
  expect(await mailMetadata()).toEqual({ keys: 0, reputation: 0 });
  await p.db
    .prepare("UPDATE credit_account SET monthly_micros=0 WHERE organization_id=?1")
    .bind(p.organizationId)
    .run();
  await expect(
    p.store.previews.reserveUsage({
      previewId: id,
      runtimeGeneration: applied.runtimeGeneration,
      tokenGeneration: applied.tokenGeneration,
      expectedRowVersion: applied.rowVersion,
      intervalId: "unfunded-mail",
      applicationId: "a".repeat(32),
      seconds: 60,
      holdSequence: 1,
      start: true,
      now: NOW,
    }),
  ).rejects.toThrow("guard_insufficient_credits");
  expect(await mailMetadata()).toEqual({ keys: 0, reputation: 0 });
  await p.db
    .prepare("UPDATE credit_account SET monthly_micros=100000000 WHERE organization_id=?1")
    .bind(p.organizationId)
    .run();

  const lostReply = () =>
    createControlStore({ ...control.bindings, CONTROL_CORE: losingWriteResponses(p.db, 1) })
      .previews;
  const hold = await lostReply().reserveUsage({
    previewId: id,
    runtimeGeneration: applied.runtimeGeneration,
    tokenGeneration: applied.tokenGeneration,
    expectedRowVersion: applied.rowVersion,
    intervalId: "first",
    applicationId: "a".repeat(32),
    seconds: 60,
    holdSequence: 1,
    start: true,
    now: NOW,
  });
  expect(hold.preview.state).toBe("starting");
  expect(await mailMetadata()).toEqual({ keys: 1, reputation: 1 });
  expect(
    await p.db
      .prepare(
        "SELECT k.key_version,k.key_sha256=s.value_sha256 AS same_key,s.revision FROM mail_gateway_keys k JOIN environment_secrets s ON s.organization_id=k.organization_id AND s.project_id=k.project_id AND s.environment_id=?3 AND s.name='OHMYHOST_MAIL_KEY' WHERE k.organization_id=?1 AND k.project_id=?2",
      )
      .bind(p.organizationId, p.projectId, p.prodEnvironmentId)
      .first(),
  ).toEqual({ key_version: 1, same_key: 1, revision: 1 });
  expect(
    await p.db
      .prepare(
        "SELECT ciphertext=?4 AS same_cipher,nonce=?5 AS same_nonce,value_sha256=?6 AS same_digest FROM environment_secrets WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND name='OHMYHOST_MAIL_KEY'",
      )
      .bind(
        p.organizationId,
        p.projectId,
        p.prodEnvironmentId,
        sealedMail.ciphertext,
        sealedMail.nonce,
        sealedMail.valueSha256,
      )
      .first(),
  ).toEqual({ same_cipher: 1, same_nonce: 1, same_digest: 1 });
  expect(
    await p.db
      .prepare(
        "SELECT state,warmup_started_at,version FROM mail_reputation_states WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(p.organizationId, p.projectId)
      .first(),
  ).toEqual({ state: "active", warmup_started_at: STORED_NOW, version: 1 });

  // A later preview in another environment must not reset an existing suspension.
  const devMail = await mailCipher.encrypt({
    organizationId: parseUlid(p.organizationId),
    projectId: parseUlid(p.projectId),
    environmentId: parseUlid(p.devEnvironmentId),
    name: "OHMYHOST_MAIL_KEY",
    value: "d".repeat(43),
  });
  const mailRequest = newUlid();
  const mailEvent = crypto.randomUUID();
  await p.db.batch([
    p.db
      .prepare(
        "INSERT INTO environment_secrets(organization_id,project_id,environment_id,name,ciphertext,nonce,value_sha256,key_version,revision,created_at,updated_at) VALUES(?1,?2,?3,'OHMYHOST_MAIL_KEY',?4,?5,?6,1,1,?7,?7)",
      )
      .bind(
        p.organizationId,
        p.projectId,
        p.devEnvironmentId,
        devMail.ciphertext,
        devMail.nonce,
        devMail.valueSha256,
        STORED_NOW,
      ),
    p.db
      .prepare(
        "INSERT INTO mail_send_requests(request_id,organization_id,project_id,idempotency_key,request_sha256,recipient_sha256,content_sha256,requested_at,updated_at) VALUES(?1,?2,?3,'preview-reputation',zeroblob(32),zeroblob(32),zeroblob(32),?4,?4)",
      )
      .bind(mailRequest, p.organizationId, p.projectId, STORED_NOW),
    p.db
      .prepare(
        "INSERT INTO mail_send_events(provider_event_id,organization_id,project_id,request_id,provider_message_id,event_type,outcome,detail_sha256,occurred_at,sent_at,received_at,reputation_kind) VALUES(?1,?2,?3,?4,'preview-event','Bounce','bounced',zeroblob(32),?5,?5,?5,'hard_bounce')",
      )
      .bind(mailEvent, p.organizationId, p.projectId, mailRequest, STORED_NOW),
    p.db
      .prepare(
        "UPDATE mail_reputation_states SET state='suspended',suspended_at=?3,suspension_reason='bounce_rate',triggering_event_id=?4,version=version+1,updated_at=?3 WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(p.organizationId, p.projectId, STORED_NOW, mailEvent),
  ]);
  const reputation = () =>
    p.db
      .prepare(
        "SELECT state,warmup_started_at,suspended_at,suspension_reason,triggering_event_id,version,updated_at FROM mail_reputation_states WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(p.organizationId, p.projectId)
      .first();
  const suspendedReputation = await reputation();
  const devPreview = await p.store.previews.ensure({
    ...p.scope,
    environment: "dev",
    environmentId: p.devEnvironmentId,
    previewId: newUlid(),
    capability: token(50),
  });
  const devHold = await p.store.previews.reserveUsage({
    previewId: devPreview.preview.previewId,
    runtimeGeneration: devPreview.preview.runtimeGeneration,
    tokenGeneration: devPreview.preview.tokenGeneration,
    expectedRowVersion: devPreview.preview.rowVersion,
    intervalId: "suspended-mail",
    applicationId: "b".repeat(32),
    seconds: 60,
    holdSequence: 1,
    start: true,
    now: NOW,
  });
  expect(await reputation()).toEqual(suspendedReputation);
  expect(
    await p.db
      .prepare(
        "SELECT key_sha256=?3 AS same_key FROM mail_gateway_keys WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(p.organizationId, p.projectId, sealedMail.valueSha256)
      .first(),
  ).toEqual({ same_key: 1 });
  await p.store.previews.closeUsage({
    previewId: devPreview.preview.previewId,
    runtimeGeneration: devHold.preview.runtimeGeneration,
    intervalId: "suspended-mail",
    activeMilliseconds: 0,
    containerStartAttempted: false,
    now: NOW,
  });
  await p.store.previews.recordStopped({
    previewId: devPreview.preview.previewId,
    runtimeGeneration: devHold.preview.runtimeGeneration,
    tokenGeneration: devHold.preview.tokenGeneration,
    now: NOW,
  });

  const ready = await p.store.previews.recordState({
    previewId: id,
    runtimeGeneration: hold.preview.runtimeGeneration,
    tokenGeneration: hold.preview.tokenGeneration,
    expectedRowVersion: hold.preview.rowVersion,
    state: "ready",
    now: NOW,
  });
  expect(ready.state).toBe("ready");
  await expect(
    p.store.previews.recordState({
      previewId: id,
      runtimeGeneration: ready.runtimeGeneration,
      tokenGeneration: ready.tokenGeneration,
      expectedRowVersion: ready.rowVersion,
      state: "sleeping",
      now: NOW,
    }),
  ).rejects.toThrow("preview_usage_fence");
  const active = await p.store.previews.renewActivity({
    previewId: id,
    runtimeGeneration: hold.preview.runtimeGeneration,
    tokenGeneration: hold.preview.tokenGeneration,
    expectedRowVersion: ready.rowVersion,
    occurredAt: "2026-10-28T10:00:01.000Z",
    now: "2026-10-28T10:00:01.000Z",
  });
  expect(active.rowVersion).toBeGreaterThan(hold.preview.rowVersion);
  let raced = false;
  const racingStore = createControlStore({
    ...control.bindings,
    CONTROL_CORE: {
      prepare: (sql) => p.db.prepare(sql),
      batch: async (statements) => {
        if (!raced) {
          raced = true;
          // A source/activity write lands after reserveUsage reads its fresh snapshot.
          await p.db
            .prepare("UPDATE project_previews SET row_version=row_version+1 WHERE preview_id=?1")
            .bind(id)
            .run();
        }
        return p.db.batch(statements);
      },
    },
  });
  const renewal = await racingStore.previews.reserveUsage({
    previewId: id,
    runtimeGeneration: hold.preview.runtimeGeneration,
    tokenGeneration: hold.preview.tokenGeneration,
    expectedRowVersion: hold.preview.rowVersion,
    intervalId: "first",
    applicationId: "a".repeat(32),
    seconds: 60,
    holdSequence: 2,
    start: false,
    now: NOW,
  });
  expect(renewal.preview.runtimeGeneration).toBe(hold.preview.runtimeGeneration);
  expect(renewal.preview.rowVersion).toBeGreaterThan(active.rowVersion);
  await expect(
    p.store.previews.reserveUsage({
      previewId: id,
      runtimeGeneration: hold.preview.runtimeGeneration,
      tokenGeneration: hold.preview.tokenGeneration + 1,
      expectedRowVersion: hold.preview.rowVersion,
      intervalId: "first",
      applicationId: "a".repeat(32),
      seconds: 60,
      holdSequence: 3,
      start: false,
      now: NOW,
    }),
  ).rejects.toThrow("preview_version_conflict");
  const reservation = await p.db
    .prepare("SELECT count(*) n FROM credit_reservation WHERE organization_id=?1")
    .bind(p.organizationId)
    .first<{ n: number }>();
  expect(reservation?.n).toBe(1);
  expect(renewal.quotedMicros).toBe(hold.quotedMicros * 2);
  await expect(
    p.store.previews.reserveUsage({
      previewId: id,
      runtimeGeneration: hold.preview.runtimeGeneration,
      tokenGeneration: hold.preview.tokenGeneration,
      expectedRowVersion: hold.preview.rowVersion,
      intervalId: "first",
      applicationId: "b".repeat(32),
      seconds: 60,
      holdSequence: 3,
      start: false,
      now: NOW,
    }),
  ).rejects.toThrow("preview_usage_identity_conflict");
  const low = await setup();
  await low.db
    .prepare("UPDATE credit_account SET monthly_micros=1500000 WHERE organization_id=?1")
    .bind(low.organizationId)
    .run();
  const collidingMail = await mailCipher.encrypt({
    organizationId: parseUlid(low.organizationId),
    projectId: parseUlid(low.projectId),
    environmentId: parseUlid(low.prodEnvironmentId),
    name: "OHMYHOST_MAIL_KEY",
    value: "p".repeat(43),
  });
  const lowDomain = newUlid();
  await low.db.batch([
    low.db
      .prepare(
        "INSERT INTO environment_secrets(organization_id,project_id,environment_id,name,ciphertext,nonce,value_sha256,key_version,revision,created_at,updated_at) VALUES(?1,?2,?3,'OHMYHOST_MAIL_KEY',?4,?5,?6,1,1,?7,?7)",
      )
      .bind(
        low.organizationId,
        low.projectId,
        low.prodEnvironmentId,
        collidingMail.ciphertext,
        collidingMail.nonce,
        collidingMail.valueSha256,
        STORED_NOW,
      ),
    low.db
      .prepare(
        "INSERT INTO workspace_mail_domains(domain_id,organization_id,domain,registrable_domain,custody_organization_id,custody_project_id,custody_environment_id,status,sending_status,configured_at) VALUES(?1,?2,'other.example.test','example.test',?2,?3,?4,'active','ready',?5)",
      )
      .bind(lowDomain, low.organizationId, low.projectId, low.prodEnvironmentId, STORED_NOW),
    low.db
      .prepare(
        "INSERT INTO project_mail_domain_bindings(organization_id,project_id,environment_id,mail_domain_id,revision,state,sending,legacy,sender_addresses,configured_at,updated_at) VALUES(?1,?2,?3,?4,1,'active',1,1,'[]',?5,?5)",
      )
      .bind(low.organizationId, low.projectId, low.prodEnvironmentId, lowDomain, STORED_NOW),
  ]);
  const lowPreview = await low.store.previews.ensure({
    ...low.scope,
    environmentId: low.prodEnvironmentId,
    previewId: newUlid(),
    capability: token(9),
  });
  const lowHold = await low.store.previews.reserveUsage({
    previewId: lowPreview.preview.previewId,
    runtimeGeneration: lowPreview.preview.runtimeGeneration,
    tokenGeneration: lowPreview.preview.tokenGeneration,
    expectedRowVersion: lowPreview.preview.rowVersion,
    intervalId: "low-credit",
    applicationId: "a".repeat(32),
    seconds: 60,
    holdSequence: 1,
    start: true,
    now: NOW,
  });
  expect(
    await low.db
      .prepare(
        "SELECT (SELECT count(*) FROM mail_gateway_keys WHERE organization_id=?1 AND project_id=?2) keys, (SELECT count(*) FROM mail_reputation_states WHERE organization_id=?1 AND project_id=?2) reputation",
      )
      .bind(low.organizationId, low.projectId)
      .first(),
  ).toEqual({ keys: 0, reputation: 0 });
  await expect(
    low.store.previews.reserveUsage({
      previewId: lowPreview.preview.previewId,
      runtimeGeneration: lowHold.preview.runtimeGeneration,
      tokenGeneration: lowHold.preview.tokenGeneration,
      expectedRowVersion: lowHold.preview.rowVersion,
      intervalId: "low-credit",
      applicationId: "a".repeat(32),
      seconds: 60,
      holdSequence: 2,
      start: false,
      now: NOW,
    }),
  ).rejects.toThrow();
  const remaining = await low.db
    .prepare("SELECT amount_micros FROM credit_reservation WHERE organization_id=?1")
    .bind(low.organizationId)
    .first<{ amount_micros: number }>();
  expect(remaining?.amount_micros).toBe(lowHold.quotedMicros);
  await low.store.previews.closeUsage({
    previewId: lowPreview.preview.previewId,
    runtimeGeneration: lowHold.preview.runtimeGeneration,
    intervalId: "low-credit",
    activeMilliseconds: 0,
    containerStartAttempted: false,
    now: NOW,
  });
  expect(
    await low.db
      .prepare(
        "SELECT state,cpu_milliseconds,charged_micros,reconciliation_next_at FROM project_preview_usage_intervals WHERE preview_id=?1",
      )
      .bind(lowPreview.preview.previewId)
      .first(),
  ).toEqual({
    state: "unstarted",
    cpu_milliseconds: null,
    charged_micros: 0,
    reconciliation_next_at: null,
  });
  expect(
    await low.store.previews.recordStopped({
      previewId: lowPreview.preview.previewId,
      runtimeGeneration: lowHold.preview.runtimeGeneration,
      tokenGeneration: lowHold.preview.tokenGeneration,
      now: NOW,
    }),
  ).toMatchObject({ state: "cold" });

  const rotation = await p.store.previews.rotate({
    ...p.scope,
    previewId: id,
    expectedRowVersion: renewal.preview.rowVersion,
    expectedTokenGeneration: hold.preview.tokenGeneration,
    requestId: "rotate-1",
    capability: token(5, 2),
  });
  expect(rotation.preview.retirement).toBe("rotating");
  expect(
    await p.store.previews.readSource({
      previewId: id,
      runtimeGeneration: hold.preview.runtimeGeneration,
      tokenGeneration: hold.preview.tokenGeneration,
      sequence: 2,
      now: NOW,
    }),
  ).toBeNull();
  const fence = {
    previewId: id,
    runtimeGeneration: rotation.preview.runtimeGeneration,
    tokenGeneration: rotation.preview.tokenGeneration,
    now: NOW,
  };
  await expect(p.store.previews.confirmRotation(fence)).rejects.toThrow();
  await lostReply().closeUsage({
    previewId: id,
    runtimeGeneration: hold.preview.runtimeGeneration,
    intervalId: "first",
    activeMilliseconds: 1000,
    containerStartAttempted: true,
    now: NOW,
  });
  const wallCharge = Math.ceil((1000 * 21120 * 2300) / 7000000);
  expect(
    await p.db
      .prepare(
        "SELECT state,cpu_milliseconds,charged_micros FROM project_preview_usage_intervals WHERE preview_id=?1 AND interval_id='first'",
      )
      .bind(id)
      .first(),
  ).toMatchObject({
    state: "awaiting_provider",
    cpu_milliseconds: null,
    charged_micros: wallCharge,
  });
  expect(
    await p.db
      .prepare(
        "SELECT -sum(delta_micros) charged FROM credit_log WHERE organization_id=?1 AND kind='usage'",
      )
      .bind(p.organizationId)
      .first(),
  ).toMatchObject({ charged: wallCharge });
  await p.store.previews.closeUsage({
    previewId: id,
    runtimeGeneration: hold.preview.runtimeGeneration,
    intervalId: "first",
    activeMilliseconds: 1000,
    containerStartAttempted: true,
    now: NOW,
  });
  // Cleanup may complete while CPU evidence remains unknown.
  await p.store.previews.confirmRotation(fence);
  expect(
    (await p.store.previews.listUsageForReconciliation({ limit: 10, now: NOW })).some(
      (x) => x.previewId === id && x.intervalId === "first",
    ),
  ).toBe(true);
  const first = await lostReply().observeUsage({
    previewId: id,
    runtimeGeneration: hold.preview.runtimeGeneration,
    intervalId: "first",
    cpuMilliseconds: 500,
    providerFactId: "a".repeat(64),
    observedAt: NOW,
    now: NOW,
  });
  expect(first.chargedMicros).toBe(Math.ceil(((1000 * 21120 + 500 * 20000) * 2300) / 7000000));
  expect(
    await p.store.previews.observeUsage({
      previewId: id,
      runtimeGeneration: hold.preview.runtimeGeneration,
      intervalId: "first",
      cpuMilliseconds: 500,
      providerFactId: "a".repeat(64),
      observedAt: NOW,
      now: NOW,
    }),
  ).toEqual(first);
  const upward = await p.store.previews.observeUsage({
    previewId: id,
    runtimeGeneration: hold.preview.runtimeGeneration,
    intervalId: "first",
    cpuMilliseconds: 750,
    providerFactId: "b".repeat(64),
    observedAt: NOW,
    now: NOW,
  });
  expect(upward.chargedMicros).toBe(Math.ceil(((1000 * 21120 + 750 * 20000) * 2300) / 7000000));
  const lower = await p.store.previews.observeUsage({
    previewId: id,
    runtimeGeneration: hold.preview.runtimeGeneration,
    intervalId: "first",
    cpuMilliseconds: 200,
    providerFactId: "c".repeat(64),
    observedAt: NOW,
    now: NOW,
  });
  expect(lower.chargedMicros).toBe(upward.chargedMicros);
  expect(
    await p.db
      .prepare(
        "SELECT -sum(delta_micros) charged FROM credit_log WHERE organization_id=?1 AND kind='usage'",
      )
      .bind(p.organizationId)
      .first(),
  ).toMatchObject({ charged: upward.chargedMicros });
  const confirmed = await p.store.previews.get(p.scope);
  if (!confirmed) throw new Error("preview missing");
  expect(confirmed.preview.authGeneration).toBe(created.preview.authGeneration + 1);
  const replay = await p.store.previews.rotate({
    ...p.scope,
    previewId: id,
    expectedRowVersion: confirmed.preview.rowVersion,
    expectedTokenGeneration: confirmed.preview.tokenGeneration,
    requestId: "rotate-1",
    capability: token(6, 3),
  });
  expect(replay.capability).toEqual(rotation.capability);
  expect(
    await p.store.previews.resolveTokenHash({ tokenHash: token(4).lookupSha256, now: NOW }),
  ).toBeNull();
  await p.db
    .prepare(
      "INSERT INTO repository_grant_revocations(organization_id,project_id,grant_id,revocation_id,revoked_at,reason) VALUES(?1,?2,?3,?4,?5,'permission_revoked')",
    )
    .bind(p.organizationId, p.projectId, p.grantId, newUlid(), STORED_NOW)
    .run();
  expect(
    await p.store.previews.authorizeRuntime({
      previewId: id,
      runtimeGeneration: confirmed.preview.runtimeGeneration,
      tokenGeneration: confirmed.preview.tokenGeneration,
      now: NOW,
    }),
  ).toBeNull();
});

it("keeps revoked scopes fenced through durable cleanup and resumes the same paid preview URL", async () => {
  const p = await setup();
  const scope = { ...p.scope, environment: "dev" as const };
  const created = await p.store.previews.ensure({
    ...scope,
    environmentId: p.devEnvironmentId,
    previewId: newUlid(),
    capability: token(7),
  });
  const id = created.preview.previewId;
  const initial = await p.store.previews.resolveTokenHash({
    tokenHash: token(7).lookupSha256,
    now: NOW,
  });
  if (!initial?.targetSource) throw new Error("source missing");
  const applied = await p.store.previews.recordAppliedSource({
    previewId: id,
    runtimeGeneration: initial.runtimeGeneration,
    tokenGeneration: initial.tokenGeneration,
    expectedRowVersion: initial.rowVersion,
    source: initial.targetSource,
    now: NOW,
  });
  await p.store.previews.recordBackup({
    previewId: id,
    runtimeGeneration: applied.runtimeGeneration,
    tokenGeneration: applied.tokenGeneration,
    expectedRowVersion: applied.rowVersion,
    backup: {
      handle: "backup-one",
      source: applied.targetSource,
      expiresAt: "2026-11-27T10:00:00.000Z",
    },
    now: NOW,
  });
  await p.db.batch(
    acceptedPreviewSourceStatements(p.db, {
      organizationId: p.organizationId,
      projectId: p.projectId,
      eventId: "later-source",
      sourceConnectionId: p.sourceConnectionId,
      sourceGeneration: 1,
      commitSha: "b".repeat(40),
      now: "2026-10-29T10:00:00.000Z",
    }),
  );
  const afterSave = await p.store.previews.resolveTokenHash({
    tokenHash: token(7).lookupSha256,
    now: "2026-10-29T10:00:00.000Z",
  });
  expect(afterSave?.state).toBe("cold");
  expect(Date.parse(afterSave?.backup?.expiresAt ?? "")).toBe(
    Date.parse("2026-11-28T10:00:00.000Z"),
  );
  if (!afterSave) throw new Error("preview missing");
  await p.store.previews.claimExpiredBackup({
    previewId: id,
    runtimeGeneration: afterSave.runtimeGeneration,
    tokenGeneration: afterSave.tokenGeneration,
    expectedRowVersion: afterSave.rowVersion,
    now: "2026-11-29T10:00:00.000Z",
  });
  const pendingBackup = (
    await p.store.previews.listCleanupCandidates({ limit: 100, now: "2026-11-29T10:00:00.000Z" })
  ).find((c) => c.previewId === id);
  expect(pendingBackup?.reason).toBe("backup_cleanup");
  const cleanupFence = {
    previewId: id,
    runtimeGeneration: afterSave.runtimeGeneration,
    tokenGeneration: afterSave.tokenGeneration,
    now: "2026-11-29T10:00:00.000Z",
  };
  const queued = await p.store.previews.listBackupCleanup(cleanupFence);
  expect(queued).toHaveLength(1);
  if (!queued[0]) throw new Error("backup cleanup missing");
  await p.store.previews.acknowledgeBackupCleanup({ ...cleanupFence, ...queued[0] });
  await p.db
    .prepare("UPDATE credit_account SET paid_until=?2 WHERE organization_id=?1")
    .bind(p.organizationId, "2026-10-28T09:59:59.000000Z")
    .run();
  const due = (await p.store.previews.listCleanupCandidates({ limit: 100, now: NOW })).find(
    (c) => c.previewId === id,
  );
  expect(due?.reason).toBe("entitlement");
  if (!due) throw new Error("cleanup missing");
  const claim = await p.store.previews.claimScopeCleanup({
    previewId: id,
    expectedRowVersion: due.rowVersion,
    now: NOW,
  });
  expect(claim.retirement).toBe("destroying");
  await p.store.previews.finishScopeCleanup({
    previewId: id,
    runtimeGeneration: claim.runtimeGeneration,
    tokenGeneration: claim.tokenGeneration,
    deletedBackupHandle: null,
    now: NOW,
  });
  const suspended = await p.store.previews.getCleanupState({ previewId: id });
  expect(suspended?.retirement).toBe("suspended");
  expect(
    await p.store.previews.resolveTokenHash({ tokenHash: token(7).lookupSha256, now: NOW }),
  ).toBeNull();
  await p.db
    .prepare(
      "UPDATE credit_account SET paid_until='2027-01-01T00:00:00.000000Z' WHERE organization_id=?1",
    )
    .bind(p.organizationId)
    .run();
  const resumable = (await p.store.previews.listCleanupCandidates({ limit: 100, now: NOW })).find(
    (c) => c.previewId === id,
  );
  expect(resumable?.reason).toBe("resume");
  if (!resumable) throw new Error("resume missing");
  await p.store.previews.resumeSuspended({
    previewId: id,
    expectedRowVersion: resumable.rowVersion,
    now: NOW,
  });
  expect((await p.store.previews.get(scope))?.capability.lookupSha256).toBe(token(7).lookupSha256);
  await p.db
    .prepare(
      "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE organization_id=?1 AND project_id=?2",
    )
    .bind(p.organizationId, p.projectId)
    .run();
  const deleted = (await p.store.previews.listCleanupCandidates({ limit: 100, now: NOW })).find(
    (c) => c.previewId === id,
  );
  expect(deleted?.reason).toBe("scope");
  if (!deleted) throw new Error("retirement missing");
  const final = await p.store.previews.claimScopeCleanup({
    previewId: id,
    expectedRowVersion: deleted.rowVersion,
    now: NOW,
  });
  await p.store.previews.finishScopeCleanup({
    previewId: id,
    runtimeGeneration: final.runtimeGeneration,
    tokenGeneration: final.tokenGeneration,
    deletedBackupHandle: null,
    now: NOW,
  });
  const retired = await p.db
    .prepare(
      "SELECT retirement,token_lookup_sha256,token_ciphertext FROM project_previews WHERE preview_id=?1",
    )
    .bind(id)
    .first<{ retirement: string; token_lookup_sha256: unknown; token_ciphertext: unknown }>();
  expect(retired).toEqual({
    retirement: "retired",
    token_lookup_sha256: null,
    token_ciphertext: null,
  });
});

// The other cases exercise managed saves; a null GitHub head and a stale verified delivery need separate coverage.
it("observes a new GitHub project's default branch and rejects an overtaken push observation", async () => {
  const p = await setup(),
    connection = newUlid(),
    grant = newUlid(),
    previewId = newUlid();
  await p.db.batch([
    p.db
      .prepare(
        "INSERT INTO source_connections(organization_id,source_connection_id,project_id,billing_epoch_id,provider,external_repository_id,created_at) VALUES(?1,?2,?3,?4,'github','123',?5)",
      )
      .bind(p.organizationId, connection, p.projectId, p.billingEpochId, STORED_NOW),
    p.db
      .prepare(
        "INSERT INTO repository_grants(organization_id,grant_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at) VALUES(?1,?2,?3,?4,?5,'github','456','123','owner','repo','contents:read',?6)",
      )
      .bind(p.organizationId, grant, p.projectId, p.billingEpochId, connection, STORED_NOW),
    p.db
      .prepare(
        "UPDATE project_source_bindings SET source_connection_id=?3,provider='github',generation=2,commit_sha=NULL,updated_at=?4 WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(p.organizationId, p.projectId, connection, STORED_NOW),
  ]);
  await p.store.previews.ensure({
    ...p.scope,
    environmentId: p.prodEnvironmentId,
    previewId,
    capability: token(8),
  });
  const candidate = await p.store.previews.readInitialGithubCandidate(p.scope);
  if (!candidate) throw new Error("candidate missing");
  expect(candidate.branchRef).toBeNull();
  const base = {
    sourceConnectionId: connection,
    sourceGeneration: 2,
    expectedSequence: candidate.expectedSequence,
    branchRef: "refs/heads/main",
    configGeneration: null,
    observedDefaultBranch: "refs/heads/main",
  };
  const lostReply = () =>
    createControlStore({ ...control.bindings, CONTROL_CORE: losingWriteResponses(p.db, 1) })
      .previews;
  expect(
    await p.store.previews.acceptInitialGithubSource({
      ...p.scope,
      ...base,
      observedHead: "c".repeat(40),
    }),
  ).toEqual({ sequence: 1, accepted: true });
  expect((await p.store.previews.get(p.scope))?.preview.targetSource?.commitSha).toBe(
    "c".repeat(40),
  );
  const inboxEventId = newUlid(),
    claimId = newUlid(),
    payload = {
      installationId: "456",
      repositoryId: "123",
      repositoryFullName: "owner/repo",
      ref: "refs/heads/main",
      commitSha: "d".repeat(40),
      deleted: false,
    };
  await p.db
    .prepare(
      "INSERT INTO webhook_inbox(inbox_event_id,provider,external_event_id,event_type,payload,body_sha256,received_at,state,attempt_count,max_attempts,available_at,claim_id,claimed_at,lease_expires_at) VALUES(?1,'github',?2,'push',?3,?4,?5,'processing',1,5,?5,?6,?5,'2026-10-28T10:10:00.000000Z')",
    )
    .bind(
      inboxEventId,
      crypto.randomUUID(),
      JSON.stringify(payload),
      new Uint8Array(32),
      STORED_NOW,
      claimId,
    )
    .run();
  const candidates = await p.store.previews.readGithubCandidates({
    inboxEventId,
    claimId,
    now: NOW,
  });
  expect(candidates).toHaveLength(1);
  const c = candidates[0];
  if (!c) throw new Error("push candidate missing");
  expect(
    await p.store.previews.acceptGithubSource({
      inboxEventId,
      claimId,
      organizationId: p.organizationId,
      projectId: p.projectId,
      sourceConnectionId: c.sourceConnectionId,
      sourceGeneration: c.sourceGeneration,
      expectedSequence: c.expectedSequence,
      branchRef: payload.ref,
      configGeneration: c.configGeneration,
      observedDefaultBranch: payload.ref,
      observedHead: payload.commitSha,
      now: NOW,
    }),
  ).toEqual({ sequence: 2, accepted: true });
  const lateId = newUlid(),
    lateClaim = newUlid(),
    late = { ...payload, commitSha: "e".repeat(40) };
  await p.db
    .prepare(
      "INSERT INTO webhook_inbox(inbox_event_id,provider,external_event_id,event_type,payload,body_sha256,received_at,state,attempt_count,max_attempts,available_at,claim_id,claimed_at,lease_expires_at) VALUES(?1,'github',?2,'push',?3,?4,?5,'processing',1,5,?5,?6,?5,'2026-10-28T10:10:00.000000Z')",
    )
    .bind(
      lateId,
      crypto.randomUUID(),
      JSON.stringify(late),
      new Uint8Array(32),
      STORED_NOW,
      lateClaim,
    )
    .run();
  await expect(
    p.store.previews.acceptGithubSource({
      inboxEventId: lateId,
      claimId: lateClaim,
      organizationId: p.organizationId,
      projectId: p.projectId,
      sourceConnectionId: c.sourceConnectionId,
      sourceGeneration: c.sourceGeneration,
      expectedSequence: c.expectedSequence,
      branchRef: late.ref,
      configGeneration: c.configGeneration,
      observedDefaultBranch: late.ref,
      observedHead: late.commitSha,
      now: NOW,
    }),
  ).rejects.toThrow("preview_github_head_changed");
  const preview = await p.store.previews.get(p.scope);
  expect(preview?.preview.targetSource?.commitSha).toBe(payload.commitSha);
  expect(preview?.preview.targetSource?.sequence).toBe(2);
  // A new current-head observation permits the rejected delivery to advance once,
  // even when the database commits but its acknowledgement is lost.
  const refreshed = (
    await p.store.previews.readGithubCandidates({
      inboxEventId: lateId,
      claimId: lateClaim,
      now: NOW,
    })
  )[0];
  if (!refreshed) throw new Error("refreshed push candidate missing");
  expect(refreshed.expectedSequence).toBe(2);
  expect(
    await lostReply().acceptGithubSource({
      inboxEventId: lateId,
      claimId: lateClaim,
      organizationId: p.organizationId,
      projectId: p.projectId,
      sourceConnectionId: refreshed.sourceConnectionId,
      sourceGeneration: refreshed.sourceGeneration,
      expectedSequence: refreshed.expectedSequence,
      branchRef: late.ref,
      configGeneration: refreshed.configGeneration,
      observedDefaultBranch: late.ref,
      observedHead: late.commitSha,
      now: NOW,
    }),
  ).toEqual({ sequence: 3, accepted: false });
  expect((await p.store.previews.get(p.scope))?.preview.targetSource?.commitSha).toBe(
    late.commitSha,
  );
  // A lost fast-path notification is recovered by a fresh branch observation on open.
  // Returning to an earlier commit still receives a new sequence, including a force push.
  expect(
    await lostReply().acceptInitialGithubSource({
      ...p.scope,
      ...base,
      expectedSequence: 3,
      observedHead: "c".repeat(40),
    }),
  ).toEqual({ sequence: 4, accepted: false });
  expect((await p.store.previews.get(p.scope))?.preview.targetSource?.commitSha).toBe(
    "c".repeat(40),
  );
  await expect(
    p.store.previews.acceptInitialGithubSource({
      ...p.scope,
      ...base,
      expectedSequence: 3,
      observedHead: "f".repeat(40),
    }),
  ).rejects.toThrow("preview_github_head_changed");
  await p.db
    .prepare(
      "UPDATE project_previews SET retirement='destroying',retirement_request_id=?2 WHERE preview_id=?1",
    )
    .bind(previewId, newUlid())
    .run();
  expect(await p.store.previews.readGithubCandidates({ inboxEventId, claimId, now: NOW })).toEqual(
    [],
  );
});

it("recovers lost create, rotation and stop acknowledgements without replacing the stable capability", async () => {
  const p = await setup();
  const lostReply = () =>
    createControlStore({ ...control.bindings, CONTROL_CORE: losingWriteResponses(p.db, 1) })
      .previews;
  const created = await lostReply().ensure({
    ...p.scope,
    environmentId: p.prodEnvironmentId,
    previewId: newUlid(),
    capability: token(21),
  });
  expect(await p.store.previews.get(p.scope)).toEqual(created);
  const rotated = await lostReply().rotate({
    ...p.scope,
    previewId: created.preview.previewId,
    expectedRowVersion: created.preview.rowVersion,
    expectedTokenGeneration: created.preview.tokenGeneration,
    requestId: "lost-rotation",
    capability: token(22, 2),
  });
  await p.store.previews.confirmRotation({
    previewId: rotated.preview.previewId,
    runtimeGeneration: rotated.preview.runtimeGeneration,
    tokenGeneration: rotated.preview.tokenGeneration,
    now: NOW,
  });
  const current = await p.store.previews.get(p.scope);
  if (!current) throw new Error("rotated preview missing");
  const stop = {
    ...p.scope,
    previewId: current.preview.previewId,
    expectedRowVersion: current.preview.rowVersion,
    requestId: "lost-stop",
  };
  await expect(
    p.store.previews.destroy({ ...stop, principalId: "user:user_wrong" }),
  ).rejects.toThrow("preview_scope_unavailable");
  const stopped = await lostReply().destroy(stop);
  expect(stopped.retirement).toBe("destroying");
  expect(stopped.runtimeGeneration).toBe(current.preview.runtimeGeneration + 1);
  await p.store.previews.confirmDestroy({
    previewId: stopped.previewId,
    runtimeGeneration: stopped.runtimeGeneration,
    tokenGeneration: stopped.tokenGeneration,
    now: NOW,
  });
  expect(await p.store.previews.destroy(stop)).toMatchObject({
    runtimeGeneration: stopped.runtimeGeneration,
    retirement: "none",
    state: "cold",
  });
  const after = await p.store.previews.get(p.scope);
  expect(after?.capability).toEqual(rotated.capability);
  expect(after?.preview.previewId).toBe(created.preview.previewId);
  expect(
    (
      await p.db
        .prepare(
          "SELECT kind,count(*) n FROM project_preview_receipts WHERE preview_id=?1 GROUP BY kind ORDER BY kind",
        )
        .bind(stopped.previewId)
        .all()
    ).results,
  ).toEqual([
    { kind: "destroy", n: 1 },
    { kind: "rotate", n: 1 },
  ]);
  const dev = await p.store.previews.ensure({
    ...p.scope,
    environment: "dev",
    environmentId: p.devEnvironmentId,
    previewId: newUlid(),
    capability: token(24),
  });
  const stoppedDev = await p.store.previews.destroy({
    ...p.scope,
    environment: "dev",
    previewId: dev.preview.previewId,
    expectedRowVersion: dev.preview.rowVersion,
    requestId: "dev-stop",
  });
  await p.store.previews.confirmDestroy({
    previewId: stoppedDev.previewId,
    runtimeGeneration: stoppedDev.runtimeGeneration,
    tokenGeneration: stoppedDev.tokenGeneration,
    now: NOW,
  });
  expect((await p.store.previews.get({ ...p.scope, environment: "dev" }))?.capability).toEqual(
    dev.capability,
  );
  expect(await p.store.previews.get(p.scope)).toEqual(after);
});

it("binds encrypted variables to the logical environment and revokes private resources when its data assignment changes", async () => {
  const p = await setup();
  const created = await p.store.previews.ensure({
    ...p.scope,
    environmentId: p.prodEnvironmentId,
    previewId: newUlid(),
    capability: token(23),
  });
  const fence = {
    previewId: created.preview.previewId,
    runtimeGeneration: created.preview.runtimeGeneration,
    tokenGeneration: created.preview.tokenGeneration,
  };
  const database = await p.store.previews.authorizeDatabase({ ...fence, now: NOW });
  expect(database).toMatchObject({
    preview: { environmentId: p.prodEnvironmentId, dataEnvironmentId: p.physical },
    binding: { physicalEnvironmentId: p.physical, provider: "pgcf", status: "active" },
  });
  const cipher = createEnvironmentSecretCipherKeyring({
    primaryKeyBase64: btoa("k".repeat(32)),
    currentKeyVersion: 1,
    crypto,
  });
  for (const [environmentId, name, value] of [
    [p.prodEnvironmentId, "API_TOKEN", "prod-only-value"],
    [p.devEnvironmentId, "API_TOKEN", "dev-only-value"],
    [p.prodEnvironmentId, "OHMYHOST_MAIL_KEY", "mail-platform-value"],
  ] as const) {
    const sealed = await cipher.encrypt({
      organizationId: parseUlid(p.organizationId),
      projectId: parseUlid(p.projectId),
      environmentId: parseUlid(environmentId),
      name,
      value,
    });
    await p.db
      .prepare(
        "INSERT INTO environment_secrets(organization_id,project_id,environment_id,name,ciphertext,nonce,value_sha256,key_version,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,1,1,?8,?8)",
      )
      .bind(
        p.organizationId,
        p.projectId,
        environmentId,
        name,
        sealed.ciphertext,
        sealed.nonce,
        sealed.valueSha256,
        STORED_NOW,
      )
      .run();
  }
  expect(await p.store.previews.listCustomerSecretNames({ fence, now: NOW })).toEqual([
    "API_TOKEN",
  ]);
  const selected = await p.store.previews.readEnvelopes({
    fence,
    names: ["API_TOKEN", "OHMYHOST_MAIL_KEY"],
    now: NOW,
  });
  expect(selected.envelopes).toHaveLength(2);
  const values: Record<string, string> = {};
  for (const envelope of selected.envelopes) {
    values[envelope.name] = await cipher.decrypt({
      ...envelope,
      organizationId: parseUlid(envelope.organizationId),
      projectId: parseUlid(envelope.projectId),
      environmentId: parseUlid(envelope.environmentId),
    });
  }
  expect(values).toEqual({
    API_TOKEN: "prod-only-value",
    OHMYHOST_MAIL_KEY: "mail-platform-value",
  });
  const bulkNames = Array.from(
    { length: 99 },
    (_, index) => `CUSTOMER_${String(index).padStart(3, "0")}`,
  );
  const bulkRows = await Promise.all(
    bulkNames.map(async (name) => {
      const value = `synthetic-${name}`;
      const sealed = await cipher.encrypt({
        organizationId: parseUlid(p.organizationId),
        projectId: parseUlid(p.projectId),
        environmentId: parseUlid(p.prodEnvironmentId),
        name,
        value,
      });
      return p.db
        .prepare(
          "INSERT INTO environment_secrets(organization_id,project_id,environment_id,name,ciphertext,nonce,value_sha256,key_version,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,1,1,?8,?8)",
        )
        .bind(
          p.organizationId,
          p.projectId,
          p.prodEnvironmentId,
          name,
          sealed.ciphertext,
          sealed.nonce,
          await cipher.keyedDigest("value", new TextEncoder().encode(value)),
          STORED_NOW,
        );
    }),
  );
  await p.db.batch(bulkRows);
  const allCustomerNames = ["API_TOKEN", ...bulkNames];
  expect(await p.store.previews.listCustomerSecretNames({ fence, now: NOW })).toEqual(
    allCustomerNames,
  );
  for (const size of [65, 100]) {
    const names = allCustomerNames.slice(0, size);
    const result = await p.store.previews.readEnvelopes({ fence, names, now: NOW });
    expect(result.envelopes.map((envelope) => envelope.name)).toEqual(names);
  }
  await expect(
    p.store.previews.readEnvelopes({
      fence,
      names: [...allCustomerNames, "CUSTOMER_999"],
      now: NOW,
    }),
  ).rejects.toThrow();
  await expect(
    p.store.previews.readEnvelopes({ fence, names: ["DATABASE_URL"], now: NOW }),
  ).rejects.toThrow();
  await expect(
    p.store.previews.readEnvelopes({ fence, names: ["API_TOKEN", "API_TOKEN"], now: NOW }),
  ).rejects.toThrow();
  let changed = false;
  const racingStore = createControlStore({
    ...control.bindings,
    CONTROL_CORE: {
      prepare: (sql) => p.db.prepare(sql),
      batch: async (statements) => {
        const result = await p.db.batch(statements);
        if (!changed) {
          changed = true;
          await p.db
            .prepare(
              "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,assignment_version,data_environment_id,assigned_at) VALUES(?1,?2,?3,2,?4,?5)",
            )
            .bind(p.organizationId, p.projectId, p.prodEnvironmentId, p.physical, STORED_NOW)
            .run();
        }
        return result;
      },
    },
  });
  await expect(
    racingStore.previews.readEnvelopes({ fence, names: ["API_TOKEN"], now: NOW }),
  ).rejects.toThrow("preview_scope_unavailable");
  expect(changed).toBe(true);
  expect(await p.store.previews.authorizeDatabase({ ...fence, now: NOW })).toBeNull();
  await expect(p.store.previews.listCustomerSecretNames({ fence, now: NOW })).rejects.toThrow(
    "preview_scope_unavailable",
  );
});
