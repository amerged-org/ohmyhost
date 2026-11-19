import { isSignupUtm } from "@ohmyhost/contracts/signup-attribution";
import type {
  DeploymentFactV1,
  GrowthEventV1,
  PaymentFactV1,
} from "@ohmyhost/contracts/growth-events";
import type { createGrowthEventStore } from "./event-store.js";

export type GrowthReconcileSource =
  | "attribution"
  | "onboarding"
  | "memberships"
  | "projects"
  | "source_publications"
  | "deployments"
  | "identity"
  | "identity_snapshot"
  | "billing"
  | "billing_open_disputes";
type CoreSource = Exclude<
  GrowthReconcileSource,
  "identity" | "identity_snapshot" | "billing" | "billing_open_disputes"
>;
type Page<T> = {
  facts: T[];
  next_cursor: string | null;
  source_watermark: string | null;
  history_floor: string | null;
};
type CorePage = Page<Record<string, unknown>> & { evidence_kind: "original" | "snapshot" };
type Store = Pick<
  ReturnType<typeof createGrowthEventStore>,
  | "appendEvent"
  | "appendFact"
  | "getCursor"
  | "beginSourceRead"
  | "finishSourceRead"
  | "upsertCampaign"
  | "replaceMembershipSnapshot"
  | "beginDisputeScan"
  | "stageOpenDisputes"
  | "promoteOpenDisputes"
>;
export interface FactReconcilerPorts {
  core: {
    readFactPage(input: {
      source: CoreSource;
      cursor: string | null;
      limit: number;
    }): Promise<CorePage>;
  };
  identity?: {
    readGrowthIdentityPage(input: {
      cursor: string | null;
      limit: number;
    }): Promise<Page<GrowthEventV1>>;
    readGrowthUserSnapshotPage(input: {
      cursor: string | null;
      limit: number;
    }): Promise<Page<GrowthEventV1>>;
  };
  billing?: {
    readGrowthPaymentPage(input: {
      cursor: string | null;
      limit: number;
    }): Promise<Page<PaymentFactV1>>;
    readGrowthOpenDisputePage(input: {
      cursor: string | null;
      limit: number;
    }): Promise<Page<PaymentFactV1>>;
  };
  health?: {
    readDeploymentHealth(scope: {
      candidate_receipt_id: string;
      organization_id: string;
      project_id: string;
      environment_id: string;
      deployment_id: string;
    }): Promise<{
      observation_id: string;
      health_status: "passed" | "failed";
      observed_at: string;
    } | null>;
  };
  store: Store;
  platformEnvironment: "development" | "production";
}
const str = (row: Record<string, unknown>, key: string): string | null =>
  typeof row[key] === "string" ? (row[key] as string) : null;
function time(value: string | null): string | null {
  if (
    !value ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return null;
  return value;
}
async function stableId(prefix: string, value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return (
    prefix + Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("")
  );
}
function eventBase(
  row: Record<string, unknown>,
  env: "development" | "production",
  at: string,
  id: string,
  eventName: GrowthEventV1["event_name"],
  evidence: "event" | "snapshot",
): GrowthEventV1 {
  return {
    schema_version: 1,
    event_id: id,
    event_name: eventName,
    outcome: "succeeded",
    occurred_at: at,
    received_at: new Date().toISOString(),
    platform_environment: env,
    producer: "core",
    evidence_kind: evidence,
    flow_id: null,
    account_id: str(row, "account_id"),
    organization_id: str(row, "organization_id"),
    project_id: str(row, "project_id"),
    operation_id: str(row, "operation_id"),
    deployment_id: str(row, "deployment_id"),
    transport: "unknown",
    client_class: "unknown",
    client_class_trust: "unknown",
    error_class: null,
    campaign_key: null,
    request_country: null,
  };
}

/** One bounded page per run; a completed scan restarts from null on the next run to observe mutable sources. */
export function createFactReconciler(ports: FactReconcilerPorts) {
  async function runSource(
    source: GrowthReconcileSource,
    statusGeneration: string,
  ): Promise<{
    processed: number;
    next_cursor: string | null;
    quality_flags: string[];
    source_watermark?: string | null;
    history_floor?: string | null;
  }> {
    if (source === "billing_open_disputes") {
      if (!ports.billing)
        return { processed: 0, next_cursor: null, quality_flags: ["source_unavailable"] };
      const generation = `scan_${crypto.randomUUID()}`,
        startedAt = new Date().toISOString();
      if (!(await ports.store.beginDisputeScan(generation, startedAt)))
        return { processed: 0, next_cursor: null, quality_flags: ["scan_superseded"] };
      let cursor: string | null = null,
        processed = 0,
        watermark: string | null = null,
        historyFloor: string | null = null;
      for (let pages = 0; pages < 20; pages++) {
        let page: Page<PaymentFactV1>;
        try {
          page = await ports.billing.readGrowthOpenDisputePage({ cursor, limit: 200 });
        } catch {
          return { processed, next_cursor: cursor, quality_flags: ["source_unavailable"] };
        }
        if (pages === 0) {
          watermark = page.source_watermark;
          historyFloor = page.history_floor;
        }
        await ports.store.stageOpenDisputes(generation, page.facts);
        processed += page.facts.length;
        if (page.next_cursor === null) {
          if (!(await ports.store.promoteOpenDisputes(generation, statusGeneration)))
            return { processed, next_cursor: null, quality_flags: ["scan_superseded"] };
          return {
            processed,
            next_cursor: null,
            source_watermark: watermark,
            history_floor: historyFloor,
            quality_flags: [
              ...(watermark === null ? ["source_watermark_unknown"] : []),
              ...(historyFloor === null ? ["history_floor_unknown"] : []),
            ],
          };
        }
        if (page.next_cursor === cursor) throw new Error("dispute source cursor stalled");
        cursor = page.next_cursor;
      }
      return { processed, next_cursor: cursor, quality_flags: ["scan_page_limit"] };
    }
    const cursor = await ports.store.getCursor(source);
    const input = { cursor, limit: 200 };
    let page: Page<Record<string, unknown> | GrowthEventV1 | PaymentFactV1>;
    try {
      if (source === "identity") {
        if (!ports.identity) throw new Error("unavailable");
        page = await ports.identity.readGrowthIdentityPage(input);
      } else if (source === "identity_snapshot") {
        if (!ports.identity) throw new Error("unavailable");
        page = await ports.identity.readGrowthUserSnapshotPage(input);
      } else if (source === "billing") {
        if (!ports.billing) throw new Error("unavailable");
        page = await ports.billing.readGrowthPaymentPage(input);
      } else page = await ports.core.readFactPage({ ...input, source });
    } catch {
      return { processed: 0, next_cursor: cursor, quality_flags: ["source_unavailable"] };
    }
    const flags = [
      ...(page.history_floor === null ? ["history_floor_unknown"] : []),
      ...(page.source_watermark === null ? ["source_watermark_unknown"] : []),
    ];
    let processed = 0;
    const accept = (result: string) => {
      if (result === "conflict") throw new Error("growth record conflict");
      if (result === "limited") throw new Error("growth ingest limited");
      if (result === "expired") flags.push("retention_expired");
    };
    for (const item of page.facts) {
      if (source === "identity" || source === "identity_snapshot") {
        accept(await ports.store.appendEvent(item as GrowthEventV1));
        processed++;
        continue;
      }
      if (source === "billing") {
        accept(await ports.store.appendFact(item as PaymentFactV1));
        processed++;
        continue;
      }
      const row = item as Record<string, unknown>;
      if (source === "attribution") {
        const accountId = str(row, "account_id"),
          r = str(row, "r"),
          raw = str(row, "utm_parameters");
        if (!accountId || (r !== null && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(r)))
          throw new Error("invalid attribution source");
        let utm: unknown = null;
        if (raw !== null) {
          try {
            utm = JSON.parse(raw) as unknown;
          } catch {
            throw new Error("invalid attribution source");
          }
        }
        if (utm !== null && !isSignupUtm(utm)) throw new Error("invalid attribution source");
        if (r !== null || utm !== null) {
          const observed = new Date();
          await ports.store.upsertCampaign({
            campaign_key: await stableId("campaign_", accountId),
            account_id: accountId,
            r,
            utm,
            utm_observed_at: utm === null ? null : observed.toISOString(),
            observed_at: observed.toISOString(),
            expires_at: new Date(observed.getTime() + 30 * 86400000).toISOString(),
          });
          processed++;
        }
        continue;
      }
      if (source === "memberships") {
        const sourceId = str(row, "source_id"),
          accountId = str(row, "account_id"),
          organizationId = str(row, "organization_id"),
          state = str(row, "state");
        const revision = row["mapping_revision"];
        if (
          !sourceId ||
          !accountId ||
          !organizationId ||
          !["active", "suspended", "revoked"].includes(state ?? "") ||
          !Number.isSafeInteger(revision) ||
          (revision as number) < 1
        )
          throw new Error("invalid membership snapshot");
        const result = await ports.store.replaceMembershipSnapshot({
          source_id: sourceId,
          account_id: accountId,
          organization_id: organizationId,
          active: state === "active",
          observed_at: new Date().toISOString(),
          source_version: `v_${revision}`,
          source_revision: revision as number,
        });
        accept(result);
        processed++;
        continue;
      }
      if (source === "deployments") {
        const status = str(row, "status"),
          target = str(row, "target_environment"),
          kind = str(row, "kind");
        const requestedAt = time(str(row, "created_at")),
          requestedId = str(row, "deployment_id");
        if (requestedAt && requestedId) {
          const requested = eventBase(
            row,
            ports.platformEnvironment,
            requestedAt,
            await stableId("core_", [
              "deployment_requested",
              requestedId,
              ports.platformEnvironment,
            ]),
            "deployment_requested",
            "event",
          );
          requested.outcome = "attempted";
          accept(await ports.store.appendEvent(requested));
        }
        if (
          (status !== "succeeded" && status !== "failed") ||
          (target !== "dev" && target !== "prod") ||
          (kind !== "deploy" && kind !== "promotion" && kind !== "rollback")
        )
          continue;
        const deploymentId = str(row, "deployment_id"),
          environmentId = str(row, "environment_id"),
          sourceId = str(row, "source_id");
        if (!deploymentId || !environmentId || !sourceId)
          throw new Error("invalid deployment source");
        const terminal = time(str(row, "terminal_at"));
        const version = str(row, "updated_at");
        if (!version) {
          flags.push("source_version_unknown");
          continue;
        }
        const observedAt = new Date().toISOString();
        let healthId = status === "failed" ? str(row, "health_evidence_id") : null;
        let healthStatus: "passed" | "failed" | "unknown" = healthId ? "failed" : "unknown";
        let healthTime: string | null = null;
        const candidate = str(row, "candidate_receipt_id"),
          organization = str(row, "organization_id"),
          project = str(row, "project_id");
        if (status === "succeeded" && candidate && organization && project) {
          if (!ports.health) flags.push("health_source_unavailable");
          else
            try {
              const evidence = await ports.health.readDeploymentHealth({
                candidate_receipt_id: candidate,
                organization_id: organization,
                project_id: project,
                environment_id: environmentId,
                deployment_id: deploymentId,
              });
              if (evidence) {
                healthId = evidence.observation_id;
                healthStatus = evidence.health_status;
                healthTime = evidence.observed_at;
              }
            } catch {
              flags.push("health_source_unavailable");
            }
        }
        const digits = (value: string | null) =>
          value
            ? value
                .replace(/[^0-9]/g, "")
                .padEnd(20, "0")
                .slice(0, 20)
            : "00000000000000000000";
        const sourceVersion = `v_${digits(version)}_${digits(healthTime)}_${healthId ? "1" : "0"}_${healthId ?? "none"}`;
        const base: Omit<DeploymentFactV1, "fact_id"> = {
          schema_version: 1,
          fact_type: "deployment",
          source_id: sourceId,
          observed_at: observedAt,
          source_version: sourceVersion,
          occurred_at: terminal,
          account_id: str(row, "account_id"),
          organization_id: organization,
          project_id: project,
          operation_id: str(row, "operation_id"),
          deployment_id: deploymentId,
          environment_id: environmentId,
          target_environment: target,
          kind,
          status,
          succeeded_at: status === "succeeded" ? terminal : null,
          health_status: healthStatus,
          health_evidence_id: healthId,
        };
        const fact: DeploymentFactV1 = { ...base, fact_id: `deployment_${deploymentId}` };
        accept(await ports.store.appendFact(fact));
        processed++;
        const terminalId = str(row, "terminal_event_id");
        if (terminal && terminalId) {
          const terminalEvent = eventBase(
            row,
            ports.platformEnvironment,
            terminal,
            await stableId("core_", ["deployment_terminal", terminalId, ports.platformEnvironment]),
            status === "succeeded" ? "deployment_succeeded" : "deployment_failed",
            "event",
          );
          terminalEvent.outcome = status === "succeeded" ? "succeeded" : "failed";
          if (status === "failed") terminalEvent.error_class = "unknown";
          accept(await ports.store.appendEvent(terminalEvent));
        }
        if (!terminal) flags.push("terminal_time_unknown");
        if (!healthId) flags.push("health_unknown");
        continue;
      }
      let name: GrowthEventV1["event_name"] | null = null,
        at: string | null = null;
      const evidence = "event";
      if (source === "projects") {
        name = "project_created";
        at = time(str(row, "created_at"));
      } else if (source === "onboarding" && str(row, "completed_at")) {
        name = "workspace_ready";
        at = time(str(row, "completed_at"));
      } else if (
        source === "source_publications" &&
        str(row, "mode") !== "switch" &&
        str(row, "state") === "committed" &&
        str(row, "terminal_event_id")
      ) {
        name = str(row, "mode") === "initialize" ? "source_initialized" : "source_version_saved";
        at = time(str(row, "terminal_at"));
      }
      if (!name || !at) continue;
      const event = eventBase(
        row,
        ports.platformEnvironment,
        at,
        await stableId("core_", [
          source,
          name,
          str(row, "terminal_event_id") ?? str(row, "created_event_id") ?? str(row, "source_id"),
          at,
          ports.platformEnvironment,
        ]),
        name,
        evidence,
      );
      accept(await ports.store.appendEvent(event));
      processed++;
    }
    return {
      processed,
      next_cursor: page.next_cursor,
      quality_flags: [...new Set(flags)],
      source_watermark: page.source_watermark,
      history_floor: page.history_floor,
    };
  }
  return {
    async reconcileSource(source: GrowthReconcileSource) {
      const generation = `read_${crypto.randomUUID()}`,
        startedAt = new Date().toISOString();
      if (!(await ports.store.beginSourceRead(source, generation, startedAt)))
        return { processed: 0, next_cursor: null, quality_flags: ["scan_superseded"] };
      try {
        const result = await runSource(source, generation);
        const error =
          result.quality_flags.find((flag) =>
            ["source_unavailable", "scan_page_limit", "scan_superseded"].includes(flag),
          ) ?? null;
        const committed = await ports.store.finishSourceRead({
          source,
          generation,
          finished_at: new Date().toISOString(),
          error_class: error,
          quality_flags: result.quality_flags,
          cursor: result.next_cursor,
          source_watermark: result.source_watermark ?? null,
          history_floor: result.history_floor ?? null,
          completed: result.next_cursor === null,
        });
        return committed
          ? result
          : {
              processed: result.processed,
              next_cursor: result.next_cursor,
              quality_flags: ["scan_superseded"],
            };
      } catch (error) {
        await ports.store.finishSourceRead({
          source,
          generation,
          finished_at: new Date().toISOString(),
          error_class: "processing_failed",
          quality_flags: ["processing_failed"],
          completed: false,
        });
        throw error;
      }
    },
  };
}
