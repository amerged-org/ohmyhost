import { expect, it } from "vitest";
import { createTestControl } from "../support/control-d1.js";
import { newUlid } from "../../src/catalog/common.js";
import { functionScheduleStatements } from "../../src/catalog/gateway/function-schedules.js";
import { gatewayFixture } from "./gateway-fixture.js";

it("stamps the exact original activation receipt and probe window and keeps the source schedule rules with all source guards enabled", async () => {
  const control = await createTestControl();
  try {
    const r = await gatewayFixture(control);
    const before = Date.now();
    const { observedAt, ...receipt } = await r.store.gateway.management.activate(r.activation);
    expect(observedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(observedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(receipt).toEqual({
      provider: "ohmyhost-shared-gateway",
      ...r.scope,
      environmentName: "prod",
      handle: r.project.handle,
      hostname: r.hostname,
      publicOrigin: `https://${r.hostname}`,
      targetDeploymentId: r.deploymentId,
      targetScriptName: r.script,
      targetArtifactDigest: `sha256:${"03".repeat(32)}`,
      targetProviderTag: r.providerTag,
      // sha256 of the canonical empty egress list "[]".
      egressPolicyDigest: "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      egressAllowedOrigins: [],
      candidateReceiptId: r.candidateReceiptId,
      revision: 2,
      predecessorRevision: 1,
      operationId: r.accepted.operationId,
      active: true,
    });

    // An unlost first write answers with the stored window: the fixed -30/+180-second interval.
    const windowId = newUlid();
    const probe = await r.store.gateway.probe.beginProbe({
      ...r.scope,
      deploymentId: r.deploymentId,
      windowId,
    });
    const window = await r.db
      .prepare("SELECT starts_at,expires_at FROM runtime_probe_windows WHERE window_id=?")
      .bind(windowId)
      .first<{ starts_at: string; expires_at: string }>();
    if (window === null) throw new Error("Probe window missing");
    expect(Date.parse(window.expires_at) - Date.parse(window.starts_at)).toBe(210_000);
    expect(probe).toEqual({ expiresAt: new Date(window.expires_at).toISOString() });

    const input = {
      ...r.scope,
      deploymentId: r.deploymentId,
      candidateReceiptId: r.candidateReceiptId,
      crons: ["30 2 * * *", "*/5 * * * *"],
      egressAllowedOrigins: [
        "https://z.example.test",
        "https://a.example.test",
        "https://a.example.test",
      ],
      now: "2026-10-29T00:00:00.000Z",
    };
    await r.db.batch(functionScheduleStatements(r.db, input));
    const stored = await r.db
      .prepare(
        "SELECT crons,egress_allowed_origins,immutable_script_name,next_fire_at FROM environment_function_schedules WHERE organization_id=?",
      )
      .bind(r.scope.organizationId)
      .first<{
        crons: string;
        egress_allowed_origins: string;
        immutable_script_name: string;
        next_fire_at: null;
      }>();
    expect(stored).not.toBeNull();
    // Crons are normalized and sorted; the original scheduler sorts origins but retains duplicates.
    expect({
      crons: JSON.parse(stored?.crons ?? "null"),
      egress_allowed_origins: JSON.parse(stored?.egress_allowed_origins ?? "null"),
      immutable_script_name: stored?.immutable_script_name,
    }).toEqual({
      crons: ["*/5 * * * *", "30 2 * * *"],
      egress_allowed_origins: [
        "https://a.example.test",
        "https://a.example.test",
        "https://z.example.test",
      ],
      immutable_script_name: r.script,
    });
    expect(stored?.next_fire_at).toBeNull();
    // A cron the original schedule never admitted is refused by the stored row itself.
    for (const cron of [
      "* * * * *",
      "*/1 * * * *",
      "60 * * * *",
      "05 * * * *",
      "*/5 24 * * *",
      "*/5 * 0 * *",
      "*/5 * * * 7",
    ])
      await expect(
        r.db
          .prepare("UPDATE environment_function_schedules SET crons=? WHERE organization_id=?")
          .bind(JSON.stringify([cron]), r.scope.organizationId)
          .run(),
      ).rejects.toThrow();
    await r.db.batch(functionScheduleStatements(r.db, { ...input, crons: [] }));
    expect(
      await r.db.prepare("SELECT count(*) n FROM environment_function_schedules").first(),
    ).toEqual({ n: 0 });
  } finally {
    await control.dispose();
  }
}, 120000);
