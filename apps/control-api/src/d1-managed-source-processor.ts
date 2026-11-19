import { z } from "zod";
import { parseUlid, type Clock, type HostingRegion, type UlidFactory } from "@ohmyhost/platform";
import {
  ManagedSourceConflictError,
  ManagedSourceInitializationError,
  type McpDelegationStore,
} from "@ohmyhost/database";
import { ManagedSourceSurfaceError } from "./managed-source-surface.js";
import {
  parseManagedSourceProcessorInput,
  type ManagedSourcePrivateBinding,
} from "./managed-source-composition.js";
import {
  createD1ManagedSourceComposition,
  D1_MANAGED_SOURCE_METHODS,
  managedSourceCoreCall,
  managedSourceInitializationResult,
  managedSourcePublicationResult,
  type D1ManagedSourceRuntime,
} from "./d1-managed-source-store.js";
export interface D1ManagedSourceProcessorRuntime {
  readProcessorManagedSourceInitialization(input: unknown): Promise<unknown>;
  authorizeProcessorManagedSourceInitialization(input: unknown): Promise<unknown>;
  attachProcessorManagedSourceInitializationChild(input: unknown): Promise<unknown>;
  completeProcessorManagedSourceInitializationChild(input: unknown): Promise<unknown>;
  rejectProcessorManagedSourceInitialization(input: unknown): Promise<unknown>;
  readProcessorManagedSourceContext(input: unknown): Promise<unknown>;
  rejectProcessorManagedSourcePublication(input: unknown): Promise<unknown>;
}
export const D1_MANAGED_SOURCE_PROCESSOR_METHODS = [
  "readProcessorManagedSourceInitialization",
  "authorizeProcessorManagedSourceInitialization",
  "attachProcessorManagedSourceInitializationChild",
  "completeProcessorManagedSourceInitializationChild",
  "rejectProcessorManagedSourceInitialization",
  "readProcessorManagedSourceContext",
  "rejectProcessorManagedSourcePublication",
] as const;
export function isD1ManagedSourceProcessorRuntime(
  raw: unknown,
): raw is D1ManagedSourceProcessorRuntime {
  return (
    typeof raw === "object" &&
    raw !== null &&
    D1_MANAGED_SOURCE_PROCESSOR_METHODS.every((m) => typeof Reflect.get(raw, m) === "function")
  );
}
/** Same durable initialization/publication orchestration as the original private Worker; no SQL client is constructed. */
export function createD1ManagedSourceProcessor(input: {
  readonly runtime: D1ManagedSourceRuntime & D1ManagedSourceProcessorRuntime;
  readonly clock: Clock;
  readonly ids: UlidFactory;
  readonly binding: ManagedSourcePrivateBinding;
  readonly namespaces: Readonly<Record<HostingRegion, string>>;
  readonly wake: () => Promise<void>;
  readonly notifyPreviewSource?: (scope: {
    organizationId: string;
    projectId: string;
  }) => Promise<void>;
  readonly delegations: Pick<McpDelegationStore, "ensureConnectionProof">;
}) {
  const runtime = input.runtime;
  if (!isD1ManagedSourceProcessorRuntime(runtime))
    throw new Error("managed_source_processor_core_binding_required");
  const core = (
    method:
      | (typeof D1_MANAGED_SOURCE_METHODS)[number]
      | (typeof D1_MANAGED_SOURCE_PROCESSOR_METHODS)[number],
    request: unknown,
  ) => managedSourceCoreCall(() => runtime[method](request));
  const service = () => createD1ManagedSourceComposition(input),
    readRecipe = async (parent: {
      organizationId: string;
      projectId: string;
      parentOperationId: string;
    }) =>
      managedSourceInitializationResult
        .nullable()
        .parse(await core("readProcessorManagedSourceInitialization", parent));
  const completeChild = async (
    scope: { organizationId: string; projectId: string },
    childOperationId: string,
  ) => {
    z.undefined().parse(
      await core("completeProcessorManagedSourceInitializationChild", {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        childOperationId,
        now: input.clock.now().toISOString(),
      }),
    );
  };
  return {
    async initialize(raw: unknown) {
      const s = parseManagedSourceProcessorInput(raw),
        parent = {
          organizationId: s.organizationId,
          projectId: s.projectId,
          parentOperationId: s.operationId,
        };
      try {
        let recipe = await readRecipe(parent);
        if (recipe === null) throw new Error("Managed source initialization is unavailable");
        if (recipe.childOperationId !== null) {
          await completeChild(s, recipe.childOperationId);
          recipe = await readRecipe(parent);
          if (recipe === null) throw new Error("Managed source initialization is unavailable");
        }
        if (recipe.state === "initialized" || recipe.state === "failed")
          return {
            state: recipe.state,
            ...(recipe.childOperationId === null
              ? {}
              : { childOperationId: recipe.childOperationId }),
          };
        if (recipe.childOperationId !== null)
          return { state: "pending" as const, childOperationId: recipe.childOperationId };
        if (recipe.state === "waiting") return { state: "pending" as const };
        recipe = managedSourceInitializationResult.parse(
          await core("authorizeProcessorManagedSourceInitialization", parent),
        );
        let delegation: import("./contracts.js").ProductSurfaceContext["delegation"];
        if (recipe.creationDelegation !== null) {
          const identity = {
            userId: recipe.principalId.slice(5),
            clientId: recipe.creationDelegation.clientId,
            consentHash: recipe.creationDelegation.consentHash,
            organizationId: recipe.organizationId,
          };
          const grant = await input.delegations.ensureConnectionProof(
            identity,
            recipe.projectId,
            input.clock.now().toISOString(),
          );
          if (grant === null) throw new ManagedSourceInitializationError("scope");
          delegation = {
            grantId: grant.grantId,
            clientId: grant.clientId,
            consentHash: grant.consentHash,
            action: recipe.creationDelegation.action,
            ...(recipe.creationDelegation.authorizationRestriction === undefined
              ? {}
              : { authorizationRestriction: recipe.creationDelegation.authorizationRestriction }),
          };
        }
        const digest = new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
              JSON.stringify([
                "ManagedSourceInitializationV1",
                recipe.organizationId,
                recipe.projectId,
                recipe.parentOperationId,
                recipe.sourceConnectionId,
                recipe.template,
                recipe.principalId,
                recipe.creationDelegation,
              ]),
            ),
          ),
        );
        const operation = await service().initialize(
          {
            organizationId: parseUlid(recipe.organizationId),
            projectId: parseUlid(recipe.projectId),
            principalId: recipe.principalId,
            requestId: recipe.requestId,
            idempotencyKey: `source-initialize:${recipe.parentOperationId}`,
            canonicalRequestDigest: digest,
            reservedSourceConnectionId: recipe.sourceConnectionId,
            ...(delegation === undefined ? {} : { delegation }),
          },
          { template: recipe.template, expected_source_generation: 0 },
        );
        const childOperationId = parseUlid(String(operation.body["id"]));
        z.undefined().parse(
          await core("attachProcessorManagedSourceInitializationChild", {
            ...parent,
            childOperationId,
            now: input.clock.now().toISOString(),
          }),
        );
        await completeChild(s, childOperationId);
        const current = await readRecipe(parent);
        return {
          state:
            current?.state === "initialized"
              ? ("initialized" as const)
              : current?.state === "failed"
                ? ("failed" as const)
                : ("pending" as const),
          childOperationId,
        };
      } catch (error) {
        if (error instanceof ManagedSourceInitializationError && error.kind === "scope") {
          z.undefined().parse(
            await core("rejectProcessorManagedSourceInitialization", {
              ...parent,
              errorCode: "AUTHORIZATION_CHANGED",
              now: input.clock.now().toISOString(),
            }),
          );
          if ((await readRecipe(parent))?.state === "failed") return { state: "failed" as const };
        }
        throw error;
      }
    },
    async process(raw: unknown) {
      const s = parseManagedSourceProcessorInput(raw);
      let originalPrincipal: string | undefined;
      try {
        const observed = z
          .strictObject({
            principalId: z.string(),
            sourceState: z.enum(["staging", "sealed", "committed", "failed"]),
            operationState: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
          })
          .nullable()
          .parse(await core("readProcessorManagedSourceContext", s));
        if (observed === null) throw new Error("Managed source operation is unavailable");
        originalPrincipal = observed.principalId;
        if (
          (observed.sourceState === "committed" && observed.operationState === "succeeded") ||
          (observed.sourceState === "failed" && observed.operationState === "failed")
        ) {
          await completeChild(s, s.operationId);
          return { state: observed.sourceState };
        }
        const context = {
            organizationId: s.organizationId,
            projectId: s.projectId,
            principalId: observed.principalId,
            requestId: `req_${crypto.randomUUID()}`,
          },
          journal = managedSourcePublicationResult.nullable().parse(
            await core("readApiManagedSourcePublication", {
              organizationId: context.organizationId,
              projectId: context.projectId,
              principalId: context.principalId,
              operationId: s.operationId,
            }),
          );
        if (journal === null) throw new Error("Managed source operation is unavailable");
        if (journal.state === "staging") {
          if (Date.parse(journal.expiresAt) <= input.clock.now().getTime()) {
            const rejected = z.boolean().parse(
              await core("rejectProcessorManagedSourcePublication", {
                ...s,
                principalId: originalPrincipal,
                eventId: input.ids.next(),
                now: input.clock.now().toISOString(),
                errorCode: "SOURCE_UPLOAD_EXPIRED",
              }),
            );
            if (rejected) return { state: "failed" as const };
          }
          return { state: "staging" as const };
        }
        const state = await service().execute(context, s.operationId);
        if (state === "committed" || state === "failed") await completeChild(s, s.operationId);
        return { state };
      } catch (error) {
        if (
          originalPrincipal !== undefined &&
          ((error instanceof ManagedSourceConflictError &&
            ["scope", "expired", "commit", "generation"].includes(error.kind)) ||
            (error instanceof ManagedSourceSurfaceError &&
              error.code === "source_scope_unavailable"))
        ) {
          const rejected = z.boolean().parse(
            await core("rejectProcessorManagedSourcePublication", {
              ...s,
              principalId: originalPrincipal,
              eventId: input.ids.next(),
              now: input.clock.now().toISOString(),
              errorCode:
                error instanceof ManagedSourceConflictError && error.kind === "expired"
                  ? "SOURCE_UPLOAD_EXPIRED"
                  : error instanceof ManagedSourceConflictError && error.kind === "commit"
                    ? "SOURCE_COMMIT_CONFLICT"
                    : "AUTHORIZATION_CHANGED",
            }),
          );
          if (rejected) {
            await completeChild(s, s.operationId);
            return { state: "failed" as const };
          }
        }
        throw error;
      }
    },
  };
}
