import { parseUsageLogRecord } from "@ohmyhost/contracts/usage-log";
import { appendUsageRecord } from "./usage-store.js";
import { archiveUsage, cleanupErasedUsage, expireUsageArchives } from "./usage-archive.js";
import { readUsageCalls } from "./usage-reader.js";
import { readUsageArchive, type GrowthUsageBucket } from "./usage-bucket.js";
import { parseGrowthEvent } from "@ohmyhost/contracts/growth-events";
import { createGrowthEventStore, type GrowthD1 } from "./event-store.js";
import {
  createFactReconciler,
  type FactReconcilerPorts,
  type GrowthReconcileSource,
} from "./fact-reconciler.js";
import {
  parseDeploymentHealth,
  appendDeploymentHealth,
  readDeploymentHealth,
} from "./deployment-health.js";
import { parseSourceHealth, writeSourceHealth } from "./source-health.js";
import { createOperatorData, auditIdentityRead } from "./operator-data.js";
import { verifyOperatorAccess } from "./operator-auth.js";
import { handleGrowthOperatorRequest } from "./operator-routes.js";
import { createExperimentStore, observeDeliveredExperiment } from "./experiments.js";
import { expireGrowthData } from "./retention.js";
import { refreshGrowthRollups, expireGrowthAccountData } from "./account-projection.js";

export const GROWTH_SOURCES: GrowthReconcileSource[] = [
  "identity",
  "identity_snapshot",
  "onboarding",
  "memberships",
  "attribution",
  "projects",
  "source_publications",
  "deployments",
  "billing",
  "billing_open_disputes",
];
export interface GrowthEnvironment {
  GROWTH_DB: GrowthD1;
  GROWTH_USAGE_ARCHIVE: GrowthUsageBucket;
  GROWTH_QUEUE: { send(body: unknown, options?: { contentType: "json" }): Promise<void> };
  GROWTH_RECONCILER: { reconcile(source: GrowthReconcileSource): Promise<unknown> };
  GROWTH_FACTS: FactReconcilerPorts["core"];
  GROWTH_IDENTITY: NonNullable<FactReconcilerPorts["identity"]> & {
    getGrowthIdentity(input: {
      user_id: string;
    }): Promise<{ name: string | null; email: string | null }>;
  };
  GROWTH_PAYMENTS: NonNullable<FactReconcilerPorts["billing"]>;
  GROWTH_PLATFORM_ENV: "development" | "production";
  GROWTH_QUEUE_NAME: string;
  GROWTH_DLQ_NAME: string;
  GROWTH_PUBLIC_ORIGIN: string;
  GROWTH_ACCESS_ISSUER: string;
  GROWTH_ACCESS_AUDIENCE: string;
  GROWTH_OPERATOR_PERMISSIONS_JSON: string;
}
export interface GrowthContext {
  waitUntil(work: Promise<unknown>): void;
}
export interface GrowthMessage {
  id: string;
  body: unknown;
  timestamp: Date;
  ack(): void;
  retry(options?: { delaySeconds: number }): void;
}
export interface GrowthBatch {
  queue: string;
  messages: GrowthMessage[];
}
function environment(env: GrowthEnvironment) {
  if (!["development", "production"].includes(env.GROWTH_PLATFORM_ENV))
    throw new Error("growth_environment_invalid");
  return env.GROWTH_PLATFORM_ENV;
}
function packet(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new TypeError("growth_packet_invalid");
  const value = raw as Record<string, unknown>;
  const kind = value["kind"];
  const field =
    kind === "usage"
      ? "record"
      : kind === "event"
        ? "event"
        : kind === "health_observation"
          ? "observation"
          : kind === "source_health"
            ? "snapshot"
            : null;
  if (!field || Object.keys(value).length !== 2 || !Object.hasOwn(value, field))
    throw new TypeError("growth_packet_invalid");
  return value;
}

/** Product-facing work is admission to an asynchronous queue, never a synchronous Core mutation. */
export function createGrowthRuntime(
  env: GrowthEnvironment,
  context: GrowthContext,
  accessFetch?: typeof fetch,
) {
  const platformEnvironment = environment(env),
    db = env.GROWTH_DB,
    store = createGrowthEventStore(db);
  const queuePacket = (value: unknown) => env.GROWTH_QUEUE.send(value, { contentType: "json" });
  const reconciler = createFactReconciler({
    core: env.GROWTH_FACTS,
    identity: env.GROWTH_IDENTITY,
    billing: env.GROWTH_PAYMENTS,
    store,
    platformEnvironment,
    health: { readDeploymentHealth: (scope) => readDeploymentHealth(db, scope) },
  });
  return {
    async collect(input: unknown): Promise<{ accepted: boolean }> {
      const event = parseGrowthEvent(input);
      if (event.producer !== "control_api" || event.platform_environment !== platformEnvironment)
        throw new TypeError("growth_producer_invalid");
      await queuePacket({ kind: "event", event });
      return { accepted: true };
    },
    async collectUsage(input: unknown): Promise<{ accepted: boolean }> {
      const record = parseUsageLogRecord(input);
      if (record.platform_environment !== platformEnvironment)
        throw new TypeError("usage_environment_invalid");
      // Usage is high volume and idempotent by record_id: it is written straight to D1 and skips the queue.
      if ((await appendUsageRecord(db, record)) === "conflict")
        throw new Error("usage_record_conflict");
      return { accepted: true };
    },
    async observeHealth(input: unknown): Promise<{ accepted: boolean }> {
      const observation = parseDeploymentHealth(input);
      await queuePacket({ kind: "health_observation", observation });
      return { accepted: true };
    },
    async collectSourceHealth(input: unknown): Promise<{ accepted: boolean }> {
      const snapshot = parseSourceHealth(input);
      await queuePacket({ kind: "source_health", snapshot });
      return { accepted: true };
    },
    async consume(batch: GrowthBatch): Promise<void> {
      if (![env.GROWTH_QUEUE_NAME, env.GROWTH_DLQ_NAME].includes(batch.queue))
        throw new TypeError("growth_queue_invalid");
      for (const message of batch.messages) {
        try {
          if (batch.queue === env.GROWTH_DLQ_NAME) {
            let eventId: string | null = null;
            try {
              const p = packet(message.body);
              if (p["kind"] === "event") eventId = parseGrowthEvent(p["event"]).event_id;
              else if (p["kind"] === "usage") eventId = parseUsageLogRecord(p["record"]).record_id;
            } catch {
              /* Never persist unvalidated packet content. */
            }
            await db
              .prepare(
                "INSERT OR IGNORE INTO growth_delivery_failures(message_id,event_id,enqueued_at,failed_at,error_class) VALUES(?,?,?,?,?)",
              )
              .bind(
                message.id,
                eventId,
                message.timestamp instanceof Date && Number.isFinite(message.timestamp.getTime())
                  ? message.timestamp.toISOString()
                  : null,
                new Date().toISOString(),
                "delivery_exhausted",
              )
              .run();
            message.ack();
            continue;
          }
          const p = packet(message.body);
          if (p["kind"] === "usage") {
            const record = parseUsageLogRecord(p["record"]);
            if (record.platform_environment !== platformEnvironment)
              throw new TypeError("usage_environment_invalid");
            if ((await appendUsageRecord(db, record)) === "conflict")
              throw new Error("usage_record_conflict");
            await db
              .prepare(
                "UPDATE growth_delivery_failures SET resolved_at=? WHERE event_id=? AND resolved_at IS NULL",
              )
              .bind(new Date().toISOString(), record.record_id)
              .run();
          } else if (p["kind"] === "event") {
            const event = parseGrowthEvent(p["event"]);
            if (
              event.producer !== "control_api" ||
              event.platform_environment !== platformEnvironment
            )
              throw new TypeError("growth_producer_invalid");
            const outcome = await store.appendEvent(event);
            if (outcome === "conflict") throw new Error("growth_event_conflict");
            if (outcome === "inserted" || outcome === "duplicate") {
              await observeDeliveredExperiment(db, event);
              await db
                .prepare(
                  "UPDATE growth_delivery_failures SET resolved_at=? WHERE event_id=? AND resolved_at IS NULL",
                )
                .bind(new Date().toISOString(), event.event_id)
                .run();
            }
          } else if (p["kind"] === "health_observation") {
            if ((await appendDeploymentHealth(db, p["observation"])) === "conflict")
              throw new Error("growth_health_conflict");
          } else await writeSourceHealth(db, p["snapshot"]);
          message.ack();
        } catch {
          console.warn("growth delivery processing unavailable");
          message.retry({ delaySeconds: 30 });
        }
      }
    },
    async reconcile(source: GrowthReconcileSource) {
      if (!GROWTH_SOURCES.includes(source)) throw new TypeError("growth_source_invalid");
      return reconciler.reconcileSource(source);
    },
    async scheduled(): Promise<void> {
      const usageAt = new Date();
      await db
        .prepare("UPDATE growth_usage_export SET last_attempt_at=? WHERE singleton=1")
        .bind(usageAt.toISOString())
        .run();
      const usageResults = await Promise.allSettled([
        archiveUsage(db, env.GROWTH_USAGE_ARCHIVE, usageAt),
        cleanupErasedUsage(db, env.GROWTH_USAGE_ARCHIVE, usageAt),
        expireUsageArchives(db, env.GROWTH_USAGE_ARCHIVE, usageAt),
      ]);
      const usageFailed = usageResults.some((result) => result.status === "rejected");
      if (usageFailed) console.warn("usage archive or cleanup temporarily unavailable");
      await db
        .prepare("UPDATE growth_usage_export SET last_error=? WHERE singleton=1")
        .bind(usageFailed ? "archive_unavailable" : null)
        .run();
      await db
        .prepare(
          "DELETE FROM growth_usage_receipts WHERE received_at<? AND NOT EXISTS (SELECT 1 FROM growth_usage_records r WHERE r.record_id=growth_usage_receipts.record_id)",
        )
        .bind(new Date(usageAt.getTime() - 90 * 86400000).toISOString())
        .run();
      // Each private RPC has its own bounded source page; a failed source cannot abort its neighbors.
      for (let offset = 0; offset < GROWTH_SOURCES.length; offset += 3) {
        const results = await Promise.allSettled(
          GROWTH_SOURCES.slice(offset, offset + 3).map((source) =>
            env.GROWTH_RECONCILER.reconcile(source),
          ),
        );
        if (results.some((result) => result.status === "rejected"))
          console.warn("growth source reconciliation unavailable");
      }
      const now = new Date();
      await refreshGrowthRollups(db, now);
      await expireGrowthData(db, now);
      await expireGrowthAccountData(db, now);
      await db
        .prepare("DELETE FROM growth_exposures WHERE delivered_at<?")
        .bind(new Date(now.getTime() - 180 * 86400000).toISOString())
        .run();
      await db
        .prepare("DELETE FROM growth_deployment_health WHERE observed_at<?")
        .bind(new Date(now.getTime() - 180 * 86400000).toISOString())
        .run();
      await db
        .prepare("DELETE FROM growth_source_health WHERE as_of<?")
        .bind(new Date(now.getTime() - 30 * 86400000).toISOString())
        .run();
      await db
        .prepare("DELETE FROM growth_delivery_failures WHERE failed_at<?")
        .bind(new Date(now.getTime() - 30 * 86400000).toISOString())
        .run();
    },
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.origin !== env.GROWTH_PUBLIC_ORIGIN)
        return new Response("Not found", { status: 404 });
      if (url.pathname === "/" && request.method === "GET")
        return new Response(null, {
          status: 303,
          headers: { location: "/growth", "cache-control": "no-store" },
        });
      const data = createOperatorData(db);
      try {
        const permissions: unknown = JSON.parse(env.GROWTH_OPERATOR_PERMISSIONS_JSON);
        if (
          !permissions ||
          typeof permissions !== "object" ||
          Array.isArray(permissions) ||
          JSON.stringify(permissions).length > 8192
        )
          throw new Error("operator policy invalid");
        return await handleGrowthOperatorRequest(request, {
          environment: platformEnvironment,
          authorize: (req) =>
            verifyOperatorAccess(req, {
              issuer: env.GROWTH_ACCESS_ISSUER,
              audience: env.GROWTH_ACCESS_AUDIENCE,
              environment: platformEnvironment,
              permissions: permissions as Record<string, string[]>,
              ...(accessFetch ? { fetcher: accessFetch } : {}),
            }),
          ...data,
          readUsageCalls: (input) =>
            readUsageCalls(
              db,
              {
                read: (key, maxBytes) => readUsageArchive(env.GROWTH_USAGE_ARCHIVE, key, maxBytes),
              },
              input,
            ),
          readDashboard: async (input) => {
            const dashboard = await data.readDashboard(input);
            const row = await db
              .prepare("SELECT body FROM growth_source_health WHERE producer='control_api'")
              .first<{ body: string }>();
            const health = row ? parseSourceHealth(JSON.parse(row.body)) : null;
            const failures = await db
              .prepare(
                "SELECT count(*) count,min(failed_at) oldest FROM growth_delivery_failures WHERE resolved_at IS NULL",
              )
              .first<{ count: number; oldest: string | null }>();
            const usage = await db
              .prepare(
                "SELECT completed_at,last_attempt_at,last_error,(SELECT count(*) FROM growth_usage_records) pending FROM growth_usage_export WHERE singleton=1",
              )
              .first<{
                completed_at: string | null;
                last_attempt_at: string | null;
                last_error: string | null;
                pending: number;
              }>();
            return {
              ...dashboard,
              sources: [
                ...dashboard.sources,
                {
                  source: "MCP/API usage archive (24-hour rotation)",
                  watermark: usage?.completed_at ?? null,
                  historyFloor: null,
                  status: `${usage?.pending ?? 0} buffered observations; ${usage?.last_error ?? (usage?.completed_at ? "scheduled" : "first nonempty export pending")}`,
                },
                {
                  source: "Control API independent delivery counts",
                  watermark: health?.as_of ?? null,
                  historyFloor: health?.since ?? null,
                  status: health
                    ? `${Date.now() - Date.parse(health.as_of) > 900000 ? "stale; " : ""}${health.offered} offered; ${health.unconfirmed} unconfirmed acknowledgements (not proven event loss)`
                    : "unavailable",
                },
                {
                  source: "Confirmed terminal delivery receipts",
                  watermark: failures?.oldest ?? null,
                  status: `${failures?.count ?? 0} recorded unresolved; current queue/DLQ depth is not measured`,
                },
              ],
            };
          },
          registerExperiment: (input) => createExperimentStore(db).registerExperiment(input),
          resolveIdentityForOperator: auditIdentityRead(db, (subject) =>
            env.GROWTH_IDENTITY.getGrowthIdentity({ user_id: subject }),
          ),
        });
      } catch {
        console.warn("growth operator unavailable");
        return new Response("Growth view temporarily unavailable", {
          status: 503,
          headers: { "cache-control": "no-store" },
        });
      }
    },
  };
}
