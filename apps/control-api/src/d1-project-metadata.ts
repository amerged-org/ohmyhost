import {
  PoweredByFlagRequiredError,
  PoweredByFlagIdempotencyConflictError,
  ProjectNotesConflict,
} from "@ohmyhost/database";
import type { Clock, UlidFactory } from "@ohmyhost/platform";
import type { ProjectNotesPort } from "./project-context.js";
import type { PoweredByFlagPort } from "./powered-by-flag.js";
export interface D1ProjectMetadataRuntime {
  readProjectNotes(input: unknown): ReturnType<ProjectNotesPort["get"]>;
  writeProjectNotes(input: unknown): ReturnType<ProjectNotesPort["set"]>;
  readProjectStorageJurisdiction(
    input: unknown,
  ): ReturnType<ProjectNotesPort["storageJurisdiction"]>;
  readPoweredByFlag(input: unknown): ReturnType<PoweredByFlagPort["get"]>;
  setPoweredByFlag(input: unknown): ReturnType<PoweredByFlagPort["set"]>;
}
export function isD1ProjectMetadataRuntime(value: unknown): value is D1ProjectMetadataRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    [
      "readProjectNotes",
      "writeProjectNotes",
      "readProjectStorageJurisdiction",
      "readPoweredByFlag",
      "setPoweredByFlag",
    ].every((method) => typeof Reflect.get(value, method) === "function")
  );
}
/** The original public adapter clocks/IDs stay local; only exact typed metadata crosses Core. */
export function createD1ProjectMetadataPorts(input: {
  runtime: D1ProjectMetadataRuntime;
  clock: Clock;
  ids: UlidFactory;
}): { projectNotes: ProjectNotesPort; poweredByFlag: PoweredByFlagPort } {
  const scope = (context: Parameters<ProjectNotesPort["get"]>[0]) => ({
    organizationId: context.organizationId,
    projectId: context.projectId,
  });
  const failure = (error: unknown): never => {
    const code =
        error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined,
      message = error instanceof Error ? error.message : "";
    for (const kind of ["scope", "version", "idempotency"] as const)
      if (code === `project_notes_${kind}` || message === `project_notes_${kind}`)
        throw new ProjectNotesConflict(kind);
    if (code === "powered_by_flag_required" || message === "powered_by_flag_required")
      throw new PoweredByFlagRequiredError();
    if (code === "powered_by_flag_idempotency" || message === "powered_by_flag_idempotency")
      throw new PoweredByFlagIdempotencyConflictError();
    throw error;
  };
  const projectNotes: ProjectNotesPort = {
    get: (context) => input.runtime.readProjectNotes(scope(context)),
    storageJurisdiction: (context) => input.runtime.readProjectStorageJurisdiction(scope(context)),
    async set(request) {
      try {
        return await input.runtime.writeProjectNotes({
          ...scope(request),
          principalId: request.principalId,
          idempotencyKey: request.idempotencyKey,
          canonicalRequestDigest: Buffer.from(request.canonicalRequestDigest).toString("hex"),
          expectedVersion: request.expectedVersion,
          markdown: request.markdown,
          now: input.clock.now().toISOString(),
          eventId: input.ids.next(),
        });
      } catch (error) {
        return failure(error);
      }
    },
  };
  const poweredByFlag: PoweredByFlagPort = {
    get: (context) => input.runtime.readPoweredByFlag(scope(context)),
    async set(request) {
      try {
        return await input.runtime.setPoweredByFlag({
          ...scope(request),
          principalId: request.principalId,
          idempotencyKey: request.idempotencyKey,
          canonicalRequestDigest: Buffer.from(request.canonicalRequestDigest).toString("hex"),
          enabled: request.enabled,
          now: input.clock.now().toISOString(),
          periodId: input.ids.next(),
          eventId: input.ids.next(),
        });
      } catch (error) {
        return failure(error);
      }
    },
  };
  return { projectNotes, poweredByFlag };
}
