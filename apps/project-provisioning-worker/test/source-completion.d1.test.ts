import { prepareSourceHandoff } from "../../control-store/test/provisioning/source-handoff.fixture.js";
import {
  readSourceHandoff,
  sourceHandoffPrepared,
} from "../../control-store/src/catalog/provisioning/source-handoff.js";
import { expect, it } from "vitest";
import { recordGithubSourceConnection } from "../../control-store/src/catalog/provisioning/github-registration.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { sourceLinkFixture } from "../../control-store/test/provisioning/source-link.fixture.js";
import { completeSourceLink } from "../../control-store/src/catalog/provisioning/source-completion.js";
import { createCoreSourceCompletionPort } from "../src/core-source-completion.js";
import {
  losingWriteResponses,
  beforeFirstWrite,
} from "../../control-store/test/support/platform-fixtures.js";
import { SharedCoreRouter } from "../../control-store/src/router.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { leaseOperation } from "../../control-store/test/support/accepted-operation.js";
const clock = () => new Date("2026-10-28T11:02:00.000Z");
it("completes SourceLink over the actual typed Core port, preserving accepted history and replaying a lost reply", async () => {
  // The control-store fixture seeds a PostgreSQL twin of the Core; only the Core is under test here.
  const c = await createTestControl();
  try {
    const r = await sourceLinkFixture(c),
      lost = losingWriteResponses(c.core, 1),
      core = createCoreSourceCompletionPort(
        {
          completeSourceLink: (i) =>
            completeSourceLink({ directory: lost, router: new SharedCoreRouter(lost) }, i),
        },
        clock,
      ),
      input = {
        workflowId: r.workflowId,
        executionId: r.workflowId,
        command: r.command,
        evidence: { externalRepositoryId: "42" },
      };
    // Existing immutable facts keep their accepted identity; completion must preserve them.
    const accepted = {
      organizationId: r.command.organizationId,
      projectId: r.command.projectId,
      billingEpochId: r.command.billingEpochId,
      sourceConnectionId: r.operationId,
      externalRepositoryId: "42",
      createdAt: "2026-10-28T11:01:00.500Z",
    };
    await recordGithubSourceConnection(r.ctx, accepted);
    await c.core
      .prepare(
        "INSERT INTO repository_grants(grant_id,organization_id,project_id,billing_epoch_id,source_connection_id,provider,github_installation_id,external_repository_id,repository_owner,repository_name,permission,granted_at) VALUES(?1,?2,?3,?4,?1,'github','7',?5,'o','r','contents:read','2026-10-28T11:01:00.500000Z')",
      )
      .bind(
        r.operationId,
        accepted.organizationId,
        accepted.projectId,
        accepted.billingEpochId,
        accepted.externalRepositoryId,
      )
      .run();
    // The public comparison uses milliseconds while the stored start evidence retains all microseconds.
    await c.core
      .prepare(
        "INSERT INTO operation_events(organization_id,project_id,operation_id,event_id,revision,event_type,idempotency_key,payload,occurred_at) VALUES(?,?,?,?,1,'OperationStarted',?,'{}','2026-10-28T11:02:00.000999Z')",
      )
      .bind(
        r.command.organizationId,
        r.command.projectId,
        r.operationId,
        newUlid(),
        `${r.workflowId}:observed-start`,
      )
      .run();
    // Completion records observed Source metadata under its accepted epoch even after that epoch closes.
    const epoch = newUlid(),
      ended = "2026-10-28T11:01:30.000000Z";
    await c.core
      .prepare("UPDATE billing_epochs SET ended_at=? WHERE billing_epoch_id=?")
      .bind(ended, r.base.p.billingEpochId)
      .run();
    await c.core
      .prepare(
        "INSERT INTO billing_epochs(billing_epoch_id,project_id,organization_id,started_at,created_by_principal_id) VALUES(?,?,?,?,'user:fixture')",
      )
      .bind(epoch, r.base.p.projectId, r.base.p.organizationId, ended)
      .run();
    await c.core
      .prepare(
        "UPDATE projects SET active_billing_epoch_id=? WHERE project_id=? AND organization_id=?",
      )
      .bind(epoch, r.base.p.projectId, r.base.p.organizationId)
      .run();
    const began = Date.now();
    // The running SourceLink Workflow holds the operation's lease when its completion runs.
    await leaseOperation(c.core, r.operationId);
    // The first reply is lost: the effect is already durable, so the replay reports the duplicate.
    expect(await core.complete(input)).toBe("duplicate");
    expect(
      await c.core
        .prepare("SELECT state,lease_expires_at FROM operations WHERE operation_id=?1")
        .bind(r.operationId)
        .first(),
    ).toEqual({ state: "succeeded", lease_expires_at: null });
    const finished = Date.now(),
      bindingStamp = await c.core
        .prepare(
          "SELECT updated_at FROM project_source_bindings WHERE organization_id=? AND project_id=?",
        )
        .bind(r.command.organizationId, r.command.projectId)
        .first<{ updated_at: string }>();
    expect(Date.parse(bindingStamp?.updated_at ?? "invalid")).toBeGreaterThanOrEqual(began);
    expect(Date.parse(bindingStamp?.updated_at ?? "invalid")).toBeLessThanOrEqual(finished);
    expect(await core.complete(input)).toBe("duplicate");
    expect(
      await c.core
        .prepare(
          "SELECT source_connection_id,provider,generation FROM project_source_bindings WHERE organization_id=? AND project_id=?",
        )
        .bind(r.base.p.organizationId, r.base.p.projectId)
        .first(),
    ).toEqual({ source_connection_id: r.operationId, provider: "github", generation: 2 });
    await expect(
      core.complete({ ...input, evidence: { externalRepositoryId: "43" } }),
    ).rejects.toThrow();
    expect((await c.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await c.dispose();
  }
}, 240_000);
it("rolls a final SourceLink audit failure back with both registration facts, grant, source/binding and all terminal history", async () => {
  const c = await createTestControl();
  try {
    const r = await sourceLinkFixture(c),
      port = createCoreSourceCompletionPort(
        { completeSourceLink: (i) => completeSourceLink(r.ctx, i) },
        clock,
      ),
      input = {
        workflowId: r.workflowId,
        executionId: r.workflowId,
        command: r.command,
        evidence: { externalRepositoryId: "42" },
      };
    await c.core
      .prepare("DELETE FROM project_source_bindings WHERE organization_id=? AND project_id=?")
      .bind(r.base.p.organizationId, r.base.p.projectId)
      .run();
    await c.core
      .prepare(
        "CREATE TRIGGER source_terminal_late_failure BEFORE INSERT ON audit_events WHEN NEW.event_type='SourceLinkRequestedV1Completed' BEGIN SELECT RAISE(ABORT,'late source terminal audit'); END",
      )
      .run();
    await expect(port.complete(input)).rejects.toThrow("late source terminal audit");
    for (const [table, key] of [
      ["github_source_connections", "source_connection_id"],
      ["source_connections", "source_connection_id"],
      ["repository_grants", "grant_id"],
      ["project_sources", "source_id"],
    ])
      expect(
        await c.core
          .prepare(`SELECT count(*) n FROM ${table} WHERE ${key}=?`)
          .bind(r.operationId)
          .first(),
      ).toEqual({ n: 0 });
    expect(
      await c.core
        .prepare("SELECT state FROM operations WHERE operation_id=?")
        .bind(r.operationId)
        .first(),
    ).toEqual({ state: "queued" });
    expect(
      await c.core
        .prepare(
          "SELECT count(*) n FROM project_source_bindings WHERE organization_id=? AND project_id=?",
        )
        .bind(r.base.p.organizationId, r.base.p.projectId)
        .first(),
    ).toEqual({ n: 0 });
    await c.core.prepare("DROP TRIGGER source_terminal_late_failure").run();
    expect(await port.complete(input)).toBe("applied");
    const binding = await c.core
      .prepare(
        "SELECT source_connection_id,provider,generation,commit_sha FROM project_source_bindings WHERE organization_id=? AND project_id=?",
      )
      .bind(r.base.p.organizationId, r.base.p.projectId)
      .first();
    expect(binding?.["generation"]).toBe(1);
  } finally {
    await c.dispose();
  }
}, 240_000);
it("rejects missing handoff, changed ownership and foreign source scope at the actual effect boundary", async () => {
  const c = await createTestControl();
  try {
    const r = await sourceLinkFixture(c, false),
      port = createCoreSourceCompletionPort(
        { completeSourceLink: (i) => completeSourceLink(r.ctx, i) },
        clock,
      ),
      input = {
        workflowId: r.workflowId,
        executionId: r.workflowId,
        command: r.command,
        evidence: { externalRepositoryId: "42" },
      };
    await expect(port.complete(input)).rejects.toThrow("handoff");
    await prepareSourceHandoff(r);
    const handoffScope = {
      workflowId: r.workflowId,
      eventId: r.eventId,
      organizationId: r.base.p.organizationId,
      projectId: r.base.p.projectId,
      environmentId: r.command.environmentId,
      operationId: r.operationId,
    };
    const snapshot = await readSourceHandoff(c.core, handoffScope);
    expect(sourceHandoffPrepared(handoffScope, snapshot)).toBe(true);
    expect(
      sourceHandoffPrepared(handoffScope, {
        ...snapshot,
        audits: snapshot.audits.map((a) => ({ ...a, payload: JSON.stringify(a["payload"]) })),
      }),
    ).toBe(false);
    // Prepared handoff has its own current-epoch fence; it cannot borrow the ACK path's historical-epoch policy.
    const wrongEpoch = newUlid(),
      epochTime = "2026-10-28T11:07:10.000000Z";
    await c.core
      .prepare(
        "INSERT INTO billing_epochs(billing_epoch_id,project_id,organization_id,started_at,ended_at,created_by_principal_id) VALUES(?1,?2,?3,?4,?4,'user:fixture')",
      )
      .bind(wrongEpoch, r.command.projectId, r.command.organizationId, epochTime)
      .run();
    const epochRace = beforeFirstWrite(c.core, async () => {
        await c.core
          .prepare(
            "UPDATE projects SET active_billing_epoch_id=? WHERE organization_id=? AND project_id=?",
          )
          .bind(wrongEpoch, r.command.organizationId, r.command.projectId)
          .run();
      }),
      racePort = createCoreSourceCompletionPort(
        {
          completeSourceLink: (i) =>
            completeSourceLink(
              { directory: epochRace, router: new SharedCoreRouter(epochRace) },
              i,
            ),
        },
        () => new Date("2026-10-28T11:08:00.000Z"),
      );
    await expect(racePort.complete(input)).rejects.toThrow("handoff");
    expect(
      await c.core
        .prepare("SELECT count(*) n FROM github_source_connections WHERE source_connection_id=?")
        .bind(r.operationId)
        .first(),
    ).toEqual({ n: 0 });
    await c.core
      .prepare(
        "UPDATE projects SET active_billing_epoch_id=? WHERE organization_id=? AND project_id=?",
      )
      .bind(r.command.billingEpochId, r.command.organizationId, r.command.projectId)
      .run();
    // Original173 records observed GitHub Source history while retaining an intervening managed current binding.
    const managedId = newUlid();
    await r.insert("source_connections", {
      source_connection_id: managedId,
      organization_id: r.command.organizationId,
      project_id: r.command.projectId,
      billing_epoch_id: r.command.billingEpochId,
      provider: "managed",
      external_repository_id: "fixture/managed",
      created_at: "2026-10-28T11:07:30.000000Z",
    });
    await c.core
      .prepare(
        "UPDATE project_source_bindings SET source_connection_id=?,provider='managed',generation=generation+1,commit_sha=?,updated_at=? WHERE organization_id=? AND project_id=?",
      )
      .bind(
        managedId,
        "c".repeat(40),
        "2026-10-28T11:07:30.000000Z",
        r.command.organizationId,
        r.command.projectId,
      )
      .run();
    const managedBefore = await c.core
      .prepare("SELECT * FROM project_source_bindings WHERE organization_id=? AND project_id=?")
      .bind(r.command.organizationId, r.command.projectId)
      .first();
    const recoveryClock = () => new Date("2026-10-28T11:08:00.000Z"),
      recoveredCore = createCoreSourceCompletionPort(
        { completeSourceLink: (i) => completeSourceLink(r.ctx, i) },
        recoveryClock,
      );
    expect(await recoveredCore.complete(input)).toBe("applied");
    expect(await recoveredCore.complete(input)).toBe("duplicate");
    expect(
      await c.core
        .prepare("SELECT * FROM project_source_bindings WHERE organization_id=? AND project_id=?")
        .bind(r.command.organizationId, r.command.projectId)
        .first(),
    ).toEqual(managedBefore);
    expect(
      await c.core
        .prepare("SELECT acknowledged_at FROM outbox_events WHERE event_id=?")
        .bind(r.eventId)
        .first(),
    ).toEqual({ acknowledged_at: null });
    const g = await sourceLinkFixture(c),
      race = beforeFirstWrite(c.core, async () => {
        await c.core
          .prepare(
            "UPDATE projects SET owner_state='security_frozen' WHERE organization_id=? AND project_id=?",
          )
          .bind(g.base.p.organizationId, g.base.p.projectId)
          .run();
      }),
      raced = createCoreSourceCompletionPort(
        {
          completeSourceLink: (i) =>
            completeSourceLink({ directory: race, router: new SharedCoreRouter(race) }, i),
        },
        clock,
      );
    await expect(
      raced.complete({
        ...input,
        workflowId: g.workflowId,
        executionId: g.workflowId,
        command: g.command,
      }),
    ).rejects.toThrow();
    await expect(
      port.complete({
        ...input,
        command: { ...input.command, operationId: newUlid() as typeof input.command.operationId },
      }),
    ).rejects.toThrow();
  } finally {
    await c.dispose();
  }
}, 240_000);
