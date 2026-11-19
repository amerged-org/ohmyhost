import { describe, expect, it } from "vitest";
import {
  assertPayloadKeys,
  failurePayload,
  operationEventFromRow,
  storedOperation,
  type OperationEventRow,
  type OperationRow,
} from "../../src/catalog/provisioning/lost-command-values.js";
import { rehydrateOperation } from "@ohmyhost/platform";
import { newUlid } from "../../src/catalog/common.js";

const operationId = newUlid(),
  projectId = newUlid(),
  at = new Date("2026-10-28T12:00:00.000Z");
const eventRow = (over: Partial<OperationEventRow>): OperationEventRow => ({
  event_id: newUlid(),
  operation_id: operationId,
  project_id: projectId,
  revision: 2,
  event_type: "OperationFailed",
  idempotency_key: "lost-command:fail",
  payload: {},
  occurred_at: at,
  ...over,
});

describe("lost command operation aggregate validation", () => {
  it("accepts exactly the stored failure shape and refuses any other payload key set", () => {
    expect(failurePayload({ code: "OPERATION_ABANDONED", message: "ended" })).toEqual({
      code: "OPERATION_ABANDONED",
      message: "ended",
    });
    expect(() => failurePayload({ code: "OPERATION_ABANDONED" })).toThrow(
      "does not match its event type",
    );
    expect(() => failurePayload({ code: " ", message: "ended" })).toThrow(
      "failure code and message are required",
    );
    expect(() => assertPayloadKeys({ code: 1, other: 2 }, ["code", "message"])).toThrow(
      "does not match its event type",
    );
  });

  it("rebuilds a failed event and a failed operation projection from their stored rows", () => {
    const failure = { code: "OPERATION_ABANDONED", message: "The command was ended." };
    expect(operationEventFromRow(eventRow({ payload: { failure } }))).toMatchObject({
      type: "OperationFailed",
      idempotencyKey: "lost-command:fail",
      failure,
    });
    expect(() => operationEventFromRow(eventRow({ payload: { failure: { code: "x" } } }))).toThrow(
      "does not match its event type",
    );
    const row: OperationRow = {
      operation_id: operationId,
      project_id: projectId,
      state: "failed",
      failure,
      created_at: at,
      updated_at: at,
      billing_epoch_id: newUlid(),
    };
    const history = [
      eventRow({ revision: 0, event_type: "OperationQueued", idempotency_key: null }),
      eventRow({
        revision: 1,
        event_type: "OperationStarted",
        idempotency_key: "lost-command:start",
      }),
      eventRow({ payload: { failure } }),
    ].map(operationEventFromRow);
    expect(storedOperation(row, rehydrateOperation(history))).toMatchObject({
      state: "failed",
      failure,
    });
    // a projection that disagrees with its immutable history is refused
    expect(() => storedOperation({ ...row, state: "queued" }, rehydrateOperation(history))).toThrow(
      "does not match its immutable event history",
    );
  });
});
