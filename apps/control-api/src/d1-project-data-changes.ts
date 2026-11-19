import { DeploymentPersistenceConflictError } from "@ohmyhost/database";
import { IdempotencyKeyReusedError } from "./contracts.js";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createDevAccessTicket } from "@ohmyhost/dev-access-tokens";
import { parseUlid, type Clock, type UlidFactory } from "@ohmyhost/platform";
import {
  parseProjectDataChangePlan,
  type ProjectDataChangeKind,
} from "@ohmyhost/contracts/project-data-changes";
import type {
  ProductSurfaceContext,
  ProductSurfaceMutationContext,
  ProductSurfaceResult,
} from "./contracts.js";
import { ProductSurfaceConflictError } from "./contracts.js";
import {
  assertApplicable,
  derivedId,
  digest,
  effects,
  etag,
  type Cipher,
  type State,
} from "./project-data-changes.js";
import { operationResult } from "./product-operation-result.js";
import {
  createD1ProductSurfaceDataPort,
  productCoreCall,
  type D1ProductSurfaceRuntime,
} from "./d1-product-surface.js";
export interface D1ProjectDataChangeRuntime {
  readApiProjectDataChangeState(input: unknown): Promise<unknown>;
  issueApiProjectDataChangePlan(input: unknown): Promise<unknown>;
  acceptApiProductOperation(input: unknown): Promise<unknown>;
}
const id = z.string().transform(parseUlid),
  counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  instant = z
    .string()
    .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const assignment = z.strictObject({
  environmentId: id,
  environment: z.enum(["dev", "prod"]),
  dataEnvironmentId: id,
  assignmentVersion: counter.min(1),
  assignedAt: instant,
});
// The renewal scope Core reads, not an issued ticket scope: epoch 0 is a Dev environment no link or ticket was issued for.
const renewalScope = z.strictObject({
  organizationId: id,
  projectId: id,
  environmentId: id,
  handle: z.string(),
  origin: z.string(),
  devAccessEpoch: counter,
});
const renewal = z.union([
  z.strictObject({ kind: z.literal("absent"), liveShareLinks: z.literal(0) }),
  z.strictObject({
    kind: z.enum(["public", "protected"]),
    scope: renewalScope,
    generation: counter.min(1).nullable(),
    liveShareLinks: counter.max(1),
  }),
]);
const state = z.strictObject({
  lifecycleVersion: counter.min(1),
  billingEpochId: id,
  assignments: z.strictObject({
    dataMode: z.enum(["shared", "isolated"]),
    dev: assignment,
    prod: assignment,
  }),
  environmentHeads: z
    .array(z.strictObject({ environmentId: id, expectedHeadVersion: counter }))
    .length(2),
  registrationGenerations: z
    .array(z.strictObject({ dataEnvironmentId: id, registrationVersion: counter }))
    .min(1)
    .max(2),
  prodDatabaseReady: z.boolean(),
  renewal: renewal.optional(),
});
const accepted = z.strictObject({
  operationId: id,
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  createdAt: instant,
  updatedAt: instant,
  failure: z.strictObject({ code: z.string() }).nullable().optional(),
  failureDiagnostic: z.unknown().optional(),
});
const ROUTE = "/v1/projects/{project_id}/data-changes";
const scope = (i: ProductSurfaceContext) => ({
  organizationId: i.organizationId,
  projectId: i.projectId,
  principalId: i.principalId,
});
async function dataCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await productCoreCall(call);
  } catch (e) {
    const code = e !== null && typeof e === "object" ? Reflect.get(e, "code") : undefined,
      message = e instanceof Error ? e.message : "";
    if (code === "data_change_blocked" || message === "data_change_blocked")
      throw new ProductSurfaceConflictError("data_change_blocked");
    if (code === "data_change_not_applicable" || message === "data_change_not_applicable")
      throw new ProductSurfaceConflictError("data_change_not_applicable");
    throw e;
  }
}
/** Uses the original pure transition, ETag, response text and cipher; only named persistence transport changes. */
export function createD1ProjectDataChanges(input: {
  readonly runtime: D1ProductSurfaceRuntime & D1ProjectDataChangeRuntime;
  readonly clock: Clock;
  readonly ids: UlidFactory;
  readonly devAccessCipher?: Cipher;
}) {
  const persistence = createD1ProductSurfaceDataPort(input.runtime);
  const core = (
    method:
      | "readApiProjectDataChangeState"
      | "issueApiProjectDataChangePlan"
      | "acceptApiProductOperation",
    request: unknown,
  ) => dataCall(() => input.runtime[method](request));
  const read = async (request: ProductSurfaceContext, includeRenewal = false) => {
    const raw = await core("readApiProjectDataChangeState", {
      ...scope(request),
      ...(includeRenewal ? { includeRenewal: true } : {}),
    });
    if (raw === null) return null;
    return state.parse(raw);
  };
  return {
    async plan(
      request: ProductSurfaceContext & { readonly change: ProjectDataChangeKind },
    ): Promise<ProductSurfaceResult | null> {
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await read(request);
        if (current === null) return null;
        const transition = assertApplicable(current, request.change, input.ids.next()),
          now = input.clock.now().toISOString(),
          resourceEtag = etag(request, current, request.change),
          token = randomBytes(32).toString("base64url");
        try {
          await core("issueApiProjectDataChangePlan", {
            ...scope(request),
            billingEpochId: current.billingEpochId,
            expectedProjectVersion: current.lifecycleVersion,
            snapshot: {
              transition,
              environmentHeads: current.environmentHeads,
              registrationGenerations: current.registrationGenerations,
            },
            confirmation: {
              confirmationId: input.ids.next(),
              organizationId: request.organizationId,
              projectId: request.projectId,
              issuedToPrincipalId: request.principalId,
              action: "data_change",
              subjectEtag: resourceEtag,
              tokenDigest: digest(token),
              issuedAt: now,
            },
          });
        } catch (error) {
          const code =
            error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined;
          const message = error instanceof Error ? error.message : "";
          if (
            code === "precondition_changed" ||
            (code === undefined && message.includes("guard_precondition_changed"))
          ) {
            if (attempt < 2) continue;
            throw new ProductSurfaceConflictError("data_change_blocked");
          }
          throw error;
        }
        const body = parseProjectDataChangePlan({
          action: "data_change",
          project_id: request.projectId,
          change: request.change,
          data_mode_before: current.assignments.dataMode,
          data_mode_after: request.change === "share_prod_keeps_data" ? "shared" : "isolated",
          ...effects(request.change),
          redeploy_environments: [request.change === "isolate_dev_keeps_data" ? "prod" : "dev"],
          resource_etag: resourceEtag,
          confirmation_token: token,
          created_at: now,
          expires_at: new Date(Date.parse(now) + 600000).toISOString(),
        });
        return { status: 200, body: { ...body } };
      }
      throw new ProductSurfaceConflictError("data_change_blocked");
    },
    async change(
      request: ProductSurfaceMutationContext & {
        readonly change: ProjectDataChangeKind;
        readonly ifMatch: string;
        readonly confirmationToken: string;
      },
    ): Promise<ProductSurfaceResult | null> {
      const replay = await dataCall(() =>
        persistence.replayAcceptedOperation(request, "POST", ROUTE),
      );
      if (replay !== null) return replay;
      const current = await read(
        request,
        request.change === "share_prod_keeps_data" || request.change === "reset_dev",
      );
      if (current === null) return null;
      const expectedEtag = etag(request, current, request.change);
      if (request.ifMatch !== expectedEtag) throw new ProductSurfaceConflictError("etag_mismatch");
      const operationId = input.ids.next(),
        transition = assertApplicable(
          current,
          request.change,
          derivedId(`data-change:${operationId}`),
        ),
        now = input.clock.now().toISOString();
      const renewalPlan = transition.removeDevDeployment
        ? await sealedRenewal(current, request, input.devAccessCipher)
        : undefined;
      let result: z.output<typeof accepted>;
      try {
        result = accepted.parse(
          await core("acceptApiProductOperation", {
            organizationId: request.organizationId,
            projectId: request.projectId,
            environmentId: current.assignments.dev.environmentId,
            billingEpochId: current.billingEpochId,
            principalId: request.principalId,
            requestId: request.requestId,
            httpMethod: "POST",
            routeTemplate: ROUTE,
            idempotencyKey: request.idempotencyKey,
            canonicalRequestDigest: request.canonicalRequestDigest,
            eventType: "ProjectDataChangeRequestedV1",
            ...(request.delegation === undefined ? {} : { delegation: request.delegation }),
            operationId,
            operationEventId: input.ids.next(),
            auditEventId: input.ids.next(),
            outboxEventId: input.ids.next(),
            occurredAt: now,
            dataChange: request.change,
            dataChangeSnapshot: transition,
            expectedEnvironmentHeads: current.environmentHeads,
            expectedRegistrationGenerations: current.registrationGenerations,
            cleanupRunId: input.ids.next(),
            expectedProjectVersion: current.lifecycleVersion,
            expectedEtag,
            confirmation: {
              organizationId: request.organizationId,
              projectId: request.projectId,
              issuedToPrincipalId: request.principalId,
              action: "data_change",
              subjectEtag: expectedEtag,
              tokenDigest: digest(request.confirmationToken),
              consumedAt: now,
            },
            ...(renewalPlan === undefined ? {} : { devShareRenewal: renewalPlan }),
          }),
        );
      } catch (error) {
        if (error instanceof DeploymentPersistenceConflictError) {
          if (error.message.includes("Idempotency")) throw new IdempotencyKeyReusedError();
          throw new ProductSurfaceConflictError("confirmation_invalid");
        }
        throw error;
      }
      return operationResult(result);
    },
  };
}
async function sealedRenewal(
  current: State & { readonly renewal?: z.output<typeof renewal> },
  request: ProductSurfaceContext,
  cipher: Cipher | undefined,
) {
  const view = current.renewal;
  if (view === undefined) throw new Error("data_change_core_renewal_missing");
  if (view.kind === "absent" || view.kind === "public") return undefined;
  if (
    view.scope.organizationId !== request.organizationId ||
    view.scope.projectId !== request.projectId ||
    view.scope.environmentId !== current.assignments.dev.environmentId
  )
    throw new Error("product_core_response_scope_invalid");
  if (!cipher) throw new Error("Protected data changes require the configured share-link cipher");
  const { token } = await createDevAccessTicket(globalThis.crypto),
    sealed = await cipher.encrypt({
      organizationId: request.organizationId,
      projectId: request.projectId,
      environmentId: view.scope.environmentId,
      name: "DEV_SHARE_LINK",
      value: token,
    });
  return {
    expected: { mode: "protected" as const, scope: view.scope, generation: view.generation },
    sealed,
  };
}
