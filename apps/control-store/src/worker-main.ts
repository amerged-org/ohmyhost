/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging, @typescript-eslint/no-empty-object-type --
   Every entrypoint lists its RPC methods once, in a table; `delegate` installs them on the class prototype and the
   merged interface gives them their types, so no method is written out by hand. */
import { readRecoveryJobStateInput } from "./catalog/recovery/jobs.js";
import { WorkerEntrypoint } from "cloudflare:workers";

import { createControlStore, type ControlStore, type ControlStoreBindings } from "./store.js";

const stores = new WeakMap<object, ControlStore>();

function storeFor(env: ControlStoreBindings): ControlStore {
  const existing = stores.get(env);
  if (existing !== undefined) return existing;
  const created = createControlStore(env);
  stores.set(env, created);
  return created;
}

/** Private RPC time authority: callers cannot opt into the catalog's deterministic local-oracle clock. */
function recoveryExecution(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Recovery command is invalid");
  }
  return { ...input, clock: "execution" };
}

/** What an entrypoint does to the caller's input before the command sees it; a method without a rule passes it on as is. */
const INPUT_RULES = {
  /** The command runs on the Worker's own clock, never on one the caller names. */
  execution: recoveryExecution,
  /** The input must be exactly one job scope. */
  jobState: (input: unknown) => readRecoveryJobStateInput.parse(input),
  /** The command takes no input: whatever the caller sent is dropped. */
  none: () => undefined,
} as const;

/** Dotted paths of the commands of a command tree, e.g. `recovery.owner.acceptRecoveryJob`. */
type CommandPath<Tree, Prefix extends string = ""> = {
  [Key in keyof Tree & string]: Tree[Key] extends (...args: never[]) => unknown
    ? `${Prefix}${Key}`
    : Tree[Key] extends object
      ? CommandPath<Tree[Key], `${Prefix}${Key}.`>
      : never;
}[keyof Tree & string];
type CommandAt<Tree, Path extends string> = Path extends `${infer Head}.${infer Rest}`
  ? Head extends keyof Tree
    ? CommandAt<Tree[Head], Rest>
    : never
  : Path extends keyof Tree
    ? Tree[Path]
    : never;
type InputRule = keyof typeof INPUT_RULES;
type Entry<Tree> = CommandPath<Tree> | readonly [path: CommandPath<Tree>, rule: InputRule];
/** RPC method name to the command it forwards to; a path the tree does not have is a compile error. */
type Surface<Tree> = Readonly<Record<string, Entry<Tree>>>;
type Delegated<Tree, Table extends Surface<Tree>> = {
  readonly [Method in keyof Table]: CommandAt<
    Tree,
    Table[Method] extends readonly [infer Path extends string, unknown]
      ? Path
      : Table[Method] & string
  > extends (...args: never[]) => infer Result
    ? (input?: unknown) => Result
    : never;
};

/**
 * Installs one RPC method per table entry on the entrypoint class. Each method looks its command up on the tree of
 * the Worker's own `env` at call time and forwards the input; whatever the command returns or throws reaches the
 * caller untouched.
 */
function delegate<Tree, Table extends Surface<Tree>>(
  entrypoint: { readonly prototype: object },
  treeOf: (env: ControlStoreBindings) => Tree,
  table: Table,
): void {
  for (const [method, entry] of Object.entries(table)) {
    const [path, rule] = (typeof entry === "string" ? [entry] : entry) as readonly [
      string,
      InputRule?,
    ];
    const steps = path.split(".");
    const command = steps.pop() as string;
    const call = {
      [method](this: { readonly env: ControlStoreBindings }, input?: unknown) {
        let owner = treeOf(this.env) as Record<string, unknown>;
        for (const step of steps) owner = owner[step] as Record<string, unknown>;
        const run = owner[command] as (input: unknown) => unknown;
        return run.call(owner, rule === undefined ? input : INPUT_RULES[rule](input));
      },
    }[method];
    Object.defineProperty(entrypoint.prototype, method, {
      value: call,
      writable: true,
      configurable: true,
    });
  }
}

const mailResendIngressSurface = {
  readReceipt: "mailIngress.readReceipt",
  ingest: "mailIngress.ingest",
} as const satisfies Surface<ControlStore>;

/** Signature verification and message plaintext stay in ingress; Core retains only the original atomic facts. */
export class MailResendIngressRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface MailResendIngressRuntime
  extends Delegated<ControlStore, typeof mailResendIngressSurface> {}
delegate(MailResendIngressRuntime, storeFor, mailResendIngressSurface);

const accountMetadataSurface = {
  readCurrentIdentityMappings: "accountMetadata.readCurrentIdentityMappings",
  readAccountProfileFacts: "accountMetadata.readAccountProfileFacts",
  recordAccountSignupSource: "accountMetadata.recordAccountSignupSource",
} as const satisfies Surface<ControlStore>;

/** Only the Control API's authenticated account metadata; no provider profile, session or financial authority. */
export class AccountMetadataRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface AccountMetadataRuntime
  extends Delegated<ControlStore, typeof accountMetadataSurface> {}
delegate(AccountMetadataRuntime, storeFor, accountMetadataSurface);

const functionsSchedulerSurface = {
  readSchedules: "functionsScheduler.readSchedules",
  insertDueRuns: "functionsScheduler.insertDueRuns",
  claimRuns: "functionsScheduler.claimRuns",
  finishRun: "functionsScheduler.finishRun",
  purgeFinishedRuns: "functionsScheduler.purgeFinishedRuns",
} as const satisfies Surface<ControlStore>;

/** Private global scheduler capability: fixed run/lease transactions, without schedule or deployment mutation. */
export class FunctionsSchedulerRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface FunctionsSchedulerRuntime
  extends Delegated<ControlStore, typeof functionsSchedulerSurface> {}
delegate(FunctionsSchedulerRuntime, storeFor, functionsSchedulerSurface);

const cloudflareDomainSurface = {
  admitPaidProjectDomain: "billing.admitPaidProjectDomain",
  readReconciliation: "cloudflareDomain.readReconciliation",
  rotateGrant: "cloudflareDomain.rotateGrant",
  readDeletion: "cloudflareDomain.readDeletion",
  rotateDeletionGrant: "cloudflareDomain.rotateDeletionGrant",
  prepareRevocation: "cloudflareDomain.prepareRevocation",
  restartRevocation: "cloudflareDomain.restartRevocation",
  finalizeDeletion: "cloudflareDomain.finalizeDeletion",
  finalizePlatformDeletion: "cloudflareDomain.finalizePlatformDeletion",
  readPaidDomainTarget: "cloudflareDomain.readPaidDomainTarget",
  readPaidDomainRecord: "cloudflareDomain.readPaidDomainRecord",
  readPaidDomainProof: "cloudflareDomain.readPaidDomainProof",
  ensurePaidDomainProof: "cloudflareDomain.ensurePaidDomainProof",
  verifyPaidDomainProof: "cloudflareDomain.verifyPaidDomainProof",
  claimPaidDomainApply: "cloudflareDomain.claimPaidDomainApply",
  putPaidDomainActive: "cloudflareDomain.putPaidDomainActive",
  claimPaidDomainDelete: "cloudflareDomain.claimPaidDomainDelete",
  readDomainPolicySync: "identity.readDomainPolicySync",
  ackDomainPolicySync: "identity.ackDomainPolicySync",
  beginPaidDomainRecovery: "identity.beginPaidDomainRecovery",
  completePaidDomainRecovery: "identity.completePaidDomainRecovery",
  markPaidDomainDeleted: "cloudflareDomain.markPaidDomainDeleted",
  claimPaidProjectDeletion: "cloudflareDomain.claimPaidProjectDeletion",
  claimGrantUse: "cloudflareDomain.claimGrantUse",
  renewGrantUse: "cloudflareDomain.renewGrantUse",
  finishGrantUse: "cloudflareDomain.finishGrantUse",
  releaseGrantUse: "cloudflareDomain.releaseGrantUse",
  claimAuthorization: "cloudflareDomain.claimAuthorization",
  consumeAuthorization: "cloudflareDomain.consumeAuthorization",
  putGrant: "cloudflareDomain.putGrant",
  readGrant: "cloudflareDomain.readGrant",
  readStatus: "cloudflareDomain.readStatus",
  configureDomains: "cloudflareDomain.configureDomains",
} as const satisfies Surface<ControlStore>;

/** Project domains on Cloudflare: authorizations, grants, reconciliation, deletion and the paid-domain claims; provider calls stay with the caller. */
export class CloudflareDomainRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface CloudflareDomainRuntime
  extends Delegated<ControlStore, typeof cloudflareDomainSurface> {}
delegate(CloudflareDomainRuntime, storeFor, cloudflareDomainSurface);

const mailWarningSurface = {
  claimPeriods: "mailWarnings.claimPeriods",
  finishPeriod: "mailWarnings.finishPeriod",
} as const satisfies Surface<ControlStore>;

/** Private exhaustion-warning progress; owner emails and outbound provider credentials stay in Gateway. */
export class MailWarningRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface MailWarningRuntime extends Delegated<ControlStore, typeof mailWarningSurface> {}
delegate(MailWarningRuntime, storeFor, mailWarningSurface);

const signupFeedbackSurface = {
  claim: "signupFeedback.claim",
  begin: "signupFeedback.begin",
  finish: "signupFeedback.finish",
} as const satisfies Surface<ControlStore>;

/** Private progress for the approved signup feedback campaign; no recipient data is retained here. */
export class SignupFeedbackRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface SignupFeedbackRuntime
  extends Delegated<ControlStore, typeof signupFeedbackSurface> {}
delegate(SignupFeedbackRuntime, storeFor, signupFeedbackSurface);

const mailDeliverySurface = {
  listAdmission: "mailDelivery.listAdmission",
  readAdmission: "mailDelivery.readAdmission",
  changeAdmission: "mailDelivery.changeAdmission",
  unbilled: "mailDelivery.unbilled",
  bill: "mailDelivery.bill",
  authorizeKey: "mailDelivery.authorizeKey",
  read: "mailDelivery.read",
  claim: "mailDelivery.claim",
  complete: "mailDelivery.complete",
  list: "mailDelivery.list",
  due: "mailDelivery.due",
  defer: "mailDelivery.defer",
  expire: "mailDelivery.expire",
  acceptRetry: "mailDelivery.acceptRetry",
  resumeRetry: "mailDelivery.resumeRetry",
  completeRetry: "mailDelivery.completeRetry",
} as const satisfies Surface<ControlStore>;

/** Private inbound metadata and retry claims; no message content, signing key or provider authority. */
export class MailDeliveryRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface MailDeliveryRuntime extends Delegated<ControlStore, typeof mailDeliverySurface> {}
delegate(MailDeliveryRuntime, storeFor, mailDeliverySurface);

const mailInfrastructureSurface = {
  readReceipt: "mailInfrastructure.readReceipt",
  claim: "mailInfrastructure.claim",
  complete: "mailInfrastructure.complete",
} as const satisfies Surface<ControlStore>;

/** Private infrastructure-alert receipt capability; no customer mail, recipient or finance authority. */
export class MailInfrastructureRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface MailInfrastructureRuntime
  extends Delegated<ControlStore, typeof mailInfrastructureSurface> {}
delegate(MailInfrastructureRuntime, storeFor, mailInfrastructureSurface);

const mailSendSurface = {
  authorizeKey: "mailSend.authorizeKey",
  claim: "mailSend.claim",
  authorize: "mailSend.authorize",
  readKey: "mailSend.readKey",
  complete: "mailSend.complete",
  reject: "mailSend.reject",
  settle: "mailSend.settle",
} as const satisfies Surface<ControlStore>;

/** Private ordinary sender capability: retained request identities and their one original credit hold. */
export class MailSendRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface MailSendRuntime extends Delegated<ControlStore, typeof mailSendSurface> {}
delegate(MailSendRuntime, storeFor, mailSendSurface);

const aiGatewaySurface = {
  authorizeKey: "aiGateway.authorizeKey",
  admit: "aiGateway.admit",
  settle: "aiGateway.settle",
  release: "aiGateway.release",
  sweep: "aiGateway.sweep",
} as const satisfies Surface<ControlStore>;

/**
 * Private AI gateway capability: the key's scope, the admission, settlement and release of a credit reservation. It is
 * bound by the public gateway Worker, which must not change any tenant's settings, so the declaration of a jurisdiction is
 * not on it (see `ControlRuntime`).
 */
export class AiGatewayRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface AiGatewayRuntime extends Delegated<ControlStore, typeof aiGatewaySurface> {}
delegate(AiGatewayRuntime, storeFor, aiGatewaySurface);

const browserGatewaySurface = {
  authorizeKey: "browserGateway.authorizeKey",
  admit: "browserGateway.admit",
  settle: "browserGateway.settle",
  release: "browserGateway.release",
  sweep: "browserGateway.sweep",
} as const satisfies Surface<ControlStore>;

/** Private browser gateway credit and key authority. */
export class BrowserGatewayRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface BrowserGatewayRuntime
  extends Delegated<ControlStore, typeof browserGatewaySurface> {}
delegate(BrowserGatewayRuntime, storeFor, browserGatewaySurface);

const controlSurface = {
  authorizeNativeAuthOwner: "identity.authorizeNativeAuthOwner",
  proveNativeAuthUnprovisionedPolicy: "identity.proveNativeAuthUnprovisionedPolicy",
  readNativeAuthConfig: "identity.readNativeAuthConfig",
  updateNativeAuthConfig: "identity.updateNativeAuthConfig",
  readNativeAuthProvider: "identity.readNativeAuthProvider",
  updateNativeAuthProvider: "identity.updateNativeAuthProvider",
  readNativeAuthReadiness: "identity.readNativeAuthReadiness",
  acceptNativeUserOperation: "identity.acceptNativeAuthUserMutation",
  readMcpAuthorizedMemberships: "remoteMcp.readMcpAuthorizedMemberships",
  readMcpEnvironmentName: "remoteMcp.readMcpEnvironmentName",
  readMcpMailDomainOrganization: "remoteMcp.readMcpMailDomainOrganization",
  readMcpProjectOrganization: "remoteMcp.readMcpProjectOrganization",
  readMcpGrantRevision: "remoteMcp.readMcpGrantRevision",
  readMcpRecoveryContext: "remoteMcp.readMcpRecoveryContext",
  authorizeMcpExecution: "remoteMcp.authorizeMcpExecution",
  readMcpPlanEnvironmentName: "remoteMcp.readMcpPlanEnvironmentName",
  insertMcpHandoff: "identity.insertMcpHandoff",
  findMcpHandoff: "identity.findMcpHandoff",
  consumeMcpHandoff: "identity.consumeMcpHandoff",
  completeMcpSecret: "identity.completeMcpSecret",
  readNativeProviderHandoffState: "identity.readNativeProviderHandoffState",
  claimNativeProviderHandoff: "identity.claimNativeProviderHandoff",
  completeNativeProviderHandoff: "identity.completeNativeProviderHandoff",
  completeMcpGithub: "identity.completeMcpGithub",
  ensureMcpConnectionProof: "identity.ensureMcpConnectionProof",
  revokeMcpConsent: "identity.revokeMcpConsent",
  listOrganizationMcpConnections: "identity.listOrganizationMcpConnections",
  revokeOrganizationMcpConnection: "identity.revokeOrganizationMcpConnection",
  readProjectNotes: "apiMetadata.readProjectNotes",
  writeProjectNotes: "apiMetadata.writeProjectNotes",
  readProjectStorageJurisdiction: "apiMetadata.readProjectStorageJurisdiction",
  readPoweredByFlag: "apiMetadata.readPoweredByFlag",
  setPoweredByFlag: "apiMetadata.setPoweredByFlag",
  readProjectDatabaseOperation: "productDatabase.readOperation",
  readProjectComputeContext: "productDatabase.readComputeContext",
  readProjectDatabaseAccessHistory: "productDatabase.readAccessHistory",
  readProjectDatabaseAdmission: "productDatabase.readAdmission",
  recordProjectDatabaseEventAudit: "productDatabase.recordEventAudit",
  readProjectRecoveryOperation: "recovery.owner.readOperation",
  readProjectRecoveryState: ["recovery.executor.readClaimState", "jobState"],
  recordProjectRecoveryDispatchFailure: ["recovery.owner.recordDispatchFailure", "execution"],
  acknowledgeProjectRecoveryOutbox: "recovery.owner.acknowledgeOutbox",
  readProjectExportReplay: "recovery.owner.readExportReplay",
  acceptProjectRecoveryExport: ["recovery.owner.acceptProjectExport", "execution"],
  // Owner/API authority is kept off the Container's executor binding.
  acceptProjectRecoveryJob: ["recovery.owner.acceptRecoveryJob", "execution"],
  readProjectExportStatus: "recovery.owner.readExportStatus",
  readProjectRecoveryInventory: "recovery.executor.readScope",
  readProjectRecoveryArchive: ["recovery.owner.readArchive", "execution"],
  prepareProjectRecoveryDispatch: ["recovery.owner.prepareDispatch", "execution"],
  readProjectRecoveryCaptureHeld: ["recovery.owner.readCaptureHeld", "execution"],
  // BuildRunner's private receipt service: exact accepted build scopes, not a financial command surface.
  claimBuildInput: "build.claimBuildInput",
  authorizeBuildStart: "build.authorizeBuildStart",
  putBuildReceipt: "build.putBuildReceipt",
  putBuildUsage: "build.putBuildUsage",
  // identity
  applyWorkosOrganizationSnapshot: "identity.applyOrganizationSnapshot",
  assertOperationDelegationCurrent: "identity.assertOperationDelegationCurrent",
  // WorkOS management Worker: user API key lifecycle and session revocation/eligibility
  authorizeUserApiKeyScope: "identity.authorizeUserApiKeyScope",
  claimUserApiKeyCreation: "identity.claimUserApiKeyCreation",
  finishUserApiKeyCreation: "identity.finishUserApiKeyCreation",
  readUserApiKeyNames: "identity.readUserApiKeyNames",
  recordTerminalRevocation: "identity.recordTerminalRevocation",
  isSessionEligible: "identity.isSessionEligible",
  readSessionRevocation: "identity.readSessionRevocation",
  recordUserApiKeyRevocationAudit: "identity.recordUserApiKeyRevocationAudit",
  // projects
  createInitialProject: "projects.createInitialProject",
  // Control API customer project admission: one batch, plus the narrow reads of its authentication and authorization
  admitCustomerProject: "projects.admitCustomerProject",
  addDevelopmentEnvironment: "projects.addDevelopmentEnvironment",
  listCustomerProjects: "projects.listCustomerProjects",
  getCustomerProject: "projects.getCustomerProject",
  readTakenProjectHandles: "projects.readTakenProjectHandles",
  resolveWorkosOrganization: "projects.resolveWorkosOrganization",
  resolveM2mOrganization: "projects.resolveM2mOrganization",
  authorizeOrganizationAction: "projects.authorizeOrganizationAction",
  // operations
  acceptApiOperation: "operations.acceptApiOperation",
  queueOperation: "operations.queueOperation",
  loadOperation: "operations.loadOperation",
  transitionOperation: "operations.transitionOperation",
  readBlockingProductOperation: "operations.readBlockingProductOperation",
  renewOperationLease: "operations.renewOperationLease",
  /** One exact captured expired execution (owner-operated recovery); the shard-wide reaper is maintenance. */
  recoverExpiredOperationLease: "operations.recoverExpiredOperationLease",
  readStoredIdempotencyResponse: "operations.readStoredIdempotencyResponse",
  readAuditEvents: "operations.readAuditEvents",
  readDeploymentDiagnostics: "customerReads.readDeploymentDiagnostics",
  readEnvironmentFunctionRuns: "customerReads.readEnvironmentFunctionRuns",
  // outbox: the exact-event forms
  claimOutboxEvent: "operations.claimOutboxEvent",
  recordOutboxDeliveryFailure: "operations.recordOutboxDeliveryFailure",
  requireOutboxReconciliation: "operations.requireOutboxReconciliation",
  acknowledgeOutboxEvent: "operations.acknowledgeOutboxEvent",
  recoverExpiredFinalOutboxLease: "operations.recoverExpiredFinalOutboxLease",
  // inbox: the exact-organization forms
  claimInboxEvent: "operations.claimInboxEvent",
  renewInboxLease: "operations.renewInboxLease",
  acknowledgeInboxEvent: "operations.acknowledgeInboxEvent",
  failInboxEvent: "operations.failInboxEvent",
  findExpiredFinalInboxClaim: "operations.findExpiredFinalInboxClaim",
  recoverExpiredFinalInboxLease: "operations.recoverExpiredFinalInboxLease",
  // Context H: secrets. Public mutation receipt and delivery metadata remain one transaction.
  readApiEnvironmentSecrets: "secrets.readApiEnvironmentSecrets",
  mutateApiEnvironmentSecret: "secrets.mutateApiEnvironmentSecret",
  putEnvironmentSecret: "secrets.putEnvironmentSecret",
  ensureEnvironmentSecret: "secrets.ensureEnvironmentSecret",
  mutateEnvironmentSecret: "secrets.mutateEnvironmentSecret",
  listEnvironmentSecrets: "secrets.listEnvironmentSecrets",
  authorizeProviderEnvironmentSecret: "secrets.authorizeProviderEnvironmentSecret",
  // Context I: project domains (the Cloudflare platform hostnames).
  claimCloudflareProjectDomainsOperation: "domains.claimCloudflareProjectDomainsOperation",
  putCloudflareProjectDomains: "domains.putCloudflareProjectDomains",
  readCloudflareProjectDomains: "domains.readCloudflareProjectDomains",
  readCloudflareProjectDomainsForOperation: "domains.readCloudflareProjectDomainsForOperation",
  readCloudflareProjectDomainsByIdempotency: "domains.readCloudflareProjectDomainsByIdempotency",
  putCloudflareProjectDomainReceipt: "domains.putCloudflareProjectDomainReceipt",
  readCloudflareProjectDomainReceipts: "domains.readCloudflareProjectDomainReceipts",
  readCloudflareProjectDomainDeletionState: "domains.readCloudflareProjectDomainDeletionState",
  markCloudflareProjectDomainsDeletedForDeletion:
    "domains.markCloudflareProjectDomainsDeletedForDeletion",
} as const satisfies Surface<ControlStore>;

/**
 * Commands of the Control application Workers (API, orchestrator, management Workers). Reached only through a
 * service binding; there is no route. Every command is bound to the organization, event or operation the caller
 * names: nothing here drains a shard, reaps expired work or deletes retained rows, so a consumer of this
 * entrypoint gains no global authority. Only commands that are complete (guarded, idempotent, tested on real
 * D1) are listed: an unfinished command is absent rather than answering success.
 */
export class ControlRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface ControlRuntime extends Delegated<ControlStore, typeof controlSurface> {}
delegate(ControlRuntime, storeFor, controlSurface);

const recoverySurface = {
  // A purge grant reaches only this exact accepted cleanup target; the Node cannot supply a locator.
  readCleanupTarget: "recovery.cleanup.readCleanupTarget",
  recordNativeExportRetired: "recovery.cleanup.recordNativeExportRetired",
  readNativeRestorePinDeletionTarget: "recovery.cleanup.readNativeRestorePinDeletionTarget",
  recordNativeRestorePinDeletionAbsent: "recovery.cleanup.recordNativeRestorePinDeletionAbsent",
  readClaimState: ["recovery.executor.readClaimState", "jobState"],
  claim: ["recovery.executor.claim", "execution"],
  acquireFence: ["recovery.executor.acquireFence", "execution"],
  renewFence: ["recovery.executor.renewFence", "execution"],
  releaseFence: ["recovery.executor.releaseFence", "execution"],
  readScope: "recovery.executor.readScope",
  authorizeNativeCapture: ["recovery.executor.authorizeNativeCapture", "execution"],
  prepareArchive: ["recovery.executor.prepareArchive", "execution"],
  dispatchArchive: ["recovery.executor.dispatchArchive", "execution"],
  discardArchive: ["recovery.executor.discardArchive", "execution"],
  finish: ["recovery.executor.finish", "execution"],
  readArchive: ["recovery.owner.readArchive", "execution"],
} as const satisfies Surface<ControlStore>;

/** The existing closed Node wire, scoped again by the Worker mediator's action, job token and Container identity. */
export class RecoveryRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface RecoveryRuntime extends Delegated<ControlStore, typeof recoverySurface> {}
delegate(RecoveryRuntime, storeFor, recoverySurface);

const connectionBrokerMaintenanceSurface = {
  readConnectionRefreshOrphan: "connections.readConnectionRefreshOrphan",
  listConnectionRefreshOrphans: "connections.listConnectionRefreshOrphans",
  claimConnectionRefreshOrphanRevocation: "connections.claimConnectionRefreshOrphanRevocation",
  markConnectionRefreshOrphanRevocationDispatched:
    "connections.markConnectionRefreshOrphanRevocationDispatched",
  finishConnectionRefreshOrphanRevocation: "connections.finishConnectionRefreshOrphanRevocation",
  listExpiredConnectionGrants: "connections.listExpiredConnectionGrants",
  claimExpiredConnectionGrant: "connections.claimExpiredConnectionGrant",
  readConnectionGrantForRevocation: "connections.readConnectionGrantForRevocation",
  finishConnectionDisconnect: "connections.finishConnectionDisconnect",
  claimConnectionRevocation: "connections.claimConnectionRevocation",
  markConnectionRevocationDispatched: "connections.markConnectionRevocationDispatched",
  listDisconnectingConnectionGrants: "connections.listDisconnectingConnectionGrants",
  listConnectionOrphans: "connections.listConnectionOrphans",
  readConnectionOrphan: "connections.readConnectionOrphan",
  finishConnectionOrphanRevocation: "connections.finishConnectionOrphanRevocation",
  claimConnectionOrphanRevocation: "connections.claimConnectionOrphanRevocation",
  markConnectionOrphanRevocationDispatched: "connections.markConnectionOrphanRevocationDispatched",
} as const satisfies Surface<ControlStore>;
/** Bounded private revocation reconciliation; never a customer-facing capability. */
export class ConnectionBrokerMaintenanceRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface ConnectionBrokerMaintenanceRuntime
  extends Delegated<ControlStore, typeof connectionBrokerMaintenanceSurface> {}
delegate(ConnectionBrokerMaintenanceRuntime, storeFor, connectionBrokerMaintenanceSurface);

const connectionControlSurface = {
  createMakeActionBinding: "connections.createMakeActionBinding",
  createConnectionImport: "connections.createConnectionImport",
  listConnectionGrantMetadata: "connections.listConnectionGrantMetadata",
  createIntegrationPortalHandoff: "connections.createIntegrationPortalHandoff",
  readIntegrationPortalHandoff: "connections.readIntegrationPortalHandoff",
  consumeIntegrationPortalHandoff: "connections.consumeIntegrationPortalHandoff",
  readIntegrationPortalStatus: "connections.readIntegrationPortalStatus",
  createConnectionHandoff: "connections.createConnectionHandoff",
} as const satisfies Surface<ControlStore>;
/** Only Control can create a browser-bound handoff. */
export class ConnectionControlRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface ConnectionControlRuntime
  extends Delegated<ControlStore, typeof connectionControlSurface> {}
delegate(ConnectionControlRuntime, storeFor, connectionControlSurface);

const connectionBrokerSurface = {
  readMakeActionBinding: "connections.readMakeActionBinding",
  admitMakeActionExecution: "connections.admitMakeActionExecution",
  finishMakeActionExecution: "connections.finishMakeActionExecution",
  retainConnectionRefreshOrphan: "connections.retainConnectionRefreshOrphan",
  readConnectionRefreshOrphan: "connections.readConnectionRefreshOrphan",
  claimConnectionRefreshOrphanRevocation: "connections.claimConnectionRefreshOrphanRevocation",
  markConnectionRefreshOrphanRevocationDispatched:
    "connections.markConnectionRefreshOrphanRevocationDispatched",
  finishConnectionRefreshOrphanRevocation: "connections.finishConnectionRefreshOrphanRevocation",
  claimConnectionRefresh: "connections.claimConnectionRefresh",
  readActiveConnectionGrant: "connections.readActiveConnectionGrant",
  readConnectionGrantStatus: "connections.readConnectionGrantStatus",
  markConnectionRefreshDispatched: "connections.markConnectionRefreshDispatched",
  commitConnectionRefresh: "connections.commitConnectionRefresh",
  failConnectionRefresh: "connections.failConnectionRefresh",
  disconnectConnectionGrant: "connections.disconnectConnectionGrant",
  readConnectionGrantForRevocation: "connections.readConnectionGrantForRevocation",
  finishConnectionDisconnect: "connections.finishConnectionDisconnect",
  claimConnectionRevocation: "connections.claimConnectionRevocation",
  markConnectionRevocationDispatched: "connections.markConnectionRevocationDispatched",
  listDisconnectingConnectionGrants: "connections.listDisconnectingConnectionGrants",
  createConnectionHandoff: "connections.createConnectionHandoff",
  consumeConnectionHandoff: "connections.consumeConnectionHandoff",
  createConnectionAttempt: "connections.createConnectionAttempt",
  claimConnectionAttempt: "connections.claimConnectionAttempt",
  terminateConnectionAttempt: "connections.terminateConnectionAttempt",
  retainConnectionOrphan: "connections.retainConnectionOrphan",
  readConnectionOrphan: "connections.readConnectionOrphan",
  finishConnectionOrphanRevocation: "connections.finishConnectionOrphanRevocation",
  claimConnectionOrphanRevocation: "connections.claimConnectionOrphanRevocation",
  markConnectionOrphanRevocationDispatched: "connections.markConnectionOrphanRevocationDispatched",
  readConnectionAttemptOrigin: "connections.readConnectionAttemptOrigin",
  persistConnectionPendingGrant: "connections.persistConnectionPendingGrant",
  readConnectionConfirmationOrigin: "connections.readConnectionConfirmationOrigin",
  activateConnectionGrant: "connections.activateConnectionGrant",
} as const satisfies Surface<ControlStore>;
/** Private connection-broker authority; never exposed to customer Workers. */
export class ConnectionBrokerRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface ConnectionBrokerRuntime
  extends Delegated<ControlStore, typeof connectionBrokerSurface> {}
delegate(ConnectionBrokerRuntime, storeFor, connectionBrokerSurface);

const githubSurface = {
  readGithubAutoDeployTargets: "github.readGithubAutoDeployTargets",
  reserveGithubPushDeployment: "github.reserveGithubPushDeployment",
  attachGithubPushOperation: "github.attachGithubPushOperation",
  failGithubPushPlanning: "github.failGithubPushPlanning",
  readGithubSourceAuthorization: "github.readGithubSourceAuthorization",
  readGithubSourceAuthorizationByState: "github.readGithubSourceAuthorizationByState",
  readGithubSourceAuthorizationById: "github.readGithubSourceAuthorizationById",
  insertGithubSourceAuthorization: "github.insertGithubSourceAuthorization",
  claimGithubSourceAuthorization: "github.claimGithubSourceAuthorization",
  releaseGithubSourceAuthorization: "github.releaseGithubSourceAuthorization",
  completeGithubSourceAuthorization: "github.completeGithubSourceAuthorization",
  readGithubOrganizationMapping: "github.readGithubOrganizationMapping",
  readGithubConnection: "github.readGithubConnection",
  readGithubConnectionById: "github.readGithubConnectionById",
  hasActiveGithubConnection: "github.hasActiveGithubConnection",
  readGithubInstallationHints: "github.readGithubInstallationHints",
  revokeGithubConnection: "github.revokeGithubConnection",
  revokeGithubInstallationAccess: "github.revokeGithubInstallationAccess",
  readGithubConnectionAuthorization: "github.readGithubConnectionAuthorization",
  readGithubConnectionAuthorizationByState: "github.readGithubConnectionAuthorizationByState",
  readGithubConnectionAuthorizationById: "github.readGithubConnectionAuthorizationById",
  insertGithubConnectionAuthorization: "github.insertGithubConnectionAuthorization",
  failGithubConnectionAuthorization: "github.failGithubConnectionAuthorization",
  advanceGithubConnectionToOauth: "github.advanceGithubConnectionToOauth",
  claimGithubConnectionAuthorization: "github.claimGithubConnectionAuthorization",
  renewGithubConnectionProviderUse: "github.renewGithubConnectionProviderUse",
  releaseGithubConnectionProviderUse: "github.releaseGithubConnectionProviderUse",
  completeGithubConnection: "github.completeGithubConnection",
  readGithubRepositoryLinkConsent: "github.readGithubRepositoryLinkConsent",
  insertGithubRepositoryLinkConsent: "github.insertGithubRepositoryLinkConsent",
} as const satisfies Surface<ControlStore>;

/** The GitHub authorization state of the Control API: source-link and organization-connection attempts, connections and consents. */
export class GithubRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface GithubRuntime extends Delegated<ControlStore, typeof githubSurface> {}
delegate(GithubRuntime, storeFor, githubSurface);

const sharedMailSurface = {
  listDomains: "sharedMail.listDomains",
  readDomain: "sharedMail.readDomain",
  createDomain: "sharedMail.createDomain",
  beginRetire: "sharedMail.beginRetire",
  completeCommand: "sharedMail.completeCommand",
  readBinding: "sharedMail.readBinding",
  bindProject: "sharedMail.bindProject",
  detachProject: "sharedMail.detachProject",
} as const satisfies Surface<ControlStore>;

/** Customer admission of workspace senders and project sender bindings; provider phases stay with Mail. */
export class SharedMailRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface SharedMailRuntime extends Delegated<ControlStore, typeof sharedMailSurface> {}
delegate(SharedMailRuntime, storeFor, sharedMailSurface);

const devAccessSurface = {
  issueDevAccessTicket: "devAccess.issueDevAccessTicket",
  redeemDevAccess: "devAccess.redeemDevAccess",
  authorizeDevCombined: "devAccess.authorizeDevCombined",
  authorizeDevPage: "devAccess.authorizeDevPage",
  authorizeDevAccessSession: "devAccess.authorizeDevAccessSession",
  authorizeDevRuntimeProbe: "devAccess.authorizeDevRuntimeProbe",
  readDevShareState: "devAccess.readDevShareState",
  changeDevAccess: "devAccess.changeDevAccess",
} as const satisfies Surface<ControlStore>;

/** The Dev access capability of the Control API and its Dev-origin service: tickets, share links, sessions and probes. */
export class DevAccessRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface DevAccessRuntime extends Delegated<ControlStore, typeof devAccessSurface> {}
delegate(DevAccessRuntime, storeFor, devAccessSurface);

const webhookIngressSurface = {
  recordWorkosWebhook: "ingress.recordWorkosWebhook",
  recordGithubWebhook: "ingress.recordGithubWebhook",
  recordStripeWebhook: "ingress.recordStripeWebhook",
} as const satisfies Surface<ControlStore>;

/** Only WebhookIngress binds this fixed provider recording capability; no claim, money or SQL surface. */
export class WebhookIngressRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface WebhookIngressRuntime
  extends Delegated<ControlStore, typeof webhookIngressSurface> {}
delegate(WebhookIngressRuntime, storeFor, webhookIngressSurface);

const workosSurface = {
  authorizeUserApiKeyScope: "identity.authorizeUserApiKeyScope",
  claimUserApiKeyCreation: "identity.claimUserApiKeyCreation",
  finishUserApiKeyCreation: "identity.finishUserApiKeyCreation",
  readUserApiKeyNames: "identity.readUserApiKeyNames",
  recordTerminalRevocation: "identity.recordTerminalRevocation",
  isSessionEligible: "identity.isSessionEligible",
  readSessionRevocation: "identity.readSessionRevocation",
  recordUserApiKeyRevocationAudit: "identity.recordUserApiKeyRevocationAudit",
  // WorkOS management Worker: the snapshot poller (global WorkOS claim, exact-claim applies, failure and recovery)
  claimWorkosInboxEvent: "identity.claimWorkosInboxEvent",
  findExpiredFinalWorkosInboxClaim: "identity.findExpiredFinalWorkosInboxClaim",
  recordWorkosInboxFailure: "identity.recordWorkosInboxFailure",
  recoverExpiredFinalWorkosInboxLease: "identity.recoverExpiredFinalWorkosInboxLease",
  applyPolledWorkosSnapshot: "identity.applyPolledWorkosSnapshot",
  applyWorkosOrganizationDeletion: "identity.applyWorkosOrganizationDeletion",
  revokeLocalAuthorizationForUncertainSnapshot:
    "identity.revokeLocalAuthorizationForUncertainSnapshot",
  readCreditWarningScope: "identity.readCreditWarningScope",
  isCreditWarningOwner: "identity.isCreditWarningOwner",
  isSignupFeedbackClaim: "identity.isSignupFeedbackClaim",
  prepareWorkosOnboarding: "identity.prepareWorkosOnboarding",
  claimWorkosOnboardingOrganization: "identity.claimWorkosOnboardingOrganization",
  recordWorkosOnboardingOrganization: "identity.recordWorkosOnboardingOrganization",
  claimWorkosOnboardingMembership: "identity.claimWorkosOnboardingMembership",
  completeWorkosOnboarding: "identity.completeWorkosOnboarding",
} as const satisfies Surface<ControlStore>;

/**
 * WorkOS management's private capability: key/session, inbox, fixed onboarding and warning-scope commands.
 * Financial effects are internal to that one onboarding transaction; there is no arbitrary grant or Paid setter.
 * Only the WorkOS Worker binds it, so ordinary Control consumers do not gain a global WorkOS inbox drain.
 */
export class WorkosRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface WorkosRuntime extends Delegated<ControlStore, typeof workosSurface> {}
delegate(WorkosRuntime, storeFor, workosSurface);

const maintenanceSurface = {
  expireNativeRestoreInputs: "maintenance.expireNativeRestoreInputs",
  listParkedRows: "maintenance.listParkedRows",
  prepareProjectRecoveryMaintenance: "recovery.maintenance.prepareMaintenance",
  claimProjectRecoveryOutbox: "recovery.maintenance.claimOutbox",
  // shard-wide drains and reapers
  recoverExpiredOperationLease: "maintenance.recoverExpiredOperationLease",
  claimOutboxEvent: "maintenance.claimOutboxEvent",
  recoverExpiredFinalOutboxLease: "maintenance.recoverExpiredFinalOutboxLease",
  claimInboxEvent: "maintenance.claimInboxEvent",
  findExpiredFinalInboxClaim: "maintenance.findExpiredFinalInboxClaim",
  routeUnroutedInboxEvents: "maintenance.routeUnroutedInboxEvents",
  resolveProjectReservations: "maintenance.resolveProjectReservations",
  // doorbells
  claimDoorbells: "maintenance.claimDoorbells",
  settleDoorbell: "maintenance.settleDoorbell",
  healDoorbells: "maintenance.healDoorbells",
  /**
   * Scheduled repair of the domain reservation saga. It scans the whole directory for expired reservations and
   * settles them against any shard, so it is global authority and is not on ControlRuntime.
   */
  settleDomainReservations: "maintenance.settleDomainReservations",
} as const satisfies Surface<ControlStore>;

/**
 * Global authority of the Control API's scheduled work: shard-wide drains and reapers, the doorbells, unrouted
 * inbox routing, reservation resolution and GitHub auto-deploy. It is a separate entrypoint so a service binding to
 * `ControlRuntime` never carries it. The Control API Worker is its only binder (`CONTROL_MAINTENANCE_RUNTIME` in
 * its wrangler configuration). Prototype-only evidence/outbox destructive purges have no original authority
 * and are deliberately absent; original evidence and delivery history cannot acquire a new retention window.
 */
export class MaintenanceRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface MaintenanceRuntime extends Delegated<ControlStore, typeof maintenanceSurface> {}
delegate(MaintenanceRuntime, storeFor, maintenanceSurface);

const databaseManagementSurface = {
  readControlAuthority: ["databaseManagement.readControlAuthority", "none"],
  resolveClaim: "databaseManagement.resolveClaim",
  readPlacementPaidAccess: "databaseManagement.readPlacementPaidAccess",
  authorizeClaim: "databaseManagement.authorizeClaim",
  readTarget: "databaseManagement.readTarget",
  nextTargetVersion: "databaseManagement.nextTargetVersion",
  reserveOperation: "databaseManagement.reserveOperation",
  readOperation: "databaseManagement.readOperation",
  beginOperation: "databaseManagement.beginOperation",
  recordOperation: "databaseManagement.recordOperation",
  activateNewTarget: "databaseManagement.activateNewTarget",
  recordMigrationReceipt: "databaseManagement.recordMigrationReceipt",
  readRuntimeBinding: "databaseManagement.readRuntimeBinding",
  reservePgcfDatabaseRegistration: "databaseManagement.reservePgcfDatabaseRegistration",
  putPgcfDatabaseRegistration: "databaseManagement.putPgcfDatabaseRegistration",
  reservePgcfDatabaseReauthorization: "databaseManagement.reservePgcfDatabaseReauthorization",
  putPgcfDatabaseReauthorization: "databaseManagement.putPgcfDatabaseReauthorization",
  readPgcfDatabaseDeletion: "databaseManagement.readPgcfDatabaseDeletion",
  recordPgcfDeletionRevocation: "databaseManagement.recordPgcfDeletionRevocation",
  retirePgcfDatabaseTarget: "databaseManagement.retirePgcfDatabaseTarget",
} as const satisfies Surface<ControlStore>;

/** Only private database management holds this scoped provider/registry capability; no SQL, import or activation RPC. */
export class DatabaseManagementRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface DatabaseManagementRuntime
  extends Delegated<ControlStore, typeof databaseManagementSurface> {}
delegate(DatabaseManagementRuntime, storeFor, databaseManagementSurface);

const previewQaDatabaseSurface = {
  readRuntimeBinding: "databaseManagement.readRuntimeBinding",
  readApiProjectDataChangeState: "productApi.readApiProjectDataChangeState",
} as const satisfies Surface<ControlStore>;

/** Development spike: two existing reads, with no management or provider authority. */
export class PreviewQaDatabaseAuthority extends WorkerEntrypoint<ControlStoreBindings> {}
export interface PreviewQaDatabaseAuthority
  extends Delegated<ControlStore, typeof previewQaDatabaseSurface> {}
delegate<ControlStore, typeof previewQaDatabaseSurface>(
  PreviewQaDatabaseAuthority,
  (env): ControlStore => {
    if (env.CONTROL_PLATFORM_ENVIRONMENT !== "development") throw new Error("qa_unavailable");
    return storeFor(env);
  },
  previewQaDatabaseSurface,
);

const runtimeSecretDeliverySurface = {
  claim: "runtimeSecrets.claim",
  fail: "runtimeSecrets.fail",
  release: "runtimeSecrets.release",
  readPending: "runtimeSecrets.readPending",
  recordPendingAttempt: "runtimeSecrets.recordPendingAttempt",
  readState: "runtimeSecrets.readState",
  stageWfp: "runtimeSecrets.stageWfp",
  activateWfp: "runtimeSecrets.activateWfp",
  compensateWfp: "runtimeSecrets.compensateWfp",
  readActiveWfpTarget: "runtimeSecrets.readActiveWfpTarget",
  readRecordedWfpStage: "runtimeSecrets.readRecordedWfpStage",
  installPlatform: "runtimeSecrets.installPlatform",
  ensurePlatform: "runtimeSecrets.ensurePlatform",
  ensureAiGateway: "runtimeSecrets.ensureAiGateway",
  ensureBrowserGateway: "runtimeSecrets.ensureBrowserGateway",
  ensureMailGateway: "runtimeSecrets.ensureMailGateway",
  readPromotionMailGatewaySource: "runtimeSecrets.readPromotionMailGatewaySource",
  ensureStorageGateway: "runtimeSecrets.ensureStorageGateway",
} as const satisfies Surface<ControlStore>;

const qaPreviewMailKeySurface = {
  read: ["runtimeSecrets.readQaPreviewMailEnvelope", "none"],
} as const satisfies Surface<ControlStore>;
/** Only the fixed QA mail ciphertext; the key and its cipher remain in Runtime Secret Delivery. */
export class QaPreviewMailKeyAuthority extends WorkerEntrypoint<ControlStoreBindings> {}
export interface QaPreviewMailKeyAuthority
  extends Delegated<ControlStore, typeof qaPreviewMailKeySurface> {}
delegate<ControlStore, typeof qaPreviewMailKeySurface>(
  QaPreviewMailKeyAuthority,
  (env): ControlStore => {
    if (env.CONTROL_PLATFORM_ENVIRONMENT !== "development") throw new Error("qa_unavailable");
    return storeFor(env);
  },
  qaPreviewMailKeySurface,
);

/** Private actual RuntimeSecretDelivery persistence; it has no customer API, provider or cipher capability. */
export class RuntimeSecretDeliveryRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface RuntimeSecretDeliveryRuntime
  extends Delegated<ControlStore, typeof runtimeSecretDeliverySurface> {}
delegate(RuntimeSecretDeliveryRuntime, storeFor, runtimeSecretDeliverySurface);

const runtimeSecretAuthoritySurface = {
  authorizeManifest: "runtimeSecrets.authorizeManifest",
  registerNextCacheScope: "runtimeSecrets.registerNextCacheScope",
} as const satisfies Surface<ControlStore>;

/** Private WFP authority: a secret manifest reaches a provider only when Core stores exactly its names and revisions. */
export class RuntimeSecretAuthorityRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface RuntimeSecretAuthorityRuntime
  extends Delegated<ControlStore, typeof runtimeSecretAuthoritySurface> {}
delegate(RuntimeSecretAuthorityRuntime, storeFor, runtimeSecretAuthoritySurface);

const nextCacheRetirementAuthoritySurface = {
  authorizeRetirement: "runtimeSecrets.authorizeNextCacheRetirement",
} as const satisfies Surface<ControlStore>;
/** A deletion-only authority; it cannot alter customer cache data itself. */
export class NextCacheRetirementAuthorityRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface NextCacheRetirementAuthorityRuntime
  extends Delegated<ControlStore, typeof nextCacheRetirementAuthoritySurface> {}
delegate(NextCacheRetirementAuthorityRuntime, storeFor, nextCacheRetirementAuthoritySurface);

const nativeAuthRuntimeSurface = {
  readNativeAuthProviderEnvelope: "identity.readNativeAuthProviderEnvelope",
  resolve: "identity.resolveNativeAuthAuthority",
  resolveAtomic: "identity.resolveNativeAuthAtomicSnapshot",
  recordProviderSuccess: "identity.recordNativeAuthProviderSuccess",
} as const satisfies Surface<ControlStore>;

/** Private Native Auth custody only; no customer-facing configuration writes. */
export class NativeAuthRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface NativeAuthRuntime
  extends Delegated<ControlStore, typeof nativeAuthRuntimeSurface> {}
delegate(NativeAuthRuntime, storeFor, nativeAuthRuntimeSurface);

const nativeAuthAdminAuthoritySurface = {
  resolve: "identity.resolveNativeAuthAdminAuthority",
  resolveProvider: "identity.resolveNativeAuthProviderPolicy",
  authorizeOwnerOperation: "identity.authorizeNativeAuthOwnerOperation",
  authorizeAcceptedOperation: "identity.authorizeAcceptedNativeAuthUserMutation",
  readNativeRestoreForSanitization: "identity.readNativeRestoreForSanitization",
} as const satisfies Surface<ControlStore>;
/** Private policy fencing authority, including a withdrawn origin as null. */
export class NativeAuthAdminAuthorityRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface NativeAuthAdminAuthorityRuntime
  extends Delegated<ControlStore, typeof nativeAuthAdminAuthoritySurface> {}
delegate(NativeAuthAdminAuthorityRuntime, storeFor, nativeAuthAdminAuthoritySurface);

const nativeAuthResourceSurface = {
  readNativeAuthTarget: "identity.readNativeAuthTarget",
  readProvisioningPolicy: "identity.readNativeAuthProvisioningPolicy",
  readDomainPolicySync: "identity.readDomainPolicySync",
  ackDomainPolicySync: "identity.ackDomainPolicySync",
  beginHandleDomainRecovery: "identity.beginHandleDomainRecovery",
  completeHandleDomainRecovery: "identity.completeHandleDomainRecovery",
  readPendingNativePolicySync: "provisioning.readPendingNativePolicySync",
  completeNativePolicySync: "provisioning.completeNativePolicySync",
  readNativeAuthDatabaseReconciliation: "identity.readNativeAuthDatabaseReconciliation",
  readNativeAuthPreviewReconciliation: "identity.readNativeAuthPreviewReconciliation",
  resolveNativeAuthDatabaseClaim: "identity.resolveNativeAuthDatabaseClaim",
  initializeNativeAuthRealm: "identity.initializeNativeAuthRealm",
  reserveNativeAuthDatabaseOperation: "identity.reserveNativeAuthDatabaseOperation",
  beginNativeAuthDatabaseOperation: "identity.beginNativeAuthDatabaseOperation",
  recordNativeAuthDatabaseObservation: "identity.recordNativeAuthDatabaseObservation",
  reserveNativeAuthRoleOperation: "identity.reserveNativeAuthRoleOperation",
  beginNativeAuthRoleOperation: "identity.beginNativeAuthRoleOperation",
  recordNativeAuthRoleObservation: "identity.recordNativeAuthRoleObservation",
  recordNativeAuthPreparation: "identity.recordNativeAuthPreparation",
} as const satisfies Surface<ControlStore>;

/** Private exact-project resource identity, without database credentials or effect authority. */
export class NativeAuthResourceRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface NativeAuthResourceRuntime
  extends Delegated<ControlStore, typeof nativeAuthResourceSurface> {}
delegate(NativeAuthResourceRuntime, storeFor, nativeAuthResourceSurface);

const nativeAuthRegistryAuthoritySurface = {
  authorizeDeletion: "identity.authorizeNativeAuthDeletion",
  authorizeDeletionQuiescence: "identity.authorizeNativeAuthDeletionQuiescence",
  reserveRegistration: "identity.reserveNativeAuthRegistration",
  authorizeRegistration: "identity.authorizeNativeAuthRegistration",
  confirmRegistration: "identity.confirmNativeAuthRegistration",
  readRegistration: "identity.readNativeAuthRegistration",
  fenceRevocation: "identity.fenceNativeAuthRegistrationRevocation",
  authorizeRevocation: "identity.authorizeNativeAuthRegistrationRevocation",
  resolveRegistrationGeneration: "identity.resolveNativeAuthRegistrationGeneration",
  readDatabaseEnvironments: "identity.readNativeAuthDatabaseEnvironments",
} as const satisfies Surface<ControlStore>;
/** Exact Native registry metadata and accepted-operation fences, without credentials or SQL. */
export class NativeAuthRegistryAuthorityRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface NativeAuthRegistryAuthorityRuntime
  extends Delegated<ControlStore, typeof nativeAuthRegistryAuthoritySurface> {}
delegate(NativeAuthRegistryAuthorityRuntime, storeFor, nativeAuthRegistryAuthoritySurface);

const nativeAuthDeletionSurface = {
  read: "identity.readNativeAuthProjectDeletion",
  recordQuiescence: "identity.recordNativeAuthDeletionQuiescence",
  begin: "identity.beginNativeAuthProjectDeletion",
  recordObservation: "identity.recordNativeAuthProjectDeletionObservation",
  recordPurge: "identity.recordNativeAuthDeletionPurge",
  finish: "identity.finishNativeAuthProjectDeletion",
} as const satisfies Surface<ControlStore>;
/** Exact accepted Native project-deletion resource and receipt operations. */
export class NativeAuthDeletionRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface NativeAuthDeletionRuntime
  extends Delegated<ControlStore, typeof nativeAuthDeletionSurface> {}
delegate(NativeAuthDeletionRuntime, storeFor, nativeAuthDeletionSurface);

const nativeAuthRestorePreparationSurface = {
  read: "identity.readNativeAuthRestorePreparation",
  recordVerification: "identity.recordNativeAuthRestoreVerification",
} as const satisfies Surface<ControlStore>;
/** Exact restore preparation evidence for the private Neon executor only. */
export class NativeAuthRestorePreparationRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface NativeAuthRestorePreparationRuntime
  extends Delegated<ControlStore, typeof nativeAuthRestorePreparationSurface> {}
delegate(NativeAuthRestorePreparationRuntime, storeFor, nativeAuthRestorePreparationSurface);

const nativeAuthRestoreJobSurface = {
  accept: "identity.acceptNativeRestoreJob",
  authorizeAdmission: "identity.authorizeNativeRestoreAdmission",
  claim: "identity.claimNativeRestoreJob",
  readClaim: "identity.readNativeRestoreJobClaim",
  observe: "identity.observeNativeRestoreJob",
  readInput: "identity.readNativeRestoreJobInput",
  reservePin: "identity.reserveNativeRestorePin",
  recordPin: "identity.recordNativeRestorePin",
  recordPinAbsent: "identity.recordNativeRestorePinAbsent",
  readPinReconciliation: "identity.readNativeRestorePinReconciliation",
  completePinReconciliation: "identity.completeNativeRestorePinReconciliation",
  assertImportAllowed: "identity.assertNativeRestoreImportAllowed",
  beginRestore: "identity.beginNativeRestoreJob",
  isRealmImported: "identity.isNativeRestoreRealmImported",
  markRealmImported: "identity.markNativeRestoreRealmImported",
  isAcknowledged: "identity.isNativeRestoreAcknowledged",
  acknowledge: "identity.acknowledgeNativeRestoreJob",
  markImported: "identity.consumeNativeRestoreJobInput",
  finish: "identity.finishNativeRestoreJob",
} as const satisfies Surface<ControlStore>;
/** Exact claimed restore job; no caller-provided SQL, target or archive locator. */
export class NativeAuthRestoreJobRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface NativeAuthRestoreJobRuntime
  extends Delegated<ControlStore, typeof nativeAuthRestoreJobSurface> {}
delegate(NativeAuthRestoreJobRuntime, storeFor, nativeAuthRestoreJobSurface);

const nativeAuthMailSurface = {
  authorizeNativeMail: "identity.authorizeNativeMail",
} as const satisfies Surface<ControlStore>;

/** Private sender scope admission; mail credentials and dispatch remain with Mail. */
export class NativeAuthMailRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface NativeAuthMailRuntime
  extends Delegated<ControlStore, typeof nativeAuthMailSurface> {}
delegate(NativeAuthMailRuntime, storeFor, nativeAuthMailSurface);

const gatewayLookupSurface = {
  resolve: "gateway.lookup.resolve",
} as const satisfies Surface<ControlStore>;

/** The public gateway's closed hostname reader receives no route mutation or probe authority. */
export class GatewayLookupRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface GatewayLookupRuntime
  extends Delegated<ControlStore, typeof gatewayLookupSurface> {}
delegate(GatewayLookupRuntime, storeFor, gatewayLookupSurface);

const gatewayManagementSurface = {
  activate: "gateway.management.activate",
  observe: "gateway.management.observe",
  remove: "gateway.management.remove",
  compensate: "gateway.management.compensate",
  authorizeCandidateRemoval: "gateway.management.authorizeCandidateRemoval",
} as const satisfies Surface<ControlStore>;

/** Existing private WFP management authority, never a public HTTP or arbitrary SQL route. */
export class GatewayManagementRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface GatewayManagementRuntime
  extends Delegated<ControlStore, typeof gatewayManagementSurface> {}
delegate(GatewayManagementRuntime, storeFor, gatewayManagementSurface);

const runtimeProbeSurface = {
  beginProbe: "gateway.probe.beginProbe",
} as const satisfies Surface<ControlStore>;

/** Only the fixed, SQL-clock native accounting probe; caller-controlled clocks/durations are refused by its schema. */
export class RuntimeProbeRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface RuntimeProbeRuntime extends Delegated<ControlStore, typeof runtimeProbeSurface> {}
delegate(RuntimeProbeRuntime, storeFor, runtimeProbeSurface);

const billingSurface = {
  prepareStripeCustomer: "stripeBilling.prepareStripeCustomer",
  confirmStripeCustomer: "stripeBilling.confirmStripeCustomer",
  renewStripeCustomerIntent: "stripeBilling.renewStripeCustomerIntent",
  readStripeBillingCustomer: "stripeBilling.readStripeBillingCustomer",
  readOrganizationPaid: "stripeBilling.readOrganizationPaid",
  recordStripeSubscriptionEnd: "stripeBilling.recordStripeSubscriptionEnd",
  claimStripeBillingClosure: "stripeBilling.claimStripeBillingClosure",
  finishStripeBillingClosure: "stripeBilling.finishStripeBillingClosure",
  claimStripeInboxEvent: "stripeBilling.claimStripeInboxEvent",
  finishStripeInboxEvent: "stripeBilling.finishStripeInboxEvent",
  recoverExpiredStripeInboxClaims: "stripeBilling.recoverExpiredStripeInboxClaims",
  grantStripePayment: "stripeBilling.grantStripePayment",
  reverseStripePayment: "stripeBilling.reverseStripePayment",
  readRechargePolicy: "stripeBilling.readRechargePolicy",
  readRecharge: "stripeBilling.readRecharge",
  configureRecharge: "stripeBilling.configureRecharge",
  claimRecharge: "stripeBilling.claimRecharge",
  saveRechargeSetup: "stripeBilling.saveRechargeSetup",
  transitionRechargePolicy: "stripeBilling.transitionRechargePolicy",
  listRechargeCandidates: "stripeBilling.listRechargeCandidates",
} as const satisfies Surface<ControlStore>;

/** Only the private Billing Worker binds this exact Stripe source capability. */
export class BillingRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface BillingRuntime extends Delegated<ControlStore, typeof billingSurface> {}
delegate(BillingRuntime, storeFor, billingSurface);

const projectDispatchSurface = {
  recoverProductExecutionLease: "projectDispatch.recoverProductExecutionLease",
  claimProvisioningDispatch: "projectDispatch.provisioning.claim",
  recoverProvisioningDispatch: "projectDispatch.provisioning.recover",
  acknowledgeProvisioningDispatch: "projectDispatch.provisioning.acknowledge",
  failProvisioningDispatch: "projectDispatch.provisioning.fail",
  claimProductDispatch: "projectDispatch.product.claim",
  recoverProductDispatch: "projectDispatch.product.recover",
  acknowledgeProductDispatch: "projectDispatch.product.acknowledge",
  failProductDispatch: "projectDispatch.product.fail",
  claimManagedSourceDispatch: "projectDispatch.managedSource.claim",
  recoverManagedSourceDispatch: "projectDispatch.managedSource.recover",
  sweepExhaustedManagedSourceDispatch: "projectDispatch.managedSource.sweep",
  acknowledgeManagedSourceDispatch: "projectDispatch.managedSource.acknowledge",
  failManagedSourceDispatch: "projectDispatch.managedSource.fail",
  acceptProductDispatch: "projectDispatch.acceptProductDispatch",
  readProductDispatchIntent: "projectDispatch.readProductDispatchIntent",
  readManagedSourceDispatchState: "projectDispatch.readManagedSourceDispatchState",
} as const satisfies Surface<ControlStore>;

/** The Project publisher's three fixed drains; this binding has no arbitrary maintenance authority. */
export class ProjectDispatchRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface ProjectDispatchRuntime
  extends Delegated<ControlStore, typeof projectDispatchSurface> {}
delegate(ProjectDispatchRuntime, storeFor, projectDispatchSurface);

const projectWorkflowSurface = {
  completeProjectProvisioningHello: "provisioning.completeHello",
  failProjectProvisioningHello: "provisioning.failHello",
  reconcileProjectProvisioningHello: "provisioning.reconcileHello",
} as const satisfies Surface<ControlStore>;

/** Provisioning's exact terminal transactions; no generic operation-state mutation. */
export class ProjectWorkflowRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface ProjectWorkflowRuntime
  extends Delegated<ControlStore, typeof projectWorkflowSurface> {}
delegate(ProjectWorkflowRuntime, storeFor, projectWorkflowSurface);

const productApiPreviewSurface = {
  readInitialGithubCandidate: ["previews.readInitialGithubCandidate", "execution"],
  acceptInitialGithubSource: ["previews.acceptInitialGithubSource", "execution"],
  readGithubCandidates: ["previews.readGithubCandidates", "execution"],
  acceptGithubSource: ["previews.acceptGithubSource", "execution"],
  listProjectPendingSources: "previews.listProjectPendingSources",
  prepare: ["previews.prepare", "execution"],
  get: ["previews.get", "execution"],
  ensure: ["previews.ensure", "execution"],
  rotate: ["previews.rotate", "execution"],
  confirmRotation: ["previews.confirmRotation", "execution"],
  destroy: ["previews.destroy", "execution"],
  confirmDestroy: ["previews.confirmDestroy", "execution"],
} as const satisfies Surface<ControlStore>;
/** Customer control API alone receives encrypted capability custody. */
export class ProductApiPreviewRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface ProductApiPreviewRuntime
  extends Delegated<ControlStore, typeof productApiPreviewSurface> {}
delegate(ProductApiPreviewRuntime, storeFor, productApiPreviewSurface);

const projectPreviewSurface = {
  confirmRotation: ["previews.confirmRotation", "execution"],
  confirmDestroy: ["previews.confirmDestroy", "execution"],
  listPendingNativePreparations: "previews.listPendingNativePreparations",
  getNativePreparationCursor: ["previews.getNativePreparationCursor", "none"],
  setNativePreparationCursor: "previews.setNativePreparationCursor",
  queueNativePreparation: ["previews.queueNativePreparation", "execution"],
  readNativePreparation: "previews.readNativePreparation",
  listCleanupCandidates: ["previews.listCleanupCandidates", "execution"],
  claimScopeCleanup: ["previews.claimScopeCleanup", "execution"],
  finishScopeCleanup: ["previews.finishScopeCleanup", "execution"],
  resumeSuspended: ["previews.resumeSuspended", "execution"],
  getCleanupState: "previews.getCleanupState",
  resolveTokenHash: ["previews.resolveTokenHash", "execution"],
  authorizeRuntime: ["previews.authorizeRuntime", "execution"],
  authorizeDatabase: ["previews.authorizeDatabase", "execution"],
  readSource: ["previews.readSource", "execution"],
  recordState: ["previews.recordState", "execution"],
  recordStopped: ["previews.recordStopped", "execution"],
  recordAppliedSource: ["previews.recordAppliedSource", "execution"],
  recordBackup: ["previews.recordBackup", "execution"],
  listBackupCleanup: ["previews.listBackupCleanup", "execution"],
  acknowledgeBackupCleanup: ["previews.acknowledgeBackupCleanup", "execution"],
  claimExpiredBackup: ["previews.claimExpiredBackup", "execution"],
  renewActivity: ["previews.renewActivity", "execution"],
  reserveUsage: ["previews.reserveUsage", "execution"],
  closeUsage: ["previews.closeUsage", "execution"],
  listPendingSources: "previews.listPendingSources",
  acknowledgeSource: "previews.acknowledgeSource",
} as const satisfies Surface<ControlStore>;
/** Runtime can operate only scoped preview generations, never decrypt customer tokens. */
export class ProjectPreviewRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface ProjectPreviewRuntime
  extends Delegated<ControlStore, typeof projectPreviewSurface> {}
delegate(ProjectPreviewRuntime, storeFor, projectPreviewSurface);

const previewNativePreparationSurface = {
  recordPolicy: ["previews.recordNativePolicy", "execution"],
  claim: ["previews.claimNativePreparation", "execution"],
  finish: ["previews.finishNativePreparation", "execution"],
} as const satisfies Surface<ControlStore>;
/** PGCF manager alone may claim and complete the source-attested Native preparation. */
export class PreviewNativePreparationRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface PreviewNativePreparationRuntime
  extends Delegated<ControlStore, typeof previewNativePreparationSurface> {}
delegate(PreviewNativePreparationRuntime, storeFor, previewNativePreparationSurface);

const previewDatabaseAuthoritySurface = {
  authorizeDatabase: ["previews.authorizeDatabase", "execution"],
} as const satisfies Surface<ControlStore>;
/** Regional database reads only the current preview registration authority. */
export class PreviewDatabaseAuthorityRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface PreviewDatabaseAuthorityRuntime
  extends Delegated<ControlStore, typeof previewDatabaseAuthoritySurface> {}
delegate(PreviewDatabaseAuthorityRuntime, storeFor, previewDatabaseAuthoritySurface);

const previewTokenLookupSurface = {
  authorizeRuntime: ["previews.authorizeRuntime", "execution"],
  resolveTokenHash: ["previews.resolveTokenHash", "execution"],
} as const satisfies Surface<ControlStore>;
/** Ingress may resolve a token hash but cannot mutate preview state or read custody. */
export class PreviewTokenLookupRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface PreviewTokenLookupRuntime
  extends Delegated<ControlStore, typeof previewTokenLookupSurface> {}
delegate(PreviewTokenLookupRuntime, storeFor, previewTokenLookupSurface);

const previewNativeAuthAuthoritySurface = {
  resolve: ["previews.resolveNativeAuth", "execution"],
  resolveDrain: ["previews.resolveNativeDrain", "execution"],
  recordDrain: ["previews.recordNativeDrain", "execution"],
} as const satisfies Surface<ControlStore>;
/** Preview Native Auth receives the current scoped realm, never token or signing custody. */
export class PreviewNativeAuthAuthorityRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface PreviewNativeAuthAuthorityRuntime
  extends Delegated<ControlStore, typeof previewNativeAuthAuthoritySurface> {}
delegate(PreviewNativeAuthAuthorityRuntime, storeFor, previewNativeAuthAuthoritySurface);

const previewSecretAuthoritySurface = {
  listCustomerSecretNames: ["previews.listCustomerSecretNames", "execution"],
  readEnvelopes: ["previews.readEnvelopes", "execution"],
} as const satisfies Surface<ControlStore>;
/** Encrypted envelopes only for trusted runtime secret delivery. */
export class PreviewSecretAuthorityRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface PreviewSecretAuthorityRuntime
  extends Delegated<ControlStore, typeof previewSecretAuthoritySurface> {}
delegate(PreviewSecretAuthorityRuntime, storeFor, previewSecretAuthoritySurface);

const previewUsageReporterSurface = {
  getReconciliationCursor: ["previews.getReconciliationCursor", "none"],
  setReconciliationCursor: "previews.setReconciliationCursor",
  listUsageForReconciliation: ["previews.listUsageForReconciliation", "execution"],
  observeUsage: ["previews.observeUsage", "execution"],
} as const satisfies Surface<ControlStore>;
/** Only the trusted provider usage reader may report CPU observations. */
export class PreviewUsageReporterRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface PreviewUsageReporterRuntime
  extends Delegated<ControlStore, typeof previewUsageReporterSurface> {}
delegate(PreviewUsageReporterRuntime, storeFor, previewUsageReporterSurface);

const previewSourceSurface = {
  readSource: ["previews.readSource", "execution"],
} as const satisfies Surface<ControlStore>;
/** Source fetcher can read only the currently selected, scoped source grant. */
export class PreviewSourceRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface PreviewSourceRuntime
  extends Delegated<ControlStore, typeof previewSourceSurface> {}
delegate(PreviewSourceRuntime, storeFor, previewSourceSurface);

const managedSourceSurface = {
  readApiManagedSourceProjectScope: "managedSource.readApiManagedSourceProjectScope",
  readApiProjectSourceBinding: "managedSource.readApiProjectSourceBinding",
  readApiManagedSourceInitialization: "managedSource.readApiManagedSourceInitialization",
  readApiManagedSourcePublication: "managedSource.readApiManagedSourcePublication",
  readApiManagedSourceOperation: "managedSource.readApiManagedSourceOperation",
  authorizeApiManagedSourcePublication: "managedSource.authorizeApiManagedSourcePublication",
  reserveApiManagedSourceBlob: "managedSource.reserveApiManagedSourceBlob",
  recordApiManagedSourceBlob: "managedSource.recordApiManagedSourceBlob",
  sealApiManagedSourceManifest: "managedSource.sealApiManagedSourceManifest",
  recordApiManagedSourcePreparedCommit: "managedSource.recordApiManagedSourcePreparedCommit",
  beginApiManagedSourcePublication: "managedSource.beginApiManagedSourcePublication",
  recordApiManagedSourceRequest: "managedSource.recordApiManagedSourceRequest",
  completeApiManagedSourcePublication: "managedSource.completeApiManagedSourcePublication",
  failApiManagedSourcePublication: "managedSource.failApiManagedSourcePublication",
  readProcessorManagedSourceInitialization:
    "managedSource.readProcessorManagedSourceInitialization",
  authorizeProcessorManagedSourceInitialization:
    "managedSource.authorizeProcessorManagedSourceInitialization",
  attachProcessorManagedSourceInitializationChild:
    "managedSource.attachProcessorManagedSourceInitializationChild",
  completeProcessorManagedSourceInitializationChild:
    "managedSource.completeProcessorManagedSourceInitializationChild",
  rejectProcessorManagedSourceInitialization:
    "managedSource.rejectProcessorManagedSourceInitialization",
  readProcessorManagedSourceContext: "managedSource.readProcessorManagedSourceContext",
  rejectProcessorManagedSourcePublication: "managedSource.rejectProcessorManagedSourcePublication",
} as const satisfies Surface<ControlStore>;

/** Deployment parent's qualified accepted-scope primitives. No generic state/SQL/provider mutation is exposed. */
export class ManagedSourceRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface ManagedSourceRuntime
  extends Delegated<ControlStore, typeof managedSourceSurface> {}
delegate(ManagedSourceRuntime, storeFor, managedSourceSurface);

const productApiSurface = {
  readApiProductOperation: "productApi.readApiProductOperation",
  readApiProductScope: "productApi.readApiProductScope",
  readApiProductDeployment: "productApi.readApiProductDeployment",
  readApiProductDeployments: "productApi.readApiProductDeployments",
  readApiProductProject: "productApi.readApiProductProject",
  readApiProductStatus: "productApi.readApiProductStatus",
  readApiPlanningSource: "productApi.readApiPlanningSource",
  readApiDeploymentPlan: "productApi.readApiDeploymentPlan",
  readApiPromotionEnvironments: "productApi.readApiPromotionEnvironments",
  readApiPromotionTarget: "productApi.readApiPromotionTarget",
  readApiDeletionAdmission: "productApi.readApiDeletionAdmission",
  readApiRenameAdmission: "productApi.readApiRenameAdmission",
  readApiDeletePlanTarget: "productApi.readApiDeletePlanTarget",
  readApiRollbackTarget: "productApi.readApiRollbackTarget",
  issueApiActionConfirmation: "productApi.issueApiActionConfirmation",
  requireApiUsableConfirmation: "productApi.requireApiUsableConfirmation",
  createApiDeploymentPlan: "productApi.createApiDeploymentPlan",
  configureApiGithubAutoDeploy: "productApi.configureApiGithubAutoDeploy",
  readApiGithubAutoDeploy: "productApi.readApiGithubAutoDeploy",
  readApiProductReplay: "productApi.readApiProductReplay",
  acceptApiProductOperation: "productApi.acceptApiProductOperation",
  readApiProjectDataChangeState: "productApi.readApiProjectDataChangeState",
  issueApiProjectDataChangePlan: "productApi.issueApiProjectDataChangePlan",
} as const satisfies Surface<ControlStore>;

export class ProductApiRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface ProductApiRuntime extends Delegated<ControlStore, typeof productApiSurface> {}
delegate(ProductApiRuntime, storeFor, productApiSurface);

const publicEntrySurface = {
  recordPublicContact: "publicEntry.recordPublicContact",
  recordPublicFeatureVote: "publicEntry.recordPublicFeatureVote",
  readPublicFeatureVotes: "publicEntry.readPublicFeatureVotes",
  readPublicStats: "publicEntry.readPublicStats",
} as const satisfies Surface<ControlStore>;

export class PublicEntryRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface PublicEntryRuntime extends Delegated<ControlStore, typeof publicEntrySurface> {}
delegate(PublicEntryRuntime, storeFor, publicEntrySurface);

const publicEntryRetentionSurface = {
  purgePublicEntries: "publicEntryRetention.purgePublicEntries",
} as const satisfies Surface<ControlStore>;

export class PublicEntryRetentionRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface PublicEntryRetentionRuntime
  extends Delegated<ControlStore, typeof publicEntryRetentionSurface> {}
delegate(PublicEntryRetentionRuntime, storeFor, publicEntryRetentionSurface);

const customerFeedbackSurface = {
  submitCustomerFeedback: "customerFeedback.submitCustomerFeedback",
  readCustomerFeedbackStatus: "customerFeedback.readCustomerFeedbackStatus",
} as const satisfies Surface<ControlStore>;

export class CustomerFeedbackRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface CustomerFeedbackRuntime
  extends Delegated<ControlStore, typeof customerFeedbackSurface> {}
delegate(CustomerFeedbackRuntime, storeFor, customerFeedbackSurface);

/** The environment is the Worker's release binding, never a private caller's asserted value. */
function feedbackOperatorInput(env: ControlStoreBindings, input: unknown): Record<string, unknown> {
  if (
    (env.CONTROL_PLATFORM_ENVIRONMENT !== "development" &&
      env.CONTROL_PLATFORM_ENVIRONMENT !== "production") ||
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.hasOwn(input, "runtimeEnvironment")
  )
    throw new TypeError("Feedback operator input is invalid");
  return { ...input, runtimeEnvironment: env.CONTROL_PLATFORM_ENVIRONMENT };
}

/** Only a separately bound provider-side operator may preview or append feedback events. */
export class FeedbackOperatorRuntime extends WorkerEntrypoint<ControlStoreBindings> {
  preview(input: unknown) {
    return storeFor(this.env).feedbackOperator.preview(feedbackOperatorInput(this.env, input));
  }
  apply(input: unknown) {
    return storeFor(this.env).feedbackOperator.apply(feedbackOperatorInput(this.env, input));
  }
}

const storageGatewaySurface = {
  authenticateStorageGateway: "storageGateway.authenticateStorageGateway",
  claimStorageUpload: "storageGateway.claimStorageUpload",
  readStorageUploadReservation: "storageGateway.readStorageUploadReservation",
  completeStorageUpload: "storageGateway.completeStorageUpload",
  readStorageObject: "storageGateway.readStorageObject",
  claimStorageDelete: "storageGateway.claimStorageDelete",
  completeStorageErasure: "storageGateway.completeStorageErasure",
  readStorageObjects: "storageGateway.readStorageObjects",
  readUnconfirmedStorageClaims: "storageGateway.readUnconfirmedStorageClaims",
  markUnconfirmedStorageClaimAttempts: "storageGateway.markUnconfirmedStorageClaimAttempts",
  claimStorageDeletes: "storageGateway.claimStorageDeletes",
  completeStorageErasures: "storageGateway.completeStorageErasures",
} as const satisfies Surface<ControlStore>;

export class StorageGatewayRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface StorageGatewayRuntime
  extends Delegated<ControlStore, typeof storageGatewaySurface> {}
delegate(StorageGatewayRuntime, storeFor, storageGatewaySurface);

const storageDataSurface = {
  readRetiredStorageInventory: "storageData.readRetiredStorageInventory",
  claimRetiredStorageDeletes: "storageData.claimRetiredStorageDeletes",
  completeRetiredStorageDeletes: "storageData.completeRetiredStorageDeletes",
} as const satisfies Surface<ControlStore>;

export class StorageDataRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface StorageDataRuntime extends Delegated<ControlStore, typeof storageDataSurface> {}
delegate(StorageDataRuntime, storeFor, storageDataSurface);

const publicCreditSurface = {
  readCreditAccount: "publicCredits.readCreditAccount",
  readCreditOrganization: "publicCredits.readCreditOrganization",
  readCreditUsage: "publicCredits.readCreditUsage",
  readProjectCreditBudgetPublic: "publicCredits.readProjectCreditBudgetPublic",
  configureProjectCreditBudget: "publicCredits.configureProjectCreditBudget",
} as const satisfies Surface<ControlStore>;

export class PublicCreditRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface PublicCreditRuntime extends Delegated<ControlStore, typeof publicCreditSurface> {}
delegate(PublicCreditRuntime, storeFor, publicCreditSurface);

const gatewayCreditSurface = {
  read: "gatewayCredit.read",
} as const satisfies Surface<ControlStore>;

export class GatewayCreditRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface GatewayCreditRuntime
  extends Delegated<ControlStore, typeof gatewayCreditSurface> {}
delegate(GatewayCreditRuntime, storeFor, gatewayCreditSurface);

const creditSurface = {
  postUsage: "credit.postUsage",
  recordUsageFailure: "credit.recordUsageFailure",
  replayUsageFailures: "credit.replayUsageFailures",
  readCursor: "credit.readCursor",
  advanceCursor: "credit.advanceCursor",
  resolveScripts: "credit.resolveScripts",
  readRates: "credit.readRates",
  readLogPage: "credit.readLogPage",
  deleteLogThrough: "credit.deleteLogThrough",
  cursorsThrough: "credit.cursorsThrough",
  readLogsToday: "credit.readLogsToday",
  resolvePgcfDatabases: "credit.resolvePgcfDatabases",
  readPendingNativeDatabaseCreates: "credit.readPendingNativeDatabaseCreates",
  listR2Buckets: "credit.listR2Buckets",
  readResources: "credit.readResources",
  listStopBudgetProjects: "credit.listStopBudgetProjects",
  listCreditDeniedProjects: "credit.listCreditDeniedProjects",
} as const satisfies Surface<ControlStore>;

/** The credit service's view of the Core: usage posting, cursors, owners of scripts, databases, buckets and resources, prices and the credit log. */
export class CreditRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface CreditRuntime extends Delegated<ControlStore, typeof creditSurface> {}
delegate(CreditRuntime, storeFor, creditSurface);

const deploymentWorkflowSurface = {
  listNextCacheRetirementScopes: "runtimeSecrets.listNextCacheRetirementScopes",
  recordNextCacheRetired: "runtimeSecrets.recordNextCacheRetired",
  readProductProviderReconciliationContext:
    "provisioning.providerRecovery.readProductProviderReconciliationContext",
  findProductProviderReconciliationClaim:
    "provisioning.providerRecovery.findProductProviderReconciliationClaim",
  findClaimlessProductProviderReconciliationCandidate:
    "provisioning.providerRecovery.findClaimlessProductProviderReconciliationCandidate",
  readProductProviderReconciliationAttempt:
    "provisioning.providerRecovery.readProductProviderReconciliationAttempt",
  prepareProductProviderReconciliation:
    "provisioning.providerRecovery.prepareProductProviderReconciliation",
  recoverTerminalProductProviderReconciliationAttempt:
    "provisioning.providerRecovery.recoverTerminalProductProviderReconciliationAttempt",
  prepareProjectProvisioningQueueDeliveryRecovery:
    "provisioning.providerRecovery.prepareProjectProvisioningQueueDeliveryRecovery",
  finalizeProjectProvisioningQueueDeliveryRecovery:
    "provisioning.providerRecovery.finalizeProjectProvisioningQueueDeliveryRecovery",
  prepareSourceLinkQueueDeliveryRecovery:
    "provisioning.providerRecovery.prepareSourceLinkQueueDeliveryRecovery",
  finalizeSourceLinkQueueDeliveryRecovery:
    "provisioning.providerRecovery.finalizeSourceLinkQueueDeliveryRecovery",
  readClosedSourceLinkQueueDeliveryRecovery:
    "provisioning.providerRecovery.readClosedSourceLinkQueueDeliveryRecovery",
  readTerminalSourceLinkWorkflowReplayAttempt:
    "provisioning.providerRecovery.readTerminalSourceLinkWorkflowReplayAttempt",
  prepareDeploymentQueueDeliveryRecovery:
    "provisioning.providerRecovery.prepareDeploymentQueueDeliveryRecovery",
  finalizeDeploymentQueueDeliveryRecovery:
    "provisioning.providerRecovery.finalizeDeploymentQueueDeliveryRecovery",
  findProductWorkflowReplayCandidate:
    "provisioning.providerRecovery.findProductWorkflowReplayCandidate",
  findRunlessProductDispatch: "provisioning.providerRecovery.findRunlessProductDispatch",
  acceptRunlessProductDispatch: "provisioning.providerRecovery.acceptRunlessProductDispatch",
  finalizeProjectDeletionQueueHandoff:
    "provisioning.providerRecovery.finalizeProjectDeletionQueueHandoff",
  prepareProductWorkflowReplay: "provisioning.providerRecovery.prepareProductWorkflowReplay",
  readProductWorkflowReplayAttempt:
    "provisioning.providerRecovery.readProductWorkflowReplayAttempt",
  recoverTerminalProductWorkflowReplay:
    "provisioning.providerRecovery.recoverTerminalProductWorkflowReplay",
  findLostProductCommand: "provisioning.providerRecovery.findLostProductCommand",
  abandonLostProductCommand: "provisioning.providerRecovery.abandonLostProductCommand",
  reconcileProductCommand: "provisioning.providerRecovery.reconcileProductCommand",
  completeProductLifecycleCommand: "provisioning.completeLifecycleCommand",
  retainProductDeletionTombstone: "provisioning.retainDeletionTombstone",
  readWfpProjectDeletionEvidence: "provisioning.readDeletionEvidence",
  readCandidateCleanupResources: "provisioning.readCleanupResources",
  recordCleanupAttempt: "provisioning.recordCleanupAttempt",
  deleteProjectFunctionSchedules: "provisioning.deleteSchedules",
  readManagedSourceDeletionInventory: "provisioning.readManagedSourceInventory",
  startProjectDataChangeCleanup: "provisioning.startDataChange",
  appendAuditedProjectDataChangeAssignments: "provisioning.switchDataAssignments",
  readProductRollbackDataTarget: "provisioning.readRollbackDataTarget",
  renewProductOperationLease: "provisioning.renewOperationLease",
  finalizeProductHandleChange: "provisioning.finalizeHandleChange",
  reconcileProductWorkflow: "provisioning.reconcileWorkflow",
  prepareProductCandidateCleanup: "provisioning.prepareCandidateCleanup",
  claimProductCandidateCleanup: "provisioning.claimCandidateCleanup",
  recordProductCandidateCleanup: "provisioning.recordCandidateCleanup",
  markProductCandidateSuperseded: "provisioning.markCandidateSuperseded",
  recordProductDeploymentCandidate: "provisioning.recordCandidate",
  recordAbandonedGatewayPredecessor: "provisioning.recordAbandonedGateway",
  readProductDataEnvironment: "provisioning.readDataEnvironment",
  resolveProductRollbackCandidate: "provisioning.resolveRollback",
  assertProductBindingRefresh: "provisioning.assertBindingRefresh",
  finishProductBindingRefresh: "provisioning.finishBindingRefresh",
  finalizeProductCandidate: "provisioning.finalizeCandidate",
  finalizeProductRollback: "provisioning.finalizeRollback",
  assertProductOperationExecution: "provisioning.assertExecution",
  authorizeProductActivation: "provisioning.authorizeActivation",
  authorizeProductProviderMutation: "provisioning.authorizeProviderMutation",
  completeSourceLink: "provisioning.completeSourceLink",
  activateProductProviderReconciliationAttempt: "provisioning.activateReconciliationAttempt",
  activateProductWorkflowReplayAttempt: "provisioning.activateReplayAttempt",
  recordProductSourceArchiveEvidence: "provisioning.recordSourceArchive",
  observeSourceArchiveReceipt: "provisioning.observeSourceArchive",
  failProductDeployment: "provisioning.failDeployment",
  recordRuntimeHealthDiagnostic: "provisioning.recordHealthDiagnostic",
  readProductWorkflowContext: "provisioning.readContext",
  claimProductProviderMutation: "provisioning.claimProviderMutation",
  readProductWorkflowDatabaseTarget: "provisioning.readDatabaseTarget",
} as const satisfies Surface<ControlStore>;

export class DeploymentWorkflowRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface DeploymentWorkflowRuntime
  extends Delegated<ControlStore, typeof deploymentWorkflowSurface> {}
delegate(DeploymentWorkflowRuntime, storeFor, deploymentWorkflowSurface);

const databaseProductSurface = {
  beginWebhookActivation: "productDatabase.beginWebhookActivation",
  finishWebhookActivation: "productDatabase.finishWebhookActivation",
  abortWebhookActivation: "productDatabase.abortWebhookActivation",
  beginWebhookDeactivation: "productDatabase.beginWebhookDeactivation",
  finishWebhookDeactivation: "productDatabase.finishWebhookDeactivation",
  readWebhookSubscription: "productDatabase.readWebhookSubscription",
  expireProductDatabaseWrites: "productDatabase.expireWrites",
  readProductEntitlementTargets: "productDatabase.readEntitlementTargets",
  claimProductEntitlement: "productDatabase.claimEntitlement",
  beginProductEntitlement: "productDatabase.beginEntitlement",
  recordProductEntitlement: "productDatabase.recordEntitlement",
  recordProductEntitlementCheckFailure: "productDatabase.recordEntitlementCheckFailure",
  readProductDiagnosticTarget: "productDatabase.readDiagnosticTarget",
  replayProductCompute: "productDatabase.replayCompute",
  readProductComputeScope: "productDatabase.readComputeScope",
  acceptProductCompute: "productDatabase.acceptCompute",
  readProductComputeJob: "productDatabase.readComputeJob",
  claimProductCompute: "productDatabase.claimCompute",
  completeProductCompute: "productDatabase.completeCompute",
  recordProductCompute: "productDatabase.recordCompute",
  releaseProductComputeUse: "productDatabase.releaseComputeUse",
  readDueProductCompute: "productDatabase.readDueCompute",
  acknowledgeProductComputeOutbox: "productDatabase.acknowledgeComputeOutbox",
  issueProductDatabaseAccess: "productDatabase.issueAccess",
  readProductDatabaseAccess: "productDatabase.readAccess",
  readProductDatabaseAccessForIssuance: "productDatabase.readAccessForIssuance",
  revokeProductDatabaseAccess: "productDatabase.revokeAccess",
  recordProductDatabaseAccessOperation: "productDatabase.recordAccessOperation",
  readProductDatabaseAccessSweep: "productDatabase.readAccessSweep",
  markProductDatabaseAccessSweepAttempts: "productDatabase.markAccessSweepAttempts",
  readProductAccessCreditAdmission: "productDatabase.readAccessCreditAdmission",
  readDataChangeProductAccess: "productDatabase.readDataChangeAccess",
  acceptProductDatabaseWrite: "productDatabase.acceptWrite",
  finishProductDatabaseWrite: "productDatabase.finishWrite",
  readExpiredProductDatabaseWrites: "productDatabase.readExpiredWrites",
} as const satisfies Surface<ControlStore>;

/** The private database product owner: closed admission/receipt/maintenance methods, with no app SQL or credential. */
export class DatabaseProductRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface DatabaseProductRuntime
  extends Delegated<ControlStore, typeof databaseProductSurface> {}
delegate(DatabaseProductRuntime, storeFor, databaseProductSurface);

const productProviderAuthorizationSurface = {
  authorizeProductProviderMutation: "provisioning.authorizeProviderMutation",
} as const satisfies Surface<ControlStore>;

/** Private provider services receive only the original current accepted-claim authorization capability. */
export class ProductProviderAuthorizationRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface ProductProviderAuthorizationRuntime
  extends Delegated<ControlStore, typeof productProviderAuthorizationSurface> {}
delegate(ProductProviderAuthorizationRuntime, storeFor, productProviderAuthorizationSurface);

const diagnosticConsumerSurface = {
  recordDiagnostic: "diagnosticConsumer.recordDiagnostic",
  purgeDiagnostics: "diagnosticConsumer.purgeDiagnostics",
} as const satisfies Surface<ControlStore>;

/** Only DiagnosticIngestion receives these two fixed persistence commands; no SQL, import or activation authority. */
export class DiagnosticConsumerRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface DiagnosticConsumerRuntime
  extends Delegated<ControlStore, typeof diagnosticConsumerSurface> {}
delegate(DiagnosticConsumerRuntime, storeFor, diagnosticConsumerSurface);

const mailCapabilitySurface = {
  claim: "mailCapabilities.claim",
  read: "mailCapabilities.read",
  confirm: "mailCapabilities.confirm",
  release: "mailCapabilities.release",
} as const satisfies Surface<ControlStore>;

/** Shared provider-domain capability writer; provider credentials and transport remain in its actual caller. */
export class MailCapabilityRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface MailCapabilityRuntime
  extends Delegated<ControlStore, typeof mailCapabilitySurface> {}
delegate(MailCapabilityRuntime, storeFor, mailCapabilitySurface);

const r2ManagementSurface = {
  claimBucket: "r2Management.claimBucket",
  authorizeBucket: "r2Management.authorizeBucket",
  putBucket: "r2Management.putBucket",
  readBucket: "r2Management.readBucket",
  proveBucketAbsence: "r2Management.proveBucketAbsence",
  supersedeBucketReservation: "r2Management.supersedeBucketReservation",
  confirmedStorage: "r2Management.confirmedStorage",
} as const satisfies Surface<ControlStore>;

/** Actual R2 Management: four bucket commands and the confirmed-storage read, with no SQL or settlement authority. */
export class R2ManagementRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface R2ManagementRuntime extends Delegated<ControlStore, typeof r2ManagementSurface> {}
delegate(R2ManagementRuntime, storeFor, r2ManagementSurface);

const mailDnsSurface = {
  workspace: "cfMailDns.workspace",
  legacy: "cfMailDns.legacy",
  deletion: "cfMailDns.deletion",
  requirePaid: "cfMailDns.requirePaid",
  saveWorkspace: "cfMailDns.saveWorkspace",
  saveLegacy: "cfMailDns.saveLegacy",
} as const satisfies Surface<ControlStore>;

/** Mail DNS requirements and exact provider receipts; no OAuth or sending-key custody. */
export class MailDnsRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface MailDnsRuntime extends Delegated<ControlStore, typeof mailDnsSurface> {}
delegate(MailDnsRuntime, storeFor, mailDnsSurface);

const mailManagementSurface = {
  readDomain: "mailManagement.readDomain",
  readCustody: "mailManagement.readCustody",
  readLegacy: "mailManagement.readLegacy",
  readWorkspaceStatus: "mailManagement.readWorkspaceStatus",
  isReceivingOwner: "mailManagement.isReceivingOwner",
  hasLiveName: "mailManagement.hasLiveName",
  change: "mailManagement.change",
  requirePaid: "mailManagement.requirePaid",
  admitReceiving: "mailManagement.admitReceiving",
  configure: "mailManagement.configure",
  retire: "mailManagement.retire",
  retireLegacy: "mailManagement.retireLegacy",
} as const satisfies Surface<ControlStore>;

/** Provider-resource phases and original admission compounds; credentials, cipher and provider calls stay with Mail. */
export class MailManagementRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface MailManagementRuntime
  extends Delegated<ControlStore, typeof mailManagementSurface> {}
delegate(MailManagementRuntime, storeFor, mailManagementSurface);

const mailWorkspaceSurface = {
  readResource: "mailWorkspace.readResource",
  readView: "mailWorkspace.readView",
  change: "mailWorkspace.change",
  beginRetirement: "mailWorkspace.beginRetirement",
  finishRetirement: "mailWorkspace.finishRetirement",
  requirePaid: "mailManagement.requirePaid",
} as const satisfies Surface<ControlStore>;

/** Native/adopted workspace resource persistence, separate from customer sender authority and provider transport. */
export class MailWorkspaceRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface MailWorkspaceRuntime
  extends Delegated<ControlStore, typeof mailWorkspaceSurface> {}
delegate(MailWorkspaceRuntime, storeFor, mailWorkspaceSurface);

const mailDeletionSurface = {
  readScope: "mailDeletion.readScope",
  prepare: "mailDeletion.prepare",
  recordFound: "mailDeletion.recordFound",
  finish: "mailDeletion.finish",
} as const satisfies Surface<ControlStore>;

/** The frozen project-deletion Mail group; no generic resource inventory or absence writer is exposed. */
export class MailDeletionRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface MailDeletionRuntime extends Delegated<ControlStore, typeof mailDeletionSurface> {}
delegate(MailDeletionRuntime, storeFor, mailDeletionSurface);

const mailCommandSurface = {
  read: "mailCommands.read",
  begin: "mailCommands.begin",
  resume: "mailCommands.resume",
  complete: "mailCommands.complete",
  readWorkspace: "mailCommands.readWorkspace",
  claimWorkspaceRetirement: "mailCommands.claimWorkspaceRetirement",
} as const satisfies Surface<ControlStore>;

/** Fixed Mail command headers and accepted workspace receipt reads; no customer command admission authority. */
export class MailCommandRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface MailCommandRuntime extends Delegated<ControlStore, typeof mailCommandSurface> {}
delegate(MailCommandRuntime, storeFor, mailCommandSurface);

const mailManagementJobSurface = {
  listPendingLegacy: "mailManagementJobs.listPendingLegacy",
  claimLegacy: "mailManagementJobs.claimLegacy",
  claimDueIdentity: "mailManagementJobs.claimDueIdentity",
  suspendExpiredBindings: "mailManagementJobs.suspendExpiredBindings",
  listPendingWorkspaces: "mailManagementJobs.listPendingWorkspaces",
  listExpiredUnverifiedWorkspaces: "mailManagementJobs.listExpiredUnverifiedWorkspaces",
  claimWorkspace: "mailManagementJobs.claimWorkspace",
} as const satisfies Surface<ControlStore>;

/** Separate private scheduler authority for the original fixed Mail reconciliation cohorts. */
export class MailManagementJobRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface MailManagementJobRuntime
  extends Delegated<ControlStore, typeof mailManagementJobSurface> {}
delegate(MailManagementJobRuntime, storeFor, mailManagementJobSurface);

const applicationIdentitySurface = {
  read: "cfApplicationIdentity.read",
  declare: "cfApplicationIdentity.declare",
  replay: "cfApplicationIdentity.replay",
  readForVerification: "cfApplicationIdentity.readForVerification",
  completeAction: "cfApplicationIdentity.completeAction",
  readAutomatic: "cfApplicationIdentity.readAutomatic",
  completeAutomatic: "cfApplicationIdentity.completeAutomatic",
} as const satisfies Surface<ControlStore>;

/** CF observes the actual public proof; Core owns exact current proof and command atomicity, without DNS/token authority. */
export class ApplicationIdentityRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface ApplicationIdentityRuntime
  extends Delegated<ControlStore, typeof applicationIdentitySurface> {}
delegate(ApplicationIdentityRuntime, storeFor, applicationIdentitySurface);

const scopedDnsSurface = {
  readAuthorization: "cfScopedDns.readAuthorization",
  issue: "cfScopedDns.issue",
  status: "cfScopedDns.status",
  consume: "cfScopedDns.consume",
  saveGrant: "cfScopedDns.saveGrant",
  revoke: "cfScopedDns.revoke",
  listRevokedGrants: "cfScopedDns.listRevokedGrants",
  wipeRevokedGrantTokens: "cfScopedDns.wipeRevokedGrantTokens",
  listDisplacedTokens: "cfScopedDns.listDisplacedTokens",
  completeDisplacedToken: "cfScopedDns.completeDisplacedToken",
  claimUse: "cfScopedDns.claimUse",
  renewUse: "cfScopedDns.renewUse",
  authorizeUse: "cfScopedDns.authorizeUse",
  finishUse: "cfScopedDns.finishUse",
  releaseUse: "cfScopedDns.releaseUse",
  readCleanup: "cfScopedDns.readCleanup",
  completeEmptyCleanup: "cfScopedDns.completeEmptyCleanup",
} as const satisfies Surface<ControlStore>;

/** Original purpose-bound OAuth consent, sealed grant custody and guarded provider-use compounds. */
export class ScopedDnsRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface ScopedDnsRuntime extends Delegated<ControlStore, typeof scopedDnsSurface> {}
delegate(ScopedDnsRuntime, storeFor, scopedDnsSurface);

// Wrangler requires a default export to recognize this private RPC-only Worker as a module.
export default {};

const growthFactsSurface = {
  readFactPage: "growthFacts.readFactPage",
} as const satisfies Surface<ControlStore>;

/** Separate private cross-tenant, minimized growth source capability. */
export class GrowthFactsRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface GrowthFactsRuntime extends Delegated<ControlStore, typeof growthFactsSurface> {}
delegate(GrowthFactsRuntime, storeFor, growthFactsSurface);

const growthStripeCustomerSurface = {
  resolveGrowthStripeCustomer: "growthFacts.resolveGrowthStripeCustomer",
} as const satisfies Surface<ControlStore>;
/** Billing-only exact customer mapping, separate from cross-tenant source scans. */
export class GrowthStripeCustomerRuntime extends WorkerEntrypoint<ControlStoreBindings> {}
export interface GrowthStripeCustomerRuntime
  extends Delegated<ControlStore, typeof growthStripeCustomerSurface> {}
delegate(GrowthStripeCustomerRuntime, storeFor, growthStripeCustomerSurface);
