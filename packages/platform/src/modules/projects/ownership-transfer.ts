import { DomainError, type Clock, type Ulid, type UlidFactory } from "../../shared/index.js";

export const projectOwnershipStates = [
  "active",
  "transfer_pending_frozen",
  "security_frozen",
] as const;
export const projectTransferIntentStates = [
  "pending_frozen",
  "completed",
  "cancelled_to_source",
  "failed_frozen",
] as const;
export type ProjectOwnershipState = (typeof projectOwnershipStates)[number];
export type ProjectTransferIntentState = (typeof projectTransferIntentStates)[number];
export type ProjectTransferState = "active" | "frozen";

export interface BillingEpoch {
  readonly billingEpochId: Ulid;
  readonly projectId: Ulid;
  readonly organizationId: Ulid;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly createdByPrincipalId: string;
}

export interface ProjectTransferIntent {
  readonly transferId: Ulid;
  readonly projectId: Ulid;
  readonly sourceOrganizationId: Ulid;
  readonly targetOrganizationId: Ulid;
  readonly initiatorPrincipalId: string;
  readonly expectedOwnershipVersion: number;
  readonly state: ProjectTransferIntentState;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly failureCode: string | null;
}

interface OwnershipEventBase {
  readonly eventId: Ulid;
  readonly projectId: Ulid;
  readonly occurredAt: string;
}

export type ProjectOwnershipEvent = Readonly<
  OwnershipEventBase & {
    readonly type:
      | "ProjectOwnershipCreated"
      | "ProjectTransferFrozen"
      | "ProjectTransferCompleted"
      | "ProjectTransferCancelled"
      | "ProjectSecurityFrozen";
    readonly transferId?: Ulid;
    readonly organizationId?: Ulid;
    readonly billingEpochId?: Ulid;
    readonly ownershipVersion: number;
    readonly failureCode?: string;
  }
>;

export interface OwnedProject {
  readonly projectId: Ulid;
  readonly organizationId: Ulid;
  readonly billingEpochId: Ulid;
  readonly transferState: ProjectTransferState;
  readonly ownershipState: ProjectOwnershipState;
  readonly ownershipVersion: number;
  readonly activeTransferId: Ulid | null;
  readonly ownershipEpochs: readonly BillingEpoch[];
  readonly transferIntents: readonly ProjectTransferIntent[];
  readonly ownershipEvents: readonly ProjectOwnershipEvent[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface OwnershipDependencies {
  readonly clock: Clock;
  readonly eventIds: UlidFactory;
}
export interface CreateOwnedProjectInput extends OwnershipDependencies {
  readonly projectId: Ulid;
  readonly organizationId: Ulid;
  readonly billingEpochId: Ulid;
  readonly createdByPrincipalId: string;
}
export interface FreezeProjectForTransferInput extends OwnershipDependencies {
  readonly project: OwnedProject;
  readonly transferId: Ulid;
  readonly targetOrganizationId: Ulid;
  readonly initiatorPrincipalId: string;
  readonly expectedOwnershipVersion: number;
}
export interface ResolveProjectTransferInput extends OwnershipDependencies {
  readonly project: OwnedProject;
  readonly transferId: Ulid;
  readonly expectedOwnershipVersion: number;
}
export interface CompleteProjectTransferInput extends ResolveProjectTransferInput {
  readonly targetOrganizationId: Ulid;
  readonly nextBillingEpochId: Ulid;
}
export interface SecurityFreezeProjectInput extends ResolveProjectTransferInput {
  readonly failureCode: string;
}

export type ProjectRecordKind = "operation" | "audit" | "transfer_boundary";
export type ProjectRecordVisibility = "full" | "redacted" | "hidden";
export interface HistoricalProjectRecord {
  readonly kind: ProjectRecordKind;
  readonly organizationId: Ulid;
  readonly billingEpochId: Ulid;
}
export interface ProjectVisibility {
  readonly currentProject: "read_write" | "read_only" | "hidden";
  readonly historicalBillingEpochIds: readonly Ulid[];
  readonly transferBoundary: "redacted" | "hidden";
}

export function createOwnedProject(input: CreateOwnedProjectInput): OwnedProject {
  requirePrincipal(input.createdByPrincipalId);
  const occurredAt = input.clock.now().toISOString();
  const epoch = freezeEpoch({
    billingEpochId: input.billingEpochId,
    projectId: input.projectId,
    organizationId: input.organizationId,
    effectiveFrom: occurredAt,
    effectiveUntil: null,
    createdByPrincipalId: input.createdByPrincipalId,
  });
  const event = freezeEvent({
    eventId: input.eventIds.next(),
    type: "ProjectOwnershipCreated",
    projectId: input.projectId,
    organizationId: input.organizationId,
    billingEpochId: input.billingEpochId,
    ownershipVersion: 1,
    occurredAt,
  });
  return freezeOwnedProject({
    projectId: input.projectId,
    organizationId: input.organizationId,
    billingEpochId: input.billingEpochId,
    ownershipState: "active",
    ownershipVersion: 1,
    activeTransferId: null,
    ownershipEpochs: [epoch],
    transferIntents: [],
    ownershipEvents: [event],
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

export function freezeProjectForTransfer(input: FreezeProjectForTransferInput): OwnedProject {
  assertState(input.project, "active", "PROJECT_TRANSFER_REQUIRES_ACTIVE_OWNERSHIP");
  requirePrincipal(input.initiatorPrincipalId);
  if (input.targetOrganizationId === input.project.organizationId)
    throw new DomainError("PROJECT_TRANSFER_TARGET_UNCHANGED", "Target organization must change");
  if (input.project.transferIntents.some((intent) => intent.transferId === input.transferId))
    throw new DomainError("PROJECT_TRANSFER_ID_REUSED", "Transfer ID was already used");
  const occurredAt = transitionTime(input.project, input.clock);
  const lockedVersion = input.project.ownershipVersion + 1;
  const isStale = input.expectedOwnershipVersion !== input.project.ownershipVersion;
  const failureCode = isStale ? "PROJECT_TRANSFER_STALE_VERSION" : null;
  const intent = freezeIntent({
    transferId: input.transferId,
    projectId: input.project.projectId,
    sourceOrganizationId: input.project.organizationId,
    targetOrganizationId: input.targetOrganizationId,
    initiatorPrincipalId: input.initiatorPrincipalId,
    expectedOwnershipVersion: lockedVersion,
    state: isStale ? "failed_frozen" : "pending_frozen",
    createdAt: occurredAt,
    resolvedAt: isStale ? occurredAt : null,
    failureCode,
  });
  return transitionProject(input.project, {
    ownershipState: isStale ? "security_frozen" : "transfer_pending_frozen",
    ownershipVersion: lockedVersion,
    activeTransferId: isStale ? null : input.transferId,
    transferIntents: [...input.project.transferIntents, intent],
    event: createTransitionEvent(
      input,
      isStale ? "ProjectSecurityFrozen" : "ProjectTransferFrozen",
      lockedVersion,
      occurredAt,
      failureCode ?? undefined,
    ),
    occurredAt,
  });
}

export function completeProjectTransfer(input: CompleteProjectTransferInput): OwnedProject {
  const mismatch = transferMismatch(input, input.targetOrganizationId);
  if (mismatch !== undefined) return failPendingTransfer(input, mismatch);
  if (
    input.project.ownershipEpochs.some((epoch) => epoch.billingEpochId === input.nextBillingEpochId)
  )
    return failPendingTransfer(input, "BILLING_EPOCH_ID_REUSED");
  const intent = requirePendingIntent(input.project, input.transferId);
  const occurredAt = transitionTime(input.project, input.clock);
  const ownershipVersion = input.project.ownershipVersion + 1;
  const epochs = input.project.ownershipEpochs.map((epoch, index) =>
    index === input.project.ownershipEpochs.length - 1
      ? freezeEpoch({ ...epoch, effectiveUntil: occurredAt })
      : epoch,
  );
  epochs.push(
    freezeEpoch({
      billingEpochId: input.nextBillingEpochId,
      projectId: input.project.projectId,
      organizationId: intent.targetOrganizationId,
      effectiveFrom: occurredAt,
      effectiveUntil: null,
      createdByPrincipalId: intent.initiatorPrincipalId,
    }),
  );
  return freezeOwnedProject({
    ...input.project,
    organizationId: intent.targetOrganizationId,
    billingEpochId: input.nextBillingEpochId,
    ownershipState: "active",
    ownershipVersion,
    activeTransferId: null,
    ownershipEpochs: epochs,
    transferIntents: resolveIntent(input.project.transferIntents, intent, "completed", occurredAt),
    ownershipEvents: [
      ...input.project.ownershipEvents,
      createTransitionEvent(input, "ProjectTransferCompleted", ownershipVersion, occurredAt),
    ],
    updatedAt: occurredAt,
  });
}

export function cancelProjectTransfer(input: ResolveProjectTransferInput): OwnedProject {
  const mismatch = transferMismatch(input);
  if (mismatch !== undefined) return failPendingTransfer(input, mismatch);
  const intent = requirePendingIntent(input.project, input.transferId);
  const occurredAt = transitionTime(input.project, input.clock);
  const ownershipVersion = input.project.ownershipVersion + 1;
  return transitionProject(input.project, {
    ownershipState: "active",
    ownershipVersion,
    activeTransferId: null,
    transferIntents: resolveIntent(
      input.project.transferIntents,
      intent,
      "cancelled_to_source",
      occurredAt,
    ),
    event: createTransitionEvent(input, "ProjectTransferCancelled", ownershipVersion, occurredAt),
    occurredAt,
  });
}

export function securityFreezeProject(input: SecurityFreezeProjectInput): OwnedProject {
  requireStableCode(input.failureCode);
  return failPendingTransfer(input, input.failureCode);
}

export function getProjectVisibility(
  project: OwnedProject,
  organizationId: Ulid,
): ProjectVisibility {
  const ownedEpochs = project.ownershipEpochs
    .filter((epoch) => epoch.organizationId === organizationId)
    .map((epoch) => epoch.billingEpochId);
  const currentProject =
    organizationId !== project.organizationId
      ? "hidden"
      : project.ownershipState === "active"
        ? "read_write"
        : "read_only";
  return Object.freeze({
    currentProject,
    historicalBillingEpochIds: Object.freeze(ownedEpochs),
    transferBoundary: ownedEpochs.length > 0 ? "redacted" : "hidden",
  });
}

export function getHistoricalProjectRecordVisibility(
  project: OwnedProject,
  organizationId: Ulid,
  record: HistoricalProjectRecord,
): ProjectRecordVisibility {
  const ownsAnyEpoch = project.ownershipEpochs.some(
    (epoch) => epoch.organizationId === organizationId,
  );
  if (record.kind === "transfer_boundary") return ownsAnyEpoch ? "redacted" : "hidden";
  const ownsRecordEpoch = project.ownershipEpochs.some(
    (epoch) =>
      epoch.billingEpochId === record.billingEpochId && epoch.organizationId === organizationId,
  );
  return ownsRecordEpoch && record.organizationId === organizationId ? "full" : "hidden";
}

function transferMismatch(
  input: ResolveProjectTransferInput,
  targetOrganizationId?: Ulid,
): string | undefined {
  if (input.project.ownershipState !== "transfer_pending_frozen")
    throw new DomainError("PROJECT_TRANSFER_NOT_PENDING", "Project transfer is not pending");
  if (input.project.activeTransferId !== input.transferId) return "PROJECT_TRANSFER_ID_MISMATCH";
  const intent = requirePendingIntent(input.project, input.project.activeTransferId);
  if (input.expectedOwnershipVersion !== input.project.ownershipVersion)
    return "PROJECT_TRANSFER_STALE_VERSION";
  if (input.expectedOwnershipVersion !== intent.expectedOwnershipVersion)
    return "PROJECT_TRANSFER_INTENT_VERSION_MISMATCH";
  if (targetOrganizationId !== undefined && targetOrganizationId !== intent.targetOrganizationId)
    return "PROJECT_TRANSFER_TARGET_MISMATCH";
  return undefined;
}

function failPendingTransfer(
  input: ResolveProjectTransferInput,
  failureCode: string,
): OwnedProject {
  requireStableCode(failureCode);
  const intent = requirePendingIntent(input.project, input.project.activeTransferId);
  const occurredAt = transitionTime(input.project, input.clock);
  const ownershipVersion = input.project.ownershipVersion + 1;
  return transitionProject(input.project, {
    ownershipState: "security_frozen",
    ownershipVersion,
    activeTransferId: null,
    transferIntents: resolveIntent(
      input.project.transferIntents,
      intent,
      "failed_frozen",
      occurredAt,
      failureCode,
    ),
    event: createTransitionEvent(
      { ...input, transferId: intent.transferId },
      "ProjectSecurityFrozen",
      ownershipVersion,
      occurredAt,
      failureCode,
    ),
    occurredAt,
  });
}

function requirePendingIntent(
  project: OwnedProject,
  transferId: Ulid | null,
): ProjectTransferIntent {
  const intent = project.transferIntents.find((candidate) => candidate.transferId === transferId);
  if (intent?.state !== "pending_frozen")
    throw new DomainError("PROJECT_TRANSFER_INTENT_NOT_PENDING", "Transfer intent is not pending");
  return intent;
}

function resolveIntent(
  intents: readonly ProjectTransferIntent[],
  active: ProjectTransferIntent,
  state: Exclude<ProjectTransferIntentState, "pending_frozen">,
  resolvedAt: string,
  failureCode: string | null = null,
): readonly ProjectTransferIntent[] {
  return intents.map((intent) =>
    intent === active ? freezeIntent({ ...intent, state, resolvedAt, failureCode }) : intent,
  );
}

function transitionProject(
  project: OwnedProject,
  change: {
    readonly ownershipState: ProjectOwnershipState;
    readonly ownershipVersion: number;
    readonly activeTransferId: Ulid | null;
    readonly transferIntents: readonly ProjectTransferIntent[];
    readonly event: ProjectOwnershipEvent;
    readonly occurredAt: string;
  },
): OwnedProject {
  return freezeOwnedProject({
    ...project,
    ownershipState: change.ownershipState,
    ownershipVersion: change.ownershipVersion,
    activeTransferId: change.activeTransferId,
    transferIntents: change.transferIntents,
    ownershipEvents: [...project.ownershipEvents, change.event],
    updatedAt: change.occurredAt,
  });
}

function createTransitionEvent(
  input: {
    readonly project: OwnedProject;
    readonly transferId: Ulid;
    readonly eventIds: UlidFactory;
  },
  type: ProjectOwnershipEvent["type"],
  ownershipVersion: number,
  occurredAt: string,
  failureCode?: string,
): ProjectOwnershipEvent {
  return freezeEvent({
    eventId: input.eventIds.next(),
    type,
    projectId: input.project.projectId,
    transferId: input.transferId,
    ownershipVersion,
    occurredAt,
    ...(failureCode === undefined ? {} : { failureCode }),
  });
}

function assertState(project: OwnedProject, expected: ProjectOwnershipState, code: string): void {
  if (project.ownershipState !== expected)
    throw new DomainError(code, `Expected project ownership state ${expected}`);
}
function transitionTime(project: OwnedProject, clock: Clock): string {
  const occurredAt = clock.now().toISOString();
  if (occurredAt < project.updatedAt)
    throw new DomainError(
      "PROJECT_OWNERSHIP_TIME_MOVED_BACKWARDS",
      "Ownership transition time cannot move backwards",
    );
  return occurredAt;
}
function requirePrincipal(principalId: string): void {
  if (principalId.trim() === "")
    throw new DomainError("INVALID_PRINCIPAL_ID", "Principal ID is required");
}
function requireStableCode(code: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/u.test(code))
    throw new DomainError("INVALID_TRANSFER_FAILURE_CODE", "A stable failure code is required");
}
function freezeEpoch(epoch: BillingEpoch): BillingEpoch {
  return Object.freeze({ ...epoch });
}
function freezeIntent(intent: ProjectTransferIntent): ProjectTransferIntent {
  return Object.freeze({ ...intent });
}
function freezeEvent(event: ProjectOwnershipEvent): ProjectOwnershipEvent {
  return Object.freeze({ ...event });
}
function freezeOwnedProject(project: Omit<OwnedProject, "transferState">): OwnedProject {
  return Object.freeze({
    ...project,
    transferState: project.ownershipState === "active" ? "active" : "frozen",
    ownershipEpochs: Object.freeze([...project.ownershipEpochs]),
    transferIntents: Object.freeze([...project.transferIntents]),
    ownershipEvents: Object.freeze([...project.ownershipEvents]),
  });
}
