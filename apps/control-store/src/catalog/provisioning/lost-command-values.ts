// Literal original operation aggregate validation used by lost-command abandonment.
import {
  parseUlid,
  parseOperationResult,
  type Operation,
  type OperationEvent,
  type OperationFailure,
  type OperationResult,
  type OperationState,
} from "@ohmyhost/platform";
import {
  parseOperationFailureDiagnostic,
  type OperationFailureDiagnostic,
} from "@ohmyhost/contracts/operation-failure";
interface QueryResultRow {
  [column: string]: unknown;
}
export interface OperationRow extends QueryResultRow {
  operation_id: string;
  project_id: string;
  state: string;
  failure: unknown;
  created_at: Date;
  updated_at: Date;
  billing_epoch_id: string;
}

export interface OperationEventRow extends QueryResultRow {
  event_id: string;
  operation_id: string;
  project_id: string;
  revision: number;
  event_type: string;
  idempotency_key: string | null;
  payload: unknown;
  occurred_at: Date;
}

export type StoredOperation = Operation & {
  readonly failureDiagnostic?: OperationFailureDiagnostic;
};

export function operationEventFromRow(row: OperationEventRow): OperationEvent {
  const base = {
    eventId: parseUlid(row.event_id),
    operationId: parseUlid(row.operation_id),
    projectId: parseUlid(row.project_id),
    occurredAt: row.occurred_at.toISOString(),
  } as const;
  const payload = recordPayload(row.payload);

  if (row.event_type === "OperationQueued") {
    assertPayloadKeys(payload, []);
    if (row.idempotency_key !== null) {
      throw new TypeError("Queued operation event cannot have an idempotency key");
    }
    return { ...base, type: row.event_type };
  }
  if (row.idempotency_key === null) {
    throw new TypeError("Operation transition event requires an idempotency key");
  }
  if (row.event_type === "OperationFailed") {
    assertPayloadKeys(payload, ["failure"]);
    return {
      ...base,
      type: row.event_type,
      idempotencyKey: row.idempotency_key,
      failure: failurePayload(payload["failure"]),
    };
  }
  if (row.event_type === "OperationSucceeded") {
    if (Object.keys(payload).length === 0) {
      return { ...base, type: row.event_type, idempotencyKey: row.idempotency_key };
    }
    assertPayloadKeys(payload, ["result"]);
    return {
      ...base,
      type: row.event_type,
      idempotencyKey: row.idempotency_key,
      result: parseOperationResult(payload["result"]),
    };
  }
  assertPayloadKeys(payload, []);
  if (row.event_type === "OperationStarted" || row.event_type === "OperationCancelled") {
    return { ...base, type: row.event_type, idempotencyKey: row.idempotency_key };
  }
  throw new TypeError(`Unsupported operation event type '${row.event_type}'`);
}

export function storedOperation(row: OperationRow, operation: Operation): StoredOperation {
  const { diagnostic, ...failure } = recordPayload(row.failure ?? {});
  const projection: Operation = {
    operationId: parseUlid(row.operation_id),
    projectId: parseUlid(row.project_id),
    state: operationState(row.state),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.failure === null ? {} : { failure: failurePayload(failure) }),
    ...(operation.result === undefined ? {} : { result: operation.result }),
    events: operation.events,
  };
  if (!operationsEqual(projection, operation)) {
    throw new Error("Operation projection does not match its immutable event history");
  }
  const failureDiagnostic = parseOperationFailureDiagnostic(diagnostic);
  return failureDiagnostic === null
    ? operation
    : Object.freeze({ ...operation, failureDiagnostic });
}

export function operationState(value: string): OperationState {
  if (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new TypeError(`Unsupported operation state '${value}'`);
}

export function recordPayload(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Operation event payload must be an object");
  }
  return value as Record<string, unknown>;
}

export function assertPayloadKeys(
  payload: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Object.keys(payload).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError("Operation event payload does not match its event type");
  }
}

export function failurePayload(value: unknown): OperationFailure {
  const payload = recordPayload(value);
  assertPayloadKeys(payload, ["code", "message"]);
  if (
    typeof payload["code"] !== "string" ||
    payload["code"].trim() === "" ||
    typeof payload["message"] !== "string" ||
    payload["message"].trim() === ""
  ) {
    throw new TypeError("Operation failure code and message are required");
  }
  return { code: payload["code"], message: payload["message"] };
}

export function operationsEqual(left: Operation, right: Operation): boolean {
  return (
    left.operationId === right.operationId &&
    left.projectId === right.projectId &&
    left.state === right.state &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    failuresEqual(left.failure, right.failure) &&
    resultsEqual(left.result, right.result) &&
    left.events.length === right.events.length &&
    left.events.every((event, index) => eventsEqual(event, right.events[index]))
  );
}

export function failuresEqual(
  left: OperationFailure | undefined,
  right: OperationFailure | undefined,
) {
  return left === undefined
    ? right === undefined
    : right !== undefined && left.code === right.code && left.message === right.message;
}

export function resultsEqual(
  left: OperationResult | undefined,
  right: OperationResult | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

export function eventsEqual(left: OperationEvent, right: OperationEvent | undefined): boolean {
  if (
    right === undefined ||
    left.type !== right.type ||
    left.eventId !== right.eventId ||
    left.operationId !== right.operationId ||
    left.projectId !== right.projectId ||
    left.occurredAt !== right.occurredAt
  ) {
    return false;
  }
  if (left.type === "OperationQueued" || right.type === "OperationQueued") {
    return left.type === right.type;
  }
  if (left.idempotencyKey !== right.idempotencyKey) {
    return false;
  }
  if (left.type === "OperationSucceeded" && right.type === "OperationSucceeded") {
    return resultsEqual(left.result, right.result);
  }
  return left.type !== "OperationFailed" || right.type !== "OperationFailed"
    ? left.type === right.type
    : failuresEqual(left.failure, right.failure);
}
