import {
  parseUlid,
  parseOperationResult,
  rehydrateOperation,
  type OperationEvent,
} from "@ohmyhost/platform";
import type { OperationView } from "./contracts.js";

export interface D1RecoveryOperation {
  readonly organizationId: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  readonly failure: { code: string; message: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly events: readonly {
    eventId: string;
    projectId: string;
    revision: number;
    type: string;
    idempotencyKey: string | null;
    payload: Record<string, unknown>;
    occurredAt: string;
  }[];
}
export type D1RecoveryOperationRead =
  | { outcome: "absent" | "unported" }
  | { outcome: "ready"; operation: D1RecoveryOperation; blockingOperationId: string | null };
const invalid = (): never => {
  throw new Error("Project recovery operation is inconsistent");
};

/** Same original operation rehydration and projection check; the private wire transports facts, never a pre-authorized
 * public view. No deployment/reconciliation observation is omitted: the backend enables only the recovery kind. */
export function recoveryOperationView(
  stored: D1RecoveryOperation,
  blockingOperationId: string | null,
): OperationView {
  const operationId = parseUlid(stored.operationId);
  const events: OperationEvent[] = stored.events.map((event, revision) => {
    if (event.revision !== revision) return invalid();
    const base = {
      eventId: parseUlid(event.eventId),
      operationId,
      projectId: parseUlid(event.projectId),
      occurredAt: event.occurredAt,
    };
    const keys = Object.keys(event.payload).sort().join(",");
    if (event.type === "OperationQueued") {
      if (event.idempotencyKey !== null || keys !== "") return invalid();
      return { ...base, type: "OperationQueued" };
    }
    if (event.idempotencyKey === null) return invalid();
    const transition = { ...base, idempotencyKey: event.idempotencyKey };
    if (event.type === "OperationFailed") {
      const failure = event.payload["failure"];
      if (
        keys !== "failure" ||
        typeof failure !== "object" ||
        failure === null ||
        Array.isArray(failure) ||
        typeof Reflect.get(failure, "code") !== "string" ||
        typeof Reflect.get(failure, "message") !== "string"
      )
        return invalid();
      const code: unknown = Reflect.get(failure, "code"),
        message: unknown = Reflect.get(failure, "message");
      if (typeof code !== "string" || typeof message !== "string") return invalid();
      return { ...transition, type: "OperationFailed", failure: { code, message } };
    }
    if (event.type === "OperationSucceeded") {
      if (keys !== "" && keys !== "result") return invalid();
      return keys === ""
        ? { ...transition, type: "OperationSucceeded" }
        : {
            ...transition,
            type: "OperationSucceeded",
            result: parseOperationResult(event.payload["result"]),
          };
    }
    if (keys !== "") return invalid();
    if (event.type === "OperationStarted" || event.type === "OperationCancelled")
      return { ...transition, type: event.type };
    return invalid();
  });
  const operation = rehydrateOperation(events);
  if (
    operation.operationId !== stored.operationId ||
    operation.projectId !== stored.projectId ||
    operation.state !== stored.state ||
    operation.createdAt !== stored.createdAt ||
    operation.updatedAt !== stored.updatedAt ||
    (operation.failure?.code ?? null) !== (stored.failure?.code ?? null) ||
    (operation.failure?.message ?? null) !== (stored.failure?.message ?? null)
  )
    return invalid();
  return {
    ...operation,
    ...(blockingOperationId === null
      ? {}
      : { blockingOperationId: parseUlid(blockingOperationId) }),
  };
}
