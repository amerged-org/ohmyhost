import {
  parseUlid,
  parseOperationResult,
  rehydrateOperation,
  type OperationEvent,
} from "@ohmyhost/platform";
import { parseOperationFailureDiagnostic } from "@ohmyhost/contracts/operation-failure";
import type { D1Database } from "../../d1-types.js";
import { publicTimestamp } from "../common.js";
type Row = Record<string, unknown>;
const object = (value: unknown): Row => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Operation history payload is invalid");
  return value as Row;
};
function failureOf(value: unknown) {
  const f = object(value);
  if (
    Object.keys(f).sort().join(",") !== "code,message" ||
    typeof f["code"] !== "string" ||
    f["code"].trim() === "" ||
    typeof f["message"] !== "string" ||
    f["message"].trim() === ""
  )
    throw new TypeError("Operation failure code and message are required");
  return { code: f["code"], message: f["message"] };
}
/** Native accepted-operation projection, checked against the immutable history before returning public fields. */
export function acceptedOperationOf(row: Row | undefined, rows: readonly Row[]) {
  if (!row) throw new Error("Accepted operation projection is unavailable");
  const operationId = parseUlid(String(row["operation_id"])),
    projectId = parseUlid(String(row["project_id"]));
  const events = rows.map((r, n): OperationEvent => {
    if (r["revision"] !== n)
      throw new Error("Operation event revisions must be contiguous and start at zero");
    const scope = {
      eventId: parseUlid(String(r["event_id"])),
      operationId,
      projectId: parseUlid(String(r["project_id"])),
      occurredAt: publicTimestamp(String(r["occurred_at"])),
    };
    const payload = object(JSON.parse(String(r["payload"]))),
      type = String(r["event_type"]),
      key = r["idempotency_key"];
    if (type === "OperationQueued") {
      if (key !== null || Object.keys(payload).length)
        throw new TypeError("Queued operation history is invalid");
      return { ...scope, type };
    }
    if (typeof key !== "string")
      throw new TypeError("Operation transition requires its idempotency key");
    if (type === "OperationFailed") {
      if (Object.keys(payload).join(",") !== "failure")
        throw new TypeError("Operation failure history is invalid");
      return {
        ...scope,
        type,
        idempotencyKey: key,
        failure: failureOf(payload["failure"]),
      };
    }
    if (type === "OperationSucceeded") {
      if (Object.keys(payload).length === 0) return { ...scope, type, idempotencyKey: key };
      if (Object.keys(payload).join(",") !== "result")
        throw new TypeError("Operation result history is invalid");
      return {
        ...scope,
        type,
        idempotencyKey: key,
        result: parseOperationResult(payload["result"]),
      };
    }
    if (
      (type !== "OperationStarted" && type !== "OperationCancelled") ||
      Object.keys(payload).length
    )
      throw new TypeError("Operation history event is invalid");
    return { ...scope, type, idempotencyKey: key };
  });
  const history = rehydrateOperation(events),
    createdAt = publicTimestamp(String(row["created_at"])),
    updatedAt = publicTimestamp(String(row["updated_at"])),
    rawFailure = row["failure"] === null ? null : object(JSON.parse(String(row["failure"]))),
    failure =
      rawFailure === null
        ? null
        : failureOf(
            Object.fromEntries(Object.entries(rawFailure).filter(([k]) => k !== "diagnostic")),
          );
  if (
    history.operationId !== operationId ||
    history.projectId !== projectId ||
    history.state !== row["state"] ||
    history.createdAt !== createdAt ||
    history.updatedAt !== updatedAt ||
    history.failure?.code !== (failure?.["code"] ?? undefined) ||
    history.failure?.message !== (failure?.["message"] ?? undefined)
  )
    throw new Error("Operation projection does not match its immutable event history");
  return {
    operationId,
    state: history.state,
    createdAt,
    updatedAt,
    failure: failure === null ? null : { code: failure["code"] as string },
    failureDiagnostic: parseOperationFailureDiagnostic(rawFailure?.["diagnostic"]) ?? null,
  };
}
export type AcceptedApiProductOperation = ReturnType<typeof acceptedOperationOf>;

/** Original loadOperationForOrganization: one consistent primary read, including contiguous event history. */
export async function readAcceptedApiProductOperation(
  db: D1Database,
  organizationId: string,
  operationId: string,
): Promise<AcceptedApiProductOperation | null> {
  parseUlid(organizationId);
  parseUlid(operationId);
  const rows = await db.batch([
    db
      .prepare("SELECT * FROM operations WHERE organization_id=?1 AND operation_id=?2")
      .bind(organizationId, operationId),
    db
      .prepare(
        "SELECT * FROM operation_events WHERE organization_id=?1 AND operation_id=?2 ORDER BY revision",
      )
      .bind(organizationId, operationId),
  ]);
  const row = rows[0]?.results[0],
    events = rows[1]?.results ?? [];
  return row === undefined || events.length === 0 ? null : acceptedOperationOf(row, events);
}
