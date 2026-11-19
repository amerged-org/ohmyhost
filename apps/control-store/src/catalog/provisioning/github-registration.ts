import { z } from "zod";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  routeOrganization,
  ulid,
  instant,
  fenceRaceGuard,
  type CatalogContext,
} from "../common.js";
export const githubConnectionInput = z.strictObject({
  sourceConnectionId: ulid,
  organizationId: ulid,
  projectId: ulid,
  billingEpochId: ulid,
  externalRepositoryId: z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/u)
    .refine((v) => BigInt(v) <= 9007199254740991n),
  createdAt: z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v)
    .pipe(instant),
});
export class GithubRegistrationConflictError extends Error {
  readonly code = "github_source_connection_conflict";
  constructor() {
    super("GitHub source connection conflicts with immutable persisted identity");
    this.name = "GithubSourceConnectionConflictError";
  }
}
export type GithubConnectionInput = z.output<typeof githubConnectionInput>;
const valuesOf = (i: GithubConnectionInput) => [
  i.sourceConnectionId,
  i.organizationId,
  i.projectId,
  i.billingEpochId,
  i.externalRepositoryId,
  i.createdAt,
];
const EXACT =
  "source_connection_id=?1 AND organization_id=?2 AND project_id=?3 AND billing_epoch_id=?4 AND provider='github' AND external_repository_id=?5 AND substr(created_at,1,23)=substr(?6,1,23)";
type Registration = Record<string, unknown> | null;
export async function readGithubRegistration(
  db: D1Database,
  i: GithubConnectionInput,
): Promise<Registration> {
  return db
    .prepare(
      `SELECT *,CASE WHEN ${EXACT} THEN 1 ELSE 0 END exact FROM github_source_connections WHERE source_connection_id=?1`,
    )
    .bind(...valuesOf(i))
    .first<Record<string, unknown>>();
}
/** Server-local plan for the SourceLink parent to compose in its original completion batch. */
export function githubRegistrationStatements(
  db: D1Database,
  i: GithubConnectionInput,
  existing: Registration,
): D1PreparedStatement[] {
  if (existing) {
    if (existing["exact"] !== 1) throw new GithubRegistrationConflictError();
    return [];
  }
  const values = valuesOf(i);
  return [
    db
      .prepare(
        "INSERT INTO github_source_connections(source_connection_id,organization_id,project_id,billing_epoch_id,provider,external_repository_id,created_at) VALUES(?1,?2,?3,?4,'github',?5,?6)",
      )
      .bind(...values),
    db
      .prepare(
        "INSERT INTO source_connections(source_connection_id,organization_id,project_id,billing_epoch_id,provider,external_repository_id,created_at) VALUES(?1,?2,?3,?4,'github',?5,?6)",
      )
      .bind(...values),
    guard(
      db,
      "precondition_changed",
      `NOT EXISTS(SELECT 1 FROM github_source_connections WHERE ${EXACT})`,
      values,
    ),
  ];
}
/** Original GitHub registration and its authoritative source_connections effect commit together.
 * The same plan composes inside the full SourceLink completion; no separate public/RPC method exists. */
export async function recordGithubSourceConnection(
  context: CatalogContext,
  raw: unknown,
): Promise<"created" | "existing"> {
  const i = githubConnectionInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId);
  const command: Command<Registration, "created" | "existing"> = {
    name: "provisioning.registerGithubSource",
    input: i,
    naturalKeyTables: ["github_source_connections"],
    read: (reader) => readGithubRegistration(reader, i),
    decide: (existing) => ({
      statements: [
        fenceRaceGuard(db, "operation_conflict", i.organizationId),
        ...githubRegistrationStatements(db, i, existing),
      ],
      result: () => (existing === null ? "created" : "existing"),
    }),
    lookup: async (reader) =>
      (await reader
        .prepare(`SELECT 1 FROM github_source_connections WHERE ${EXACT}`)
        .bind(...valuesOf(i))
        .first()) === null
        ? undefined
        : "existing",
  };
  return runCommand(db, command);
}
