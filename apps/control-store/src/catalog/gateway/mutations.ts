import type { SharedGatewayReceipt } from "@ohmyhost/platform";
import { parseBrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Command, type Plan } from "../../run-command.js";
import { publicTimestamp, routeOrganization, type CatalogContext } from "../common.js";
import {
  activateInput,
  mutationInput,
  scopeInput,
  canonicalOrigin,
  SharedGatewayConflictError,
  type Activation,
  type Mutation,
} from "./contracts.js";
import { MUTATION_STATE, mutationParams, readMutationDocument } from "./facts.js";

interface Candidate {
  organization_id: string;
  project_id: string;
  environment_id: string;
  environment_name: "dev" | "prod";
  candidate_receipt_id: string;
  product_deployment_id: string;
  immutable_script_name: string;
  artifact_sha256: string;
  provider_tag: string;
}
export interface Route extends Candidate {
  revision: string;
  predecessor_revision: string | null;
  operation_id: string;
  action: "activate" | "remove" | "compensate";
  active: 0 | 1;
  handle: string;
  public_origin: string;
  egress_allowed_origins: string[];
  browser_policy: unknown;
  observed_at: string;
}
interface Authority {
  handle: string;
  public_origin: string;
}
interface State {
  authority: Authority | null;
  deletion: Authority | null;
  latest: Route | null;
  base: Route | null;
  prior: Route | null;
  candidate: Candidate | null;
  available: string[];
  cleared: 0 | 1;
  fallback: 0 | 1;
  rename: 0 | 1;
}
interface Snapshot {
  document: string;
  state: State;
  latestReceipt: SharedGatewayReceipt | null;
  selectedDigest?: `sha256:${string}` | null;
}
type Mode = "activate" | "remove" | "compensate";
interface NextState {
  target: Candidate;
  active: boolean;
  handle: string;
  public_origin: string;
  origins: string[];
  browser: unknown;
}
const conflict = (): never => {
  throw new SharedGatewayConflictError();
};
export function revisionOf(value: string): number {
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 1 ? result : conflict();
}
const predecessorOf = (row: Route) =>
  row.predecessor_revision === null ? null : revisionOf(row.predecessor_revision);
async function digest(origins: readonly string[]): Promise<`sha256:${string}`> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(origins))),
  );
  return `sha256:${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
function verifyTarget(row: Candidate): void {
  scopeInput.parse({
    organizationId: row.organization_id,
    projectId: row.project_id,
    environmentId: row.environment_id,
  });
  if (
    !(row.environment_name === "dev" || row.environment_name === "prod") ||
    row.immutable_script_name !==
      `p-${row.project_id.toLowerCase()}-${row.environment_name}-${row.product_deployment_id.toLowerCase()}` ||
    !/^[a-f0-9]{64}$/u.test(row.artifact_sha256)
  )
    return conflict();
}
/** Same native receipt as the original PG reader, including its millisecond public timestamp and exact array hash. */
export async function receiptOf(row: Route): Promise<SharedGatewayReceipt> {
  verifyTarget(row);
  const origins = activateInput.shape.egressAllowedOrigins.parse(row.egress_allowed_origins);
  if (!canonicalOrigin(row.public_origin) || !Number.isFinite(Date.parse(row.observed_at)))
    return conflict();
  return Object.freeze({
    provider: "ohmyhost-shared-gateway",
    organizationId: row.organization_id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    environmentName: row.environment_name,
    handle: row.handle,
    hostname: new URL(row.public_origin).hostname,
    publicOrigin: row.public_origin,
    targetDeploymentId: row.product_deployment_id,
    targetScriptName: row.immutable_script_name,
    targetArtifactDigest: `sha256:${row.artifact_sha256}`,
    targetProviderTag: row.provider_tag,
    egressPolicyDigest: await digest(origins),
    egressAllowedOrigins: Object.freeze(origins),
    ...(row.browser_policy === null
      ? {}
      : { browserPolicy: parseBrowserPolicy(row.browser_policy) }),
    candidateReceiptId: row.candidate_receipt_id,
    revision: revisionOf(row.revision),
    predecessorRevision: predecessorOf(row),
    operationId: row.operation_id,
    active: row.active === 1,
    observedAt: new Date(publicTimestamp(row.observed_at)),
  });
}

function baseOf(state: State, input: Mutation): Route | null {
  const latest = state.latest;
  if ((latest === null ? null : revisionOf(latest.revision)) === input.expectedRevision)
    return latest;
  if (
    input.expectedRevision === null &&
    latest !== null &&
    latest.active === 0 &&
    latest.operation_id !== input.operationId &&
    state.cleared === 1
  )
    return null;
  if (state.fallback !== 1) return conflict();
  return input.expectedRevision === null ? null : (state.base ?? conflict());
}
function sameReplay(state: State, input: Mutation, mode: Mode): boolean {
  return (
    state.latest !== null &&
    state.latest.operation_id === input.operationId &&
    state.latest.action === mode &&
    predecessorOf(state.latest) === input.expectedRevision
  );
}
function nextOf(state: State, input: Mutation, mode: Mode): NextState {
  const authority = state.authority ?? (mode === "remove" ? state.deletion : null);
  if (authority === null) return conflict();
  if (mode !== "remove" && !canonicalOrigin(authority.public_origin)) return conflict();
  if (mode === "activate") {
    baseOf(state, input);
    const activation = input as Activation,
      target = state.candidate;
    if (target === null || !state.available.includes(activation.candidateReceiptId))
      return conflict();
    return {
      target,
      active: true,
      handle: authority.handle,
      public_origin: authority.public_origin,
      origins: activation.egressAllowedOrigins,
      browser: activation.browserPolicy ?? null,
    };
  }
  if (mode === "remove") {
    const base = baseOf(state, input);
    if (base === null || base.active !== 1) return conflict();
    return {
      target: base,
      active: false,
      handle: base.handle,
      public_origin: base.public_origin,
      origins: base.egress_allowed_origins,
      browser: base.browser_policy,
    };
  }
  const latest = state.latest;
  if (
    latest === null ||
    revisionOf(latest.revision) !== input.expectedRevision ||
    latest.operation_id !== input.operationId ||
    latest.action !== "activate"
  )
    return conflict();
  const previous = state.prior;
  if (latest.predecessor_revision !== null && previous === null) return conflict();
  if (previous !== null) {
    if (
      (previous.handle !== authority.handle ||
        previous.public_origin !== authority.public_origin) &&
      state.rename !== 1
    )
      return conflict();
    if (previous.active === 1 && !state.available.includes(previous.candidate_receipt_id))
      return conflict();
  }
  const target = previous ?? latest;
  return {
    target,
    active: previous?.active === 1,
    handle: target.handle,
    public_origin: target.public_origin,
    origins: target.egress_allowed_origins,
    browser: target.browser_policy,
  };
}

/** Each original route mutation is ONE guarded Core batch; provider calls remain outside this catalog. */
async function mutationCommand(
  context: CatalogContext,
  raw: unknown,
  mode: Mode,
  routed?: D1Database,
) {
  const input: Mutation | Activation = (mode === "activate" ? activateInput : mutationInput).parse(
      raw,
    ),
    db = routed ?? (await routeOrganization(context, input.organizationId)).db,
    params = mutationParams(
      input,
      mode === "activate" ? (input as Activation).candidateReceiptId : "",
      mode === "remove",
    );
  const read = async (reader: typeof db): Promise<Snapshot> => {
    const document = await readMutationDocument(reader, params),
      state = JSON.parse(document) as State;
    return {
      document,
      state,
      // Original mutations validate the returned receipt, not an unused failed successor's metadata.
      latestReceipt:
        sameReplay(state, input, mode) && state.latest !== null
          ? await receiptOf(state.latest)
          : null,
    };
  };
  const decide = (
    snapshot: Snapshot,
    egressDigest: `sha256:${string}` | null,
  ): Plan<SharedGatewayReceipt> => {
    const { state } = snapshot,
      authority = state.authority ?? (mode === "remove" ? state.deletion : null);
    if (authority === null || (mode !== "remove" && !canonicalOrigin(authority.public_origin)))
      return { reject: new SharedGatewayConflictError() };
    if (sameReplay(state, input, mode)) {
      const latest = state.latest;
      if (latest === null || snapshot.latestReceipt === null) return conflict();
      if (mode === "activate") {
        const activation = input as Activation;
        if (
          latest.candidate_receipt_id !== activation.candidateReceiptId ||
          JSON.stringify(latest.egress_allowed_origins) !==
            JSON.stringify(activation.egressAllowedOrigins) ||
          JSON.stringify(latest.browser_policy ?? null) !==
            JSON.stringify(activation.browserPolicy ?? null) ||
          latest.handle !== authority.handle ||
          latest.public_origin !== authority.public_origin
        )
          return { reject: new SharedGatewayConflictError() };
      }
      return { replay: snapshot.latestReceipt };
    }
    const next = nextOf(state, input, mode),
      revision = (state.latest === null ? 0 : revisionOf(state.latest.revision)) + 1;
    if (!Number.isSafeInteger(revision)) return conflict();
    verifyTarget(next.target);
    const template: Omit<SharedGatewayReceipt, "observedAt"> = {
      provider: "ohmyhost-shared-gateway",
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      environmentName: next.target.environment_name,
      handle: next.handle,
      hostname: new URL(next.public_origin).hostname,
      publicOrigin: next.public_origin,
      targetDeploymentId: next.target.product_deployment_id,
      targetScriptName: next.target.immutable_script_name,
      targetArtifactDigest: `sha256:${next.target.artifact_sha256}`,
      targetProviderTag: next.target.provider_tag,
      egressPolicyDigest: egressDigest ?? conflict(),
      egressAllowedOrigins: next.origins,
      ...(next.browser === null ? {} : { browserPolicy: parseBrowserPolicy(next.browser) }),
      candidateReceiptId: next.target.candidate_receipt_id,
      revision,
      predecessorRevision: input.expectedRevision,
      operationId: input.operationId,
      active: next.active,
    };
    return {
      statements: [
        guard(db, "precondition_changed", `(${MUTATION_STATE}) IS NOT ?9`, [
          ...params,
          snapshot.document,
        ]),
        db
          .prepare(
            `INSERT INTO shared_gateway_route_revisions(organization_id,project_id,environment_id,revision,predecessor_revision,operation_id,candidate_receipt_id,action,active,handle,public_origin,egress_allowed_origins,browser_policy,observed_at)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') RETURNING observed_at`,
          )
          .bind(
            input.organizationId,
            input.projectId,
            input.environmentId,
            revision,
            input.expectedRevision,
            input.operationId,
            next.target.candidate_receipt_id,
            mode,
            next.active ? 1 : 0,
            next.handle,
            next.public_origin,
            JSON.stringify(next.origins),
            next.browser === null ? null : JSON.stringify(next.browser),
          ),
      ],
      result: (results) => {
        const at = results[1]?.results[0]?.["observed_at"];
        if (typeof at !== "string") return conflict();
        return { ...template, observedAt: new Date(publicTimestamp(at)) };
      },
    };
  };
  // The selected predecessor's array determines compensation/removal hashes; a decision still uses one snapshot.
  const command: Command<Snapshot, SharedGatewayReceipt> = {
    name: `gateway.${mode}`,
    input,
    read: async (reader) => {
      const snapshot = await read(reader);
      const next = sameReplay(snapshot.state, input, mode)
        ? null
        : nextOf(snapshot.state, input, mode);
      return { ...snapshot, selectedDigest: next === null ? null : await digest(next.origins) };
    },
    decide: (snapshot) => decide(snapshot, snapshot.selectedDigest ?? null),
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["shared_gateway_route_revisions"],
    lookup: async (reader) => {
      const snapshot = await read(reader);
      if (!sameReplay(snapshot.state, input, mode)) return undefined;
      const replay = decide(snapshot, null);
      return "replay" in replay ? replay.replay : undefined;
    },
  };
  return { db, command, input };
}
async function mutate(context: CatalogContext, raw: unknown, mode: Mode) {
  const { db, command } = await mutationCommand(context, raw, mode);
  return runCommand(db, command);
}
/**
 * Server-local compensation plan for the original rename transaction; never an RPC or SQL callback. Its statements
 * are prepared on `routed`, the database of the caller's own transaction: a fenced database refuses any other's.
 */
export async function planGatewayCompensation(
  context: CatalogContext,
  raw: unknown,
  routed: D1Database,
) {
  const { db, command, input } = await mutationCommand(context, raw, "compensate", routed),
    snapshot = await command.read(db),
    plan = command.decide(snapshot);
  if ("reject" in plan) throw plan.reject;
  if ("replay" in plan) return { statements: [], publicOrigin: plan.replay.publicOrigin };
  const next = nextOf(snapshot.state, input, "compensate");
  return { statements: plan.statements, publicOrigin: next.public_origin };
}
export const activateGatewayRoute = (context: CatalogContext, raw: unknown) =>
  mutate(context, raw, "activate");
export const removeGatewayRoute = (context: CatalogContext, raw: unknown) =>
  mutate(context, raw, "remove");
export const compensateGatewayRoute = (context: CatalogContext, raw: unknown) =>
  mutate(context, raw, "compensate");
