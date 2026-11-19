import { enqueueUsageErasure } from "./usage-store.js";
import {
  parseGrowthEvent,
  parseGrowthFact,
  type GrowthEventV1,
  type GrowthFactV1,
} from "@ohmyhost/contracts/growth-events";
import { isSignupUtm } from "@ohmyhost/contracts/signup-attribution";

export interface GrowthD1Statement {
  bind(...values: unknown[]): GrowthD1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface GrowthD1 {
  prepare(sql: string): GrowthD1Statement;
  batch(statements: GrowthD1Statement[]): Promise<Array<{ meta: { changes: number } }>>;
}
/** Deterministic one-way suppression key; never store a deleted account ID in the tombstone. */
export async function subjectSuppressionKey(accountId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`growth-subject-v1:${accountId}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export type AppendResult = "inserted" | "duplicate" | "conflict" | "expired" | "limited";
export interface MembershipSnapshot {
  source_id: string;
  account_id: string;
  organization_id: string;
  active: boolean;
  observed_at: string;
  source_version: string;
  source_revision: number;
}
export interface GrowthCampaign {
  campaign_key: string;
  account_id: string;
  r: string | null;
  utm: Record<string, string> | null;
  utm_observed_at: string | null;
  observed_at: string;
  expires_at: string;
}

export function createGrowthEventStore(db: GrowthD1, now: () => Date = () => new Date()) {
  const stmt = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
  const count = async (producer: string, outcome: string) => {
    await stmt(
      "INSERT INTO growth_ingest_health(producer,outcome,count) VALUES(?,?,1) ON CONFLICT(producer,outcome) DO UPDATE SET count=count+1",
      producer,
      outcome,
    ).run();
  };
  const outside = (value: string, days: number) => {
    const t = Date.parse(value),
      n = now().getTime();
    return !Number.isFinite(t) || t < n - days * 86400000 || t > n + 300000;
  };
  return {
    async appendEvent(input: GrowthEventV1): Promise<AppendResult> {
      const event = parseGrowthEvent(input),
        body = JSON.stringify(event);
      if (event.event_name === "account_deleted") {
        if (
          event.producer !== "workos" ||
          event.outcome !== "succeeded" ||
          !event.account_id ||
          event.evidence_kind !== "event" ||
          outside(event.received_at, 30)
        )
          throw new Error("invalid deletion event");
        await createGrowthEventStore(db, now).deleteSubject(event.account_id, event.received_at);
        return "inserted";
      }
      const subjectKey = event.account_id ? await subjectSuppressionKey(event.account_id) : null;
      // WorkOS snapshots retain the original creation timestamp without becoming event evidence.
      if (
        event.event_name === "account_created" &&
        event.producer === "workos" &&
        event.outcome === "succeeded" &&
        event.account_id &&
        /^user_[A-Za-z0-9_]{1,123}$/u.test(event.account_id) &&
        !outside(event.occurred_at, 180) &&
        !outside(event.received_at, 30)
      ) {
        await stmt(
          `INSERT INTO growth_account_projection(account_id,created_at,observed_at,source_kind,test_segment)
          SELECT ?,?,?,?,'unknown' WHERE NOT EXISTS (SELECT 1 FROM growth_subject_suppression WHERE subject_key=?) AND NOT EXISTS (SELECT 1 FROM growth_replay_suppression WHERE record_type='event' AND record_id=?) AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM growth_flow_suppression WHERE flow_id=?)) AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM growth_flows WHERE flow_id=? AND account_id<>?))
          ON CONFLICT(account_id) DO UPDATE SET created_at=MIN(created_at,excluded.created_at),
          observed_at=CASE WHEN excluded.created_at<created_at THEN excluded.observed_at ELSE observed_at END,
          source_kind=CASE WHEN excluded.created_at<created_at THEN excluded.source_kind ELSE source_kind END`,
          event.account_id,
          event.occurred_at,
          event.received_at,
          event.evidence_kind,
          subjectKey,
          event.event_id,
          event.flow_id,
          event.flow_id,
          event.flow_id,
          event.flow_id,
          event.account_id,
        ).run();
      }
      // Original trusted business events can seed the 180-day projection, but never the 30-day raw log.
      if (
        outside(event.occurred_at, 30) &&
        !outside(event.occurred_at, 180) &&
        !outside(event.received_at, 30) &&
        event.outcome === "succeeded" &&
        event.evidence_kind === "event" &&
        // A flow-only historic milestone could not be erased with its subject after raw expiry.
        (event.flow_id === null || event.account_id !== null) &&
        ((event.producer === "core" &&
          [
            "workspace_ready",
            "project_created",
            "source_initialized",
            "source_version_saved",
            "deployment_succeeded",
          ].includes(event.event_name)) ||
          (event.producer === "workos" &&
            ["account_created", "provider_auth_succeeded"].includes(event.event_name)))
      ) {
        const guard = `(? IS NULL OR NOT EXISTS (SELECT 1 FROM growth_subject_suppression WHERE subject_key=?))
          AND NOT EXISTS (SELECT 1 FROM growth_replay_suppression WHERE record_type='event' AND record_id=?)
          AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM growth_flow_suppression WHERE flow_id=?))
          AND (? IS NULL OR ? IS NULL OR NOT EXISTS (SELECT 1 FROM growth_flows WHERE flow_id=? AND account_id<>?))`;
        const guardValues = [
          event.account_id,
          subjectKey,
          event.event_id,
          event.flow_id,
          event.flow_id,
          event.flow_id,
          event.account_id,
          event.flow_id,
          event.account_id,
        ];
        const statements = [
          stmt(
            `INSERT OR IGNORE INTO growth_milestones(event_id,account_id,organization_id,event_name,occurred_at)
          SELECT ?,?,?,?,? WHERE ${guard}`,
            event.event_id,
            event.account_id,
            event.organization_id,
            event.event_name,
            event.occurred_at,
            ...guardValues,
          ),
        ];
        if (event.event_name === "workspace_ready" && event.account_id)
          statements.push(
            stmt(
              `INSERT INTO growth_workspace_observations(account_id,observed_at)
          SELECT ?,? WHERE ${guard} AND EXISTS (SELECT 1 FROM growth_milestones WHERE event_id=? AND account_id=? AND organization_id IS ? AND event_name=? AND occurred_at=?)
          ON CONFLICT(account_id) DO UPDATE SET observed_at=MIN(observed_at,excluded.observed_at)`,
              event.account_id,
              event.occurred_at,
              ...guardValues,
              event.event_id,
              event.account_id,
              event.organization_id,
              event.event_name,
              event.occurred_at,
            ),
          );
        await db.batch(statements);
      }
      if (outside(event.occurred_at, 30) || outside(event.received_at, 30)) {
        await count(event.producer, "expired");
        return "expired";
      }
      const previousEvent = await stmt(
        "SELECT body FROM growth_events WHERE event_id=?",
        event.event_id,
      ).first<{ body: string }>();
      if (previousEvent) {
        const original = JSON.parse(previousEvent.body) as GrowthEventV1;
        const status =
          JSON.stringify({ ...original, received_at: event.received_at }) === body
            ? "duplicate"
            : "conflict";
        await count(event.producer, status);
        return status;
      }
      if (
        event.event_name === "product_call_succeeded" ||
        event.event_name === "product_call_failed"
      ) {
        if (event.account_id) {
          const slot = await stmt(
            "INSERT OR IGNORE INTO growth_diagnostic_slots(account_id,event_name,minute) SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM growth_subject_suppression WHERE subject_key=?)",
            event.account_id,
            `${event.event_name}:${event.client_class}`,
            now().toISOString().slice(0, 16),
            subjectKey,
          ).run();
          if (!slot.meta.changes) {
            await count(event.producer, "limited");
            return "limited";
          }
        }
        if (event.event_name === "product_call_failed") {
          const minute = now().toISOString().slice(0, 16);
          const budget = await stmt(
            "INSERT INTO growth_ingest_budgets(producer,minute,accepted) VALUES(?,?,1) ON CONFLICT(producer,minute) DO UPDATE SET accepted=accepted+1 WHERE accepted<60",
            event.producer,
            minute,
          ).run();
          if (!budget.meta.changes) {
            await count(event.producer, "limited");
            return "limited";
          }
        }
      }
      const result = await db.batch([
        stmt(
          "INSERT OR IGNORE INTO growth_events(event_id,account_id,flow_id,organization_id,event_name,occurred_at,received_at,body) SELECT ?,?,?,?,?,?,?,? WHERE (? IS NULL OR NOT EXISTS (SELECT 1 FROM growth_subject_suppression WHERE subject_key=?)) AND NOT EXISTS (SELECT 1 FROM growth_replay_suppression WHERE record_type='event' AND record_id=?) AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM growth_flow_suppression WHERE flow_id=?)) AND (? IS NULL OR ? IS NULL OR NOT EXISTS (SELECT 1 FROM growth_flows WHERE flow_id=? AND account_id<>?))",
          event.event_id,
          event.account_id,
          event.flow_id,
          event.organization_id,
          event.event_name,
          event.occurred_at,
          event.received_at,
          body,
          event.account_id,
          subjectKey,
          event.event_id,
          event.flow_id,
          event.flow_id,
          event.flow_id,
          event.account_id,
          event.flow_id,
          event.account_id,
        ),
        stmt(
          "INSERT OR IGNORE INTO growth_milestones(event_id,account_id,organization_id,event_name,occurred_at) SELECT event_id,account_id,organization_id,event_name,occurred_at FROM growth_events WHERE event_id=? AND body=? AND ?='succeeded' AND ?='event'",
          event.event_id,
          body,
          event.outcome,
          event.evidence_kind,
        ),
        stmt(
          "INSERT OR IGNORE INTO growth_flows(flow_id,account_id,linked_at,expires_at) SELECT ?,?,?,? WHERE ? IS NOT NULL AND ? IS NOT NULL AND ?='control_api' AND ?='portal_login_succeeded' AND ?='succeeded' AND NOT EXISTS (SELECT 1 FROM growth_subject_suppression WHERE subject_key=?) AND EXISTS (SELECT 1 FROM growth_events WHERE event_id=? AND body=?)",
          event.flow_id,
          event.account_id,
          event.received_at,
          new Date(Date.parse(event.received_at) + 30 * 86400000).toISOString(),
          event.flow_id,
          event.account_id,
          event.producer,
          event.event_name,
          event.outcome,
          subjectKey,
          event.event_id,
          body,
        ),
        stmt(
          "INSERT OR IGNORE INTO growth_activity(event_id,account_id,organization_id,occurred_at) SELECT event_id,account_id,organization_id,occurred_at FROM growth_events WHERE event_id=? AND body=? AND ?='succeeded' AND ?='event' AND event_name='source_version_saved'",
          event.event_id,
          body,
          event.outcome,
          event.evidence_kind,
        ),
      ]);
      if (
        result[0]?.meta.changes &&
        event.event_name === "workspace_ready" &&
        event.outcome === "succeeded" &&
        event.evidence_kind === "event" &&
        event.account_id
      ) {
        await stmt(
          `INSERT INTO growth_workspace_observations(account_id,observed_at)
          SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM growth_subject_suppression WHERE subject_key=?)
          ON CONFLICT(account_id) DO UPDATE SET observed_at=MIN(observed_at,excluded.observed_at)`,
          event.account_id,
          event.occurred_at,
          subjectKey,
        ).run();
      }
      if (result[0]?.meta.changes) {
        await count(event.producer, "inserted");
        return "inserted";
      }
      const existing = await stmt(
        "SELECT body FROM growth_events WHERE event_id=?",
        event.event_id,
      ).first<{ body: string }>();
      const status =
        existing &&
        JSON.stringify({
          ...(JSON.parse(existing.body) as GrowthEventV1),
          received_at: event.received_at,
        }) !== body
          ? "conflict"
          : "duplicate";
      await count(event.producer, status);
      return status;
    },
    async appendFact(input: GrowthFactV1): Promise<AppendResult> {
      const fact = parseGrowthFact(input),
        body = JSON.stringify(fact);
      const subjectKey = fact.account_id ? await subjectSuppressionKey(fact.account_id) : null;
      if (outside(fact.occurred_at ?? fact.observed_at, 180) || outside(fact.observed_at, 180))
        return "expired";
      const result = await stmt(
        "INSERT OR IGNORE INTO growth_facts(fact_id,account_id,organization_id,occurred_at,body) SELECT ?,?,?,?,? WHERE (? IS NULL OR NOT EXISTS (SELECT 1 FROM growth_subject_suppression WHERE subject_key=?)) AND NOT EXISTS (SELECT 1 FROM growth_replay_suppression WHERE record_type='fact' AND record_id=?)",
        fact.fact_id,
        fact.account_id,
        fact.organization_id,
        fact.occurred_at,
        body,
        fact.account_id,
        subjectKey,
        fact.fact_id,
      ).run();
      if (result.meta.changes) return "inserted";
      const existing = await stmt(
        "SELECT body FROM growth_facts WHERE fact_id=?",
        fact.fact_id,
      ).first<{ body: string }>();
      if (!existing) return "duplicate";
      const previous = JSON.parse(existing.body) as GrowthFactV1;
      if (
        fact.fact_type === "deployment" &&
        previous.fact_type === "deployment" &&
        fact.source_version !== previous.source_version
      ) {
        if (
          fact.source_id !== previous.source_id ||
          fact.deployment_id !== previous.deployment_id ||
          fact.account_id !== previous.account_id ||
          fact.organization_id !== previous.organization_id ||
          fact.project_id !== previous.project_id ||
          fact.operation_id !== previous.operation_id
        )
          return "conflict";
        if (fact.source_version < previous.source_version) return "duplicate";
        const updated = await stmt(
          "UPDATE growth_facts SET occurred_at=?,body=? WHERE fact_id=? AND json_extract(body,'$.source_version') < ? AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM growth_subject_suppression WHERE subject_key=?))",
          fact.occurred_at,
          body,
          fact.fact_id,
          fact.source_version,
          fact.account_id,
          subjectKey,
        ).run();
        return updated.meta.changes ? "inserted" : "duplicate";
      }
      return JSON.stringify({ ...previous, observed_at: fact.observed_at }) === body
        ? "duplicate"
        : "conflict";
    },
    /** Source read generation fences status and cursor updates from stale concurrent scans. */
    async beginSourceRead(source: string, generation: string, startedAt: string): Promise<boolean> {
      const result = await stmt(
        `INSERT INTO growth_source_status(source,generation,last_attempt_at) VALUES(?,?,?)
        ON CONFLICT(source) DO UPDATE SET generation=excluded.generation,last_attempt_at=excluded.last_attempt_at
        `,
        source,
        generation,
        startedAt,
      ).run();
      return result.meta.changes > 0;
    },
    async finishSourceRead(input: {
      source: string;
      generation: string;
      finished_at: string;
      error_class: string | null;
      quality_flags: string[];
      cursor?: string | null;
      source_watermark?: string | null;
      history_floor?: string | null;
      completed: boolean;
    }): Promise<boolean> {
      const success = input.error_class === null;
      const statements = [];
      if (success)
        statements.push(
          stmt(
            `INSERT INTO growth_cursors(source,cursor,source_watermark,history_floor,error_class)
        SELECT ?,?,?,?,NULL WHERE EXISTS (SELECT 1 FROM growth_source_status WHERE source=? AND generation=?)
        ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor,source_watermark=CASE WHEN growth_cursors.cursor IS NULL THEN excluded.source_watermark ELSE growth_cursors.source_watermark END,history_floor=CASE WHEN growth_cursors.cursor IS NULL THEN excluded.history_floor ELSE growth_cursors.history_floor END,error_class=NULL`,
            input.source,
            input.cursor ?? null,
            input.source_watermark ?? null,
            input.history_floor ?? null,
            input.source,
            input.generation,
          ),
        );
      statements.push(
        stmt(
          `UPDATE growth_source_status SET last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END,
        completed_scan_at=CASE WHEN ? THEN ? ELSE completed_scan_at END,error_class=?,quality_flags=? WHERE source=? AND generation=?`,
          success ? 1 : 0,
          input.finished_at,
          success && input.completed ? 1 : 0,
          input.finished_at,
          input.error_class,
          JSON.stringify(input.quality_flags),
          input.source,
          input.generation,
        ),
      );
      const result = await db.batch(statements);
      return (result.at(-1)?.meta.changes ?? 0) > 0;
    },
    async readSourceStatus(source: string): Promise<{
      last_attempt_at: string;
      last_success_at: string | null;
      completed_scan_at: string | null;
      error_class: string | null;
      quality_flags: string;
      source_watermark: string | null;
      history_floor: string | null;
    } | null> {
      return stmt(
        `SELECT s.last_attempt_at,s.last_success_at,s.completed_scan_at,s.error_class,s.quality_flags,c.source_watermark,c.history_floor FROM growth_source_status s LEFT JOIN growth_cursors c USING(source) WHERE s.source=?`,
        source,
      ).first();
    },
    async getCursor(source: string): Promise<string | null> {
      return (
        (
          await stmt("SELECT cursor FROM growth_cursors WHERE source=?", source).first<{
            cursor: string | null;
          }>()
        )?.cursor ?? null
      );
    },
    async readCursor(source: string): Promise<{
      cursor: string | null;
      source_watermark: string | null;
      history_floor: string | null;
      error_class: string | null;
    } | null> {
      return stmt(
        "SELECT cursor,source_watermark,history_floor,error_class FROM growth_cursors WHERE source=?",
        source,
      ).first();
    },
    async setCursor(
      source: string,
      cursor: string | null,
      watermark: string | null,
      historyFloor: string | null,
      errorClass: string | null = null,
    ): Promise<void> {
      await stmt(
        "INSERT INTO growth_cursors(source,cursor,source_watermark,history_floor,error_class) VALUES(?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor,source_watermark=excluded.source_watermark,history_floor=excluded.history_floor,error_class=excluded.error_class",
        source,
        cursor,
        watermark,
        historyFloor,
        errorClass,
      ).run();
    },
    async replaceMembershipSnapshot(input: MembershipSnapshot): Promise<AppendResult> {
      if (
        !/^[A-Za-z0-9_:-]{1,200}$/.test(input.source_id) ||
        !/^[A-Za-z0-9_:-]{1,200}$/.test(input.account_id) ||
        !/^[A-Za-z0-9_:-]{1,200}$/.test(input.organization_id) ||
        !/^[A-Za-z0-9_:-]{1,200}$/.test(input.source_version) ||
        typeof input.active !== "boolean" ||
        !Number.isSafeInteger(input.source_revision) ||
        input.source_revision < 1
      )
        throw new Error("invalid membership snapshot");
      if (outside(input.observed_at, 180)) return "expired";
      const existing = await stmt(
        "SELECT source_id,account_id,organization_id,active,observed_at,source_version,source_revision FROM growth_membership_snapshots WHERE source_id=?",
        input.source_id,
      ).first<{
        source_id: string;
        account_id: string;
        organization_id: string;
        active: number;
        observed_at: string;
        source_version: string;
        source_revision: number;
      }>();
      if (
        existing &&
        existing.source_revision === input.source_revision &&
        existing.source_version !== input.source_version
      )
        return "conflict";
      if (existing?.source_version === input.source_version)
        return existing.account_id === input.account_id &&
          existing.organization_id === input.organization_id &&
          Boolean(existing.active) === input.active
          ? "duplicate"
          : "conflict";
      const subjectKey = await subjectSuppressionKey(input.account_id);
      const result = await stmt(
        "INSERT INTO growth_membership_snapshots(source_id,account_id,organization_id,active,observed_at,source_version,source_revision) SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM growth_subject_suppression WHERE subject_key=?) ON CONFLICT(source_id) DO UPDATE SET account_id=excluded.account_id,organization_id=excluded.organization_id,active=excluded.active,observed_at=excluded.observed_at,source_version=excluded.source_version,source_revision=excluded.source_revision WHERE excluded.source_revision>growth_membership_snapshots.source_revision",
        input.source_id,
        input.account_id,
        input.organization_id,
        input.active ? 1 : 0,
        input.observed_at,
        input.source_version,
        input.source_revision,
        subjectKey,
      ).run();
      if (result.meta.changes && input.active)
        await stmt(
          `INSERT INTO growth_workspace_observations(account_id,observed_at)
        SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM growth_subject_suppression WHERE subject_key=?)
        ON CONFLICT(account_id) DO UPDATE SET observed_at=MIN(observed_at,excluded.observed_at)`,
          input.account_id,
          input.observed_at,
          subjectKey,
        ).run();
      return result.meta.changes ? "inserted" : "duplicate";
    },
    async upsertCampaign(c: GrowthCampaign): Promise<void> {
      if (
        !/^[A-Za-z0-9_:-]{1,200}$/.test(c.campaign_key) ||
        !/^user_[A-Za-z0-9_]{1,123}$/u.test(c.account_id) ||
        (c.utm !== null && !isSignupUtm(c.utm)) ||
        (c.utm === null
          ? c.utm_observed_at !== null
          : c.utm_observed_at === null || outside(c.utm_observed_at, 180)) ||
        (c.r !== null && !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(c.r)) ||
        outside(c.observed_at, 180) ||
        !Number.isFinite(Date.parse(c.expires_at)) ||
        Date.parse(c.expires_at) > now().getTime() + 180 * 86400000 ||
        Date.parse(c.expires_at) <= now().getTime()
      )
        throw new Error("invalid campaign");
      const subjectKey = await subjectSuppressionKey(c.account_id);
      await db.batch([
        stmt(
          "INSERT OR IGNORE INTO growth_campaign_expiry(campaign_key,first_observed_at,expires_at) SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM growth_subject_suppression WHERE subject_key=?)",
          c.campaign_key,
          c.observed_at,
          c.expires_at,
          subjectKey,
        ),
        stmt(
          "INSERT INTO growth_campaigns(campaign_key,body,expires_at) SELECT ?,json_set(?,'$.observed_at',first_observed_at,'$.expires_at',expires_at),expires_at FROM growth_campaign_expiry WHERE campaign_key=? AND expires_at>? AND NOT EXISTS (SELECT 1 FROM growth_subject_suppression WHERE subject_key=?) ON CONFLICT(campaign_key) DO NOTHING",
          c.campaign_key,
          JSON.stringify(c),
          c.campaign_key,
          now().toISOString(),
          subjectKey,
        ),
      ]);
      if (c.utm !== null)
        await stmt(
          "UPDATE growth_campaigns SET body=json_set(body,'$.utm',json(?),'$.utm_observed_at',?) WHERE campaign_key=? AND expires_at>? AND json_type(body,'$.utm')='null' AND json_extract(body,'$.account_id')=? AND NOT EXISTS (SELECT 1 FROM growth_subject_suppression WHERE subject_key=?)",
          JSON.stringify(c.utm),
          c.utm_observed_at,
          c.campaign_key,
          now().toISOString(),
          c.account_id,
          subjectKey,
        ).run();
    },
    async readCampaign(key: string): Promise<GrowthCampaign | null> {
      const row = await stmt(
        "SELECT body FROM growth_campaigns WHERE campaign_key=? AND expires_at>?",
        key,
        now().toISOString(),
      ).first<{ body: string }>();
      return row ? (JSON.parse(row.body) as GrowthCampaign) : null;
    },
    async beginDisputeScan(generation: string, startedAt: string): Promise<boolean> {
      if (!/^[A-Za-z0-9_:-]{1,200}$/.test(generation) || outside(startedAt, 1))
        throw new Error("invalid dispute scan");
      const result = await stmt(
        "INSERT INTO growth_dispute_scans(singleton,generation,started_at) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET generation=excluded.generation,started_at=excluded.started_at WHERE excluded.started_at>growth_dispute_scans.started_at",
        generation,
        startedAt,
      ).run();
      if (result.meta.changes)
        await db
          .prepare(
            "DELETE FROM growth_dispute_staging WHERE generation <> (SELECT generation FROM growth_dispute_scans WHERE singleton=1)",
          )
          .run();
      return result.meta.changes > 0;
    },
    async stageOpenDisputes(generation: string, inputs: GrowthFactV1[]): Promise<void> {
      if (inputs.length > 200 || !/^[A-Za-z0-9_:-]{1,200}$/.test(generation))
        throw new Error("invalid dispute page");
      const facts = inputs.map(parseGrowthFact);
      if (
        facts.some(
          (f) =>
            f.fact_type !== "payment" || f.money_effect !== "none" || outside(f.observed_at, 180),
        )
      )
        throw new Error("invalid open dispute");
      if (facts.length) {
        const keys = await Promise.all(
          facts.map((f) =>
            f.account_id ? subjectSuppressionKey(f.account_id) : Promise.resolve(null),
          ),
        );
        await db.batch(
          facts.map((f, i) =>
            stmt(
              "INSERT INTO growth_dispute_staging(generation,fact_id,body) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM growth_dispute_scans WHERE singleton=1 AND generation=?) AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM growth_subject_suppression WHERE subject_key=?)) ON CONFLICT(generation,fact_id) DO UPDATE SET body=excluded.body",
              generation,
              f.fact_id,
              JSON.stringify(f),
              generation,
              f.account_id,
              keys[i] ?? null,
            ),
          ),
        );
      }
    },
    async promoteOpenDisputes(generation: string, statusGeneration?: string): Promise<boolean> {
      const guard =
        statusGeneration === undefined
          ? ""
          : " AND EXISTS (SELECT 1 FROM growth_source_status WHERE source='billing_open_disputes' AND generation=?)";
      const fence = statusGeneration === undefined ? [] : [statusGeneration];
      const results = await db.batch([
        stmt(
          `DELETE FROM growth_open_disputes WHERE EXISTS (SELECT 1 FROM growth_dispute_scans WHERE singleton=1 AND generation=?)${guard}`,
          generation,
          ...fence,
        ),
        stmt(
          `INSERT INTO growth_open_disputes(fact_id,body) SELECT fact_id,body FROM growth_dispute_staging WHERE generation=? AND EXISTS (SELECT 1 FROM growth_dispute_scans WHERE singleton=1 AND generation=?)${guard}`,
          generation,
          generation,
          ...fence,
        ),
        stmt(
          `DELETE FROM growth_dispute_scans WHERE singleton=1 AND generation=?${guard}`,
          generation,
          ...fence,
        ),
        stmt("DELETE FROM growth_dispute_staging WHERE generation=?", generation),
      ]);
      return (results[2]?.meta.changes ?? 0) > 0;
    },
    async deleteSubject(accountId: string, deletedAt = now().toISOString()): Promise<void> {
      const subjectKey = await subjectSuppressionKey(accountId);
      await db.batch([
        stmt(
          "INSERT OR IGNORE INTO growth_subject_suppression(subject_key,deleted_at) VALUES(?,?)",
          subjectKey,
          deletedAt,
        ),
        ...enqueueUsageErasure(db, subjectKey, now()),
        stmt(
          "DELETE FROM growth_daily_account_rollups WHERE cohort_day IN (SELECT substr(created_at,1,10) FROM growth_account_projection WHERE account_id=?)",
          accountId,
        ),
        stmt("DELETE FROM growth_campaigns WHERE json_extract(body,'$.account_id')=?", accountId),
        stmt(
          "DELETE FROM growth_campaigns WHERE campaign_key IN (SELECT json_extract(body,'$.campaign_key') FROM growth_events WHERE account_id=? OR flow_id IN (SELECT flow_id FROM growth_flows WHERE account_id=?)) AND NOT EXISTS (SELECT 1 FROM growth_events e WHERE json_extract(e.body,'$.campaign_key')=growth_campaigns.campaign_key AND (e.account_id IS NULL OR e.account_id<>?) AND (e.flow_id IS NULL OR e.flow_id NOT IN (SELECT flow_id FROM growth_flows WHERE account_id=?)))",
          accountId,
          accountId,
          accountId,
          accountId,
        ),
        stmt(
          "INSERT OR IGNORE INTO growth_flow_suppression(flow_id,expires_at) SELECT flow_id,expires_at FROM growth_flows WHERE account_id=?",
          accountId,
        ),
        stmt(
          "INSERT OR IGNORE INTO growth_replay_suppression(record_type,record_id,expires_at) SELECT 'event',event_id,strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at,'+30 days') FROM growth_events WHERE flow_id IN (SELECT flow_id FROM growth_flows WHERE account_id=?)",
          accountId,
        ),
        stmt(
          "DELETE FROM growth_milestones WHERE event_id IN (SELECT event_id FROM growth_events WHERE flow_id IN (SELECT flow_id FROM growth_flows WHERE account_id=?))",
          accountId,
        ),
        stmt(
          "DELETE FROM growth_activity WHERE event_id IN (SELECT event_id FROM growth_events WHERE flow_id IN (SELECT flow_id FROM growth_flows WHERE account_id=?))",
          accountId,
        ),
        stmt(
          "DELETE FROM growth_events WHERE flow_id IN (SELECT flow_id FROM growth_flows WHERE account_id=?)",
          accountId,
        ),
        stmt("DELETE FROM growth_flows WHERE account_id=?", accountId),
        ...[
          "growth_account_projection",
          "growth_workspace_observations",
          "growth_membership_snapshots",
          "growth_diagnostic_slots",
          "growth_events",
          "growth_facts",
          "growth_milestones",
          "growth_activity",
          "growth_subjects",
        ].map((table) => stmt(`DELETE FROM ${table} WHERE account_id=?`, accountId)),
        stmt(
          "DELETE FROM growth_dispute_staging WHERE json_extract(body,'$.account_id')=?",
          accountId,
        ),
        stmt(
          "DELETE FROM growth_open_disputes WHERE json_extract(body,'$.account_id')=?",
          accountId,
        ),
        stmt("DELETE FROM growth_exposures WHERE subject_id=?", accountId),
        stmt("DELETE FROM growth_identity_audit WHERE subject_id=?", accountId),
        stmt(
          "DELETE FROM growth_segment_tags WHERE entity_type='account' AND entity_id=?",
          accountId,
        ),
      ]);
    },
  };
}
