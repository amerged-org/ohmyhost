import { createHash } from "node:crypto";

import { AI_KEY_NAME, type AiKeyScope } from "@ohmyhost/platform/shared";

import type { CatalogContext } from "../../src/catalog/common.js";
import { runGrantCredit, setPaid } from "../../src/catalog/credit/index.js";
import type { D1Database } from "../../src/d1-types.js";
import { SharedCoreRouter } from "../../src/router.js";
import type { TestControl } from "../support/control-d1.js";
import { STORED_NOW, type SeededProject } from "../support/platform-fixtures.js";
import { newOrganization } from "../credit/support.js";
import { releaseProviderClaim, seedPublishedClaim } from "../support/accepted-operation.js";
import { seedWfpPublication, sourceFrameworkPlan } from "../support/provider-fixtures.js";

export const AI_CARD = "ai-card-1390895";
/** The live example of the money model: 3_600 nano-USD (3.6 USD micros) on 1_390_895 credit micros per 10_000 USD micros. */
export const LIVE_COST_NANO = 3_600n;
export const LIVE_CHARGE_MICROS = 501;
/** The reservation of a 100_000 nano-USD estimate on the same card: 100 USD micros at 1_390_895 per 10_000. */
export const ESTIMATE_NANO = 100_000n;
export const ESTIMATE_MICROS = 13_909;

/** The Core clock is the real one; the fixtures are written at the wall clock and dated in the past where it matters. */
export const nowIso = () => new Date().toISOString();

export const context = (control: TestControl): CatalogContext => ({
  directory: control.core,
  router: new SharedCoreRouter(control.core),
});

/** A gateway key of the documented shape; the Core only compares its digest. */
export const keyOf = (projectId: string) => `omh_ai_${projectId}_${"a".repeat(43)}`;
export const digestOf = (key: string) => createHash("sha256").update(key).digest("hex");
const digestBytes = (key: string) => Uint8Array.from(createHash("sha256").update(key).digest());

/** Publishes the AI rate card and activates its meter from 2026-01-01. */
export async function publishAiCard(
  db: D1Database,
  options: {
    readonly card?: string;
    readonly creditMicros?: number;
    readonly unitsPerCharge?: number;
  } = {},
): Promise<void> {
  const card = options.card ?? AI_CARD;
  const rates = JSON.stringify([
    {
      meter: "ai.cost",
      unit: "usd_micro",
      units_per_charge: String(options.unitsPerCharge ?? 10_000),
      provider_cost_micros: null,
      credit_micros: String(options.creditMicros ?? 1_390_895),
    },
  ]);
  await db
    .prepare(
      "INSERT INTO published_credit_rate_cards(rate_card_id, published_at, effective_from, rates) VALUES (?1, ?2, ?2, ?3)",
    )
    .bind(card, "2026-01-01T00:00:00.000000Z", rates)
    .run();
  await db
    .prepare(
      "INSERT INTO usage_meter_activations(meter, rate_card_id, starts_at, activated_at) VALUES ('ai.cost', ?1, ?2, ?2)",
    )
    .bind(card, "2026-01-01T00:00:00.000000Z")
    .run();
}

/** Installs the gateway key of one environment as an `OHMYHOST_AI_KEY` secret row. */
export async function installKey(
  db: D1Database,
  project: Pick<SeededProject, "organizationId" | "projectId">,
  environmentId: string,
  key: string,
  name = AI_KEY_NAME,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO environment_secrets(organization_id, project_id, environment_id, name, ciphertext, nonce, value_sha256, key_version, revision, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 1, ?8, ?8)",
    )
    .bind(
      project.organizationId,
      project.projectId,
      environmentId,
      name,
      new Uint8Array(17).fill(1),
      new Uint8Array(12).fill(2),
      digestBytes(key),
      STORED_NOW,
    )
    .run();
}

/**
 * Publishes a revision of one environment whose plan is `frameworkPlan` and moves the environment's head to it, the way a
 * deployment does. The head is the only plan the gateway reads the jurisdiction from.
 */
export async function publishPlan(
  project: SeededProject,
  environmentId: string,
  frameworkPlan: unknown,
): Promise<{
  readonly deploymentId: string;
  readonly revisionId: string;
  readonly planId: string;
}> {
  const { published } = await seedPublishedClaim(project, environmentId, (operationId) =>
    seedWfpPublication(project, { operationId, environmentId, frameworkPlan }),
  );
  await releaseProviderClaim(project);
  return published;
}

/** The plan of an environment that declares AI: the source plan of the fixtures plus the optional `ai` key. */
export const aiPlan = (jurisdiction: "eu" | "any") => ({
  ...sourceFrameworkPlan(false),
  ai: { enabled: true, jurisdiction },
});

/** Makes the organization Paid until 2099 (a manual coverage) and grants `credits` one-time credit. */
export async function makePaid(db: D1Database, organizationId: string, credits = 0): Promise<void> {
  const now = nowIso();
  await db.batch(
    setPaid(db, { organizationId, paidUntil: "2099-01-01T00:00:00.000000Z", source: "manual", now })
      .statements,
  );
  if (credits > 0) {
    await runGrantCredit(db, {
      organizationId,
      key: `topup:${organizationId}`,
      kind: "onetime",
      amountMicros: credits * 1_000_000,
      now,
    });
  }
}

export interface AiProject {
  readonly context: CatalogContext;
  readonly project: SeededProject;
  readonly key: string;
  readonly scope: AiKeyScope;
}

/**
 * A Paid organization whose project has its gateway key on the development environment and a published plan that
 * declares AI with the jurisdiction; `credits` is the one-time credit it starts with (the monthly allowance of Paid is
 * on top).
 */
export async function readyProject(
  control: TestControl,
  options: {
    readonly paid?: boolean;
    readonly credits?: number;
    readonly jurisdiction?: "eu" | "any";
  } = {},
): Promise<AiProject> {
  const project = await newOrganization(control);
  const key = keyOf(project.projectId);
  await installKey(control.core, project, project.devEnvironmentId, key);
  const ctx = context(control);
  await publishPlan(project, project.devEnvironmentId, aiPlan(options.jurisdiction ?? "eu"));
  if (options.paid !== false)
    await makePaid(control.core, project.organizationId, options.credits ?? 0);
  return {
    context: ctx,
    project,
    key,
    scope: {
      organizationId: project.organizationId,
      projectId: project.projectId,
      environmentId: project.devEnvironmentId,
      jurisdiction: options.jurisdiction ?? "eu",
    },
  };
}

/** The monthly and one-time credit an organization holds right now, for before-and-after comparisons. */
export async function balanceOf(db: D1Database, organizationId: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT monthly_micros + onetime_micros AS balance FROM credit_account WHERE organization_id = ?1",
    )
    .bind(organizationId)
    .first<{ balance: number }>();
  return row?.balance ?? 0;
}

export async function reservedOf(db: D1Database, organizationId: string): Promise<number> {
  const row = await db
    .prepare("SELECT reserved_micros FROM credit_account WHERE organization_id = ?1")
    .bind(organizationId)
    .first<{ reserved_micros: number }>();
  return row?.reserved_micros ?? 0;
}

export async function openReservations(db: D1Database, organizationId: string): Promise<string[]> {
  return (
    await db
      .prepare(
        "SELECT reservation_id FROM credit_reservation WHERE organization_id = ? ORDER BY reservation_id",
      )
      .bind(organizationId)
      .all<{ reservation_id: string }>()
  ).results.map((row) => row.reservation_id);
}

/** The marker the gateway writes with each admitted call (`ai_gateway_reservations`), for a reservation made by hand. */
export async function markAiReservation(
  db: D1Database,
  scope: Pick<AiKeyScope, "organizationId" | "projectId" | "environmentId">,
  reservationId: string,
  createdAt: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO ai_gateway_reservations(reservation_id, organization_id, project_id, environment_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(reservationId, scope.organizationId, scope.projectId, scope.environmentId, createdAt)
    .run();
}
