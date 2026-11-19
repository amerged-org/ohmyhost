import {
  parseOperationResult,
  type OperationResult,
} from "@ohmyhost/contracts/operation-data-change-result";
export {
  createOperationDataChangeResult,
  parseOperationDataChangeResult,
  parseOperationResult,
  type OperationDataChangeResult,
  type OperationResult,
} from "@ohmyhost/contracts/operation-data-change-result";

export {
  createOperationDeploymentResult,
  parseOperationDeploymentResult,
  type OperationDeploymentResult,
} from "@ohmyhost/contracts";

import { parseUlid, type Clock, type Ulid, type UlidFactory } from "../../shared/index.js";

export const operationStates = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

export type OperationState = (typeof operationStates)[number];

export interface OperationFailure {
  readonly code: string;
  readonly message: string;
}

interface OperationEventBase {
  readonly eventId: Ulid;
  readonly operationId: Ulid;
  readonly projectId: Ulid;
  readonly occurredAt: string;
}

export interface OperationQueued extends OperationEventBase {
  readonly type: "OperationQueued";
}

interface OperationTransitionEventBase extends OperationEventBase {
  readonly idempotencyKey: string;
}

export interface OperationStarted extends OperationTransitionEventBase {
  readonly type: "OperationStarted";
}

export interface OperationSucceeded extends OperationTransitionEventBase {
  readonly type: "OperationSucceeded";
  readonly result?: OperationResult;
}

export interface OperationFailed extends OperationTransitionEventBase {
  readonly type: "OperationFailed";
  readonly failure: OperationFailure;
}

export interface OperationCancelled extends OperationTransitionEventBase {
  readonly type: "OperationCancelled";
}

export type OperationEvent =
  | OperationQueued
  | OperationStarted
  | OperationSucceeded
  | OperationFailed
  | OperationCancelled;

export interface Operation {
  readonly operationId: Ulid;
  readonly projectId: Ulid;
  readonly state: OperationState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly failure?: OperationFailure;
  readonly result?: OperationResult;
  readonly events: readonly OperationEvent[];
}

export interface OperationDependencies {
  readonly clock: Clock;
  readonly eventIds: UlidFactory;
}

export interface CreateOperationInput extends OperationDependencies {
  readonly operationId: Ulid;
  readonly projectId: Ulid;
}

export interface OperationTransitionInput {
  readonly idempotencyKey: string;
}

export interface FailOperationInput extends OperationTransitionInput {
  readonly failure: OperationFailure;
}

export interface SucceedOperationInput extends OperationTransitionInput {
  readonly result?: unknown;
}

type TransitionEventType =
  | "OperationStarted"
  | "OperationSucceeded"
  | "OperationFailed"
  | "OperationCancelled";

interface TransitionRequestBase {
  readonly from: OperationState;
  readonly to: OperationState;
  readonly idempotencyKey: string;
  readonly result?: OperationResult;
}

type TransitionRequest =
  | (TransitionRequestBase & {
      readonly eventType: "OperationFailed";
      readonly failure: OperationFailure;
    })
  | (TransitionRequestBase & {
      readonly eventType: Exclude<TransitionEventType, "OperationFailed">;
      readonly failure?: never;
    });

export function rehydrateOperation(events: readonly OperationEvent[]): Operation {
  const first = events.at(0);
  if (first?.type !== "OperationQueued") {
    throw new Error("First operation history event must be exactly one OperationQueued event");
  }

  assertEventIdentity(first);
  assertCanonicalTimestamp(first.occurredAt);
  assertNoUnexpectedFailure(first);
  assertNoUnexpectedResult(first);

  const operationId = first.operationId;
  const projectId = first.projectId;
  const copiedEvents: OperationEvent[] = [copyPersistedEvent(first)];
  const usedIdempotencyKeys = new Set<string>();
  let state: OperationState = "queued";
  let updatedAt = first.occurredAt;
  let finalFailure: OperationFailure | undefined;
  let finalResult: OperationResult | undefined;

  for (const event of events.slice(1)) {
    if (event.type === "OperationQueued") {
      throw new Error("OperationQueued is allowed only as the first history event");
    }
    if (isTerminalState(state)) {
      throw new Error(`Terminal operation state ${state} cannot be followed by another event`);
    }

    assertEventIdentity(event);
    if (event.operationId !== operationId) {
      throw new Error("Operation history contains a different operation ID");
    }
    if (event.projectId !== projectId) {
      throw new Error("Operation history contains a different project ID");
    }
    assertCanonicalTimestamp(event.occurredAt);
    if (event.occurredAt < updatedAt) {
      throw new Error("Operation history timestamp cannot move backwards");
    }
    assertNoUnexpectedFailure(event);
    assertNoUnexpectedResult(event);
    assertIdempotencyKey(event.idempotencyKey);
    if (usedIdempotencyKeys.has(event.idempotencyKey)) {
      throw new Error(`The idempotency key '${event.idempotencyKey}' was already used`);
    }
    usedIdempotencyKeys.add(event.idempotencyKey);

    const nextState = stateForEvent(event);
    if (!isAllowedPersistedTransition(state, nextState)) {
      throw new Error(`Cannot rehydrate operation transition from ${state} to ${nextState}`);
    }

    const copied = copyPersistedEvent(event);
    if (
      copied.type === "OperationSucceeded" &&
      copied.result !== undefined &&
      copied.result.operationId !== operationId
    ) {
      throw new TypeError("Operation deployment result must match the operation ID");
    }
    copiedEvents.push(copied);
    state = nextState;
    updatedAt = event.occurredAt;
    finalFailure = copied.type === "OperationFailed" ? copied.failure : undefined;
    finalResult = copied.type === "OperationSucceeded" ? copied.result : undefined;
  }

  return freezeOperation({
    operationId,
    projectId,
    state,
    createdAt: first.occurredAt,
    updatedAt,
    ...(finalFailure === undefined ? {} : { failure: finalFailure }),
    ...(finalResult === undefined ? {} : { result: finalResult }),
    events: copiedEvents,
  });
}

export function createOperation({
  operationId,
  projectId,
  clock,
  eventIds,
}: CreateOperationInput): Operation {
  const createdAt = clock.now().toISOString();
  const event = Object.freeze<OperationQueued>({
    eventId: eventIds.next(),
    type: "OperationQueued",
    operationId,
    projectId,
    occurredAt: createdAt,
  });

  return freezeOperation({
    operationId,
    projectId,
    state: "queued",
    createdAt,
    updatedAt: createdAt,
    events: [event],
  });
}

export function startOperation(
  operation: Operation,
  input: OperationTransitionInput,
  dependencies: OperationDependencies,
): Operation {
  return transitionOperation(
    operation,
    {
      from: "queued",
      to: "running",
      eventType: "OperationStarted",
      idempotencyKey: input.idempotencyKey,
    },
    dependencies,
  );
}

export function succeedOperation(
  operation: Operation,
  input: SucceedOperationInput,
  dependencies: OperationDependencies,
): Operation {
  const result = input.result === undefined ? undefined : parseOperationResult(input.result);
  if (result !== undefined && result.operationId !== operation.operationId) {
    throw new TypeError("Operation deployment result must match the operation ID");
  }
  return transitionOperation(
    operation,
    {
      from: "running",
      to: "succeeded",
      eventType: "OperationSucceeded",
      idempotencyKey: input.idempotencyKey,
      ...(result === undefined ? {} : { result }),
    },
    dependencies,
  );
}

export function failOperation(
  operation: Operation,
  input: FailOperationInput,
  dependencies: OperationDependencies,
): Operation {
  const failure = copyFailure(input.failure);
  return transitionOperation(
    operation,
    {
      from: "running",
      to: "failed",
      eventType: "OperationFailed",
      idempotencyKey: input.idempotencyKey,
      failure,
    },
    dependencies,
  );
}

export function cancelOperation(
  operation: Operation,
  input: OperationTransitionInput,
  dependencies: OperationDependencies,
): Operation {
  return transitionOperation(
    operation,
    {
      from: "running",
      to: "cancelled",
      eventType: "OperationCancelled",
      idempotencyKey: input.idempotencyKey,
    },
    dependencies,
  );
}

function transitionOperation(
  operation: Operation,
  request: TransitionRequest,
  { clock, eventIds }: OperationDependencies,
): Operation {
  assertIdempotencyKey(request.idempotencyKey);
  const existing = findTransition(operation, request.idempotencyKey);
  if (existing !== undefined) {
    if (matchesRequest(existing, request)) {
      return operation;
    }
    throw new Error(`The idempotency key '${request.idempotencyKey}' was already used`);
  }

  if (operation.state !== request.from) {
    throw new Error(`Cannot transition operation from ${operation.state} to ${request.to}`);
  }

  const occurredAt = clock.now().toISOString();
  if (occurredAt < operation.updatedAt) {
    throw new Error("Operation transition timestamp cannot move backwards");
  }

  const event = createTransitionEvent(operation, request, eventIds.next(), occurredAt);
  return freezeOperation({
    operationId: operation.operationId,
    projectId: operation.projectId,
    state: request.to,
    createdAt: operation.createdAt,
    updatedAt: occurredAt,
    ...(request.failure === undefined ? {} : { failure: request.failure }),
    ...(request.result === undefined ? {} : { result: request.result }),
    events: [...operation.events, event],
  });
}

function createTransitionEvent(
  operation: Operation,
  request: TransitionRequest,
  eventId: Ulid,
  occurredAt: string,
): OperationStarted | OperationSucceeded | OperationFailed | OperationCancelled {
  const base = {
    eventId,
    type: request.eventType,
    operationId: operation.operationId,
    projectId: operation.projectId,
    occurredAt,
    idempotencyKey: request.idempotencyKey,
  } as const;

  if (request.eventType === "OperationFailed") {
    return Object.freeze({ ...base, type: "OperationFailed", failure: request.failure });
  }

  if (request.eventType === "OperationSucceeded") {
    return Object.freeze({
      ...base,
      type: "OperationSucceeded",
      ...(request.result === undefined ? {} : { result: request.result }),
    });
  }

  return Object.freeze(base) as OperationStarted | OperationSucceeded | OperationCancelled;
}

function findTransition(
  operation: Operation,
  idempotencyKey: string,
): OperationStarted | OperationSucceeded | OperationFailed | OperationCancelled | undefined {
  for (const event of operation.events) {
    if ("idempotencyKey" in event && event.idempotencyKey === idempotencyKey) {
      return event;
    }
  }
  return undefined;
}

function matchesRequest(
  event: OperationStarted | OperationSucceeded | OperationFailed | OperationCancelled,
  request: TransitionRequest,
): boolean {
  if (event.type !== request.eventType) {
    return false;
  }
  if (event.type !== "OperationFailed") {
    return (
      request.failure === undefined &&
      (event.type !== "OperationSucceeded" || resultsEqual(event.result, request.result))
    );
  }
  return (
    request.failure !== undefined &&
    event.failure.code === request.failure.code &&
    event.failure.message === request.failure.message
  );
}

function copyFailure(failure: OperationFailure): OperationFailure {
  if (failure.code.trim() === "" || failure.message.trim() === "") {
    throw new TypeError("Operation failure code and message are required");
  }
  return Object.freeze({ code: failure.code, message: failure.message });
}

function copyPersistedEvent(event: OperationEvent): OperationEvent {
  const base = {
    eventId: event.eventId,
    operationId: event.operationId,
    projectId: event.projectId,
    occurredAt: event.occurredAt,
  } as const;

  if (event.type === "OperationQueued") {
    return Object.freeze({ ...base, type: event.type });
  }
  if (event.type === "OperationFailed") {
    return Object.freeze({
      ...base,
      type: event.type,
      idempotencyKey: event.idempotencyKey,
      failure: copyFailure(event.failure),
    });
  }
  if (event.type === "OperationSucceeded") {
    return Object.freeze({
      ...base,
      type: event.type,
      idempotencyKey: event.idempotencyKey,
      ...(event.result === undefined ? {} : { result: parseOperationResult(event.result) }),
    });
  }
  return Object.freeze({
    ...base,
    type: event.type,
    idempotencyKey: event.idempotencyKey,
  });
}

function stateForEvent(event: Exclude<OperationEvent, OperationQueued>): OperationState {
  switch (event.type) {
    case "OperationStarted":
      return "running";
    case "OperationSucceeded":
      return "succeeded";
    case "OperationFailed":
      assertValidPersistedFailure(event.failure);
      return "failed";
    case "OperationCancelled":
      return "cancelled";
  }
}

function isAllowedPersistedTransition(from: OperationState, to: OperationState): boolean {
  return from === "queued" ? to === "running" : from === "running" && isTerminalState(to);
}

function isTerminalState(state: OperationState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function assertEventIdentity(event: OperationEvent): void {
  parseUlid(event.eventId);
  parseUlid(event.operationId);
  parseUlid(event.projectId);
}

function assertCanonicalTimestamp(timestamp: string): void {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new TypeError("Operation event timestamp must be a canonical ISO timestamp");
  }
}

function assertNoUnexpectedFailure(event: OperationEvent): void {
  if (event.type !== "OperationFailed" && "failure" in event) {
    throw new TypeError("Operation failure data is valid only on OperationFailed events");
  }
}

function assertNoUnexpectedResult(event: OperationEvent): void {
  if (event.type !== "OperationSucceeded" && "result" in event) {
    throw new TypeError("Operation result data is valid only on OperationSucceeded events");
  }
}

function resultsEqual(
  left: OperationResult | undefined,
  right: OperationResult | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function assertValidPersistedFailure(failure: unknown): asserts failure is OperationFailure {
  if (
    typeof failure !== "object" ||
    failure === null ||
    !("code" in failure) ||
    !("message" in failure) ||
    typeof failure.code !== "string" ||
    typeof failure.message !== "string" ||
    failure.code.trim() === "" ||
    failure.message.trim() === ""
  ) {
    throw new TypeError("Operation failure code and message are required");
  }
}

function assertIdempotencyKey(idempotencyKey: string): void {
  if (idempotencyKey.trim() === "") {
    throw new TypeError("Operation transition idempotency key is required");
  }
}

function freezeOperation(operation: Operation): Operation {
  return Object.freeze({
    ...operation,
    events: Object.freeze([...operation.events]),
  });
}
