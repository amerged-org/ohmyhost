import type { ManagedMailPort } from "./managed-mail.js";
import type { OperationFailureDiagnostic } from "@ohmyhost/contracts/operation-failure";
import {
  parseFrameworkConversionDiagnostic,
  type FrameworkConversionDiagnostic,
} from "@ohmyhost/contracts/framework-admission";
import type { SaasCnameTarget } from "@ohmyhost/contracts/platform-origins";
import type { HostingRegion } from "@ohmyhost/platform";
import type { WorkosSessionStatusRequest } from "@ohmyhost/workos-auth-contracts";
import type { GithubSourceAuthorizationPort } from "./github-source-authorization.js";
import type { GithubOrganizationConnectionPort } from "./github-organization-connection.js";

import type {
  AuthorizationAction,
  AuthorizationRestriction,
  AuthorizationPort,
  AuthorizationPrincipal,
  AuthorizationResource,
  Clock,
  Operation,
  Ulid,
  UlidFactory,
} from "@ohmyhost/platform";

export const DEPLOYMENT_PLAN_TTL_SECONDS = 86_400;
export const ACTION_CONFIRMATION_TTL_SECONDS = 600;

export interface AuthenticatedPrincipal {
  readonly connectionDisconnected?: boolean;
  readonly handoffDelegation?: import("@ohmyhost/database").McpHandoffAuthority;
  readonly connectUser?: import("./workos-authenticator.js").VerifiedWorkosConnectPrincipal["connectUser"];
  readonly userApiKey?: import("@ohmyhost/workos-auth-contracts").WorkosUserApiKeyMetadata;
  readonly session?: WorkosSessionStatusRequest;
  readonly actorId: string;
  readonly credentialId: string;
  readonly authorizationPrincipal: AuthorizationPrincipal;
  readonly organizationIds: readonly Ulid[];
  readonly selectedOrganizationId?: Ulid;
  readonly authorizationScopeConstraint?: readonly string[];
  readonly authorizationRestriction?: AuthorizationRestriction;
}

export interface BearerAuthenticator {
  authenticate(token: string): Promise<AuthenticatedPrincipal | null>;
}

export interface CreateProjectPersistenceInput {
  readonly organizationId: Ulid;
  readonly name: string;
  readonly dataMode: "shared" | "isolated";
  /** Omitted preserves the normal Dev and Prod pair. */
  readonly includeDevelopmentEnvironment?: boolean;
  readonly devAccessMode?: "protected" | "public";
  readonly region: HostingRegion;
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly canonicalRequestDigest: Uint8Array;
  readonly requestId: string;
  readonly source?: { readonly provider: "managed"; readonly template: "vite-react" | "empty" };
  /** Verified Connect identity only; persistence resolves the current creation grant itself. */
  readonly sourceDelegation?: {
    readonly clientId: string;
    readonly consentHash: string;
    readonly authorizationRestriction?: AuthorizationRestriction;
    readonly action: AuthorizationAction;
  };
}

export interface CreatedProjectResponse {
  readonly status: 202;
  readonly location: string;
  readonly body: Readonly<{
    readonly id: Ulid;
    readonly state: "queued";
    readonly created_at: string;
    readonly updated_at: string;
  }>;
}

export interface ProjectCreateResponse {
  readonly status: 202;
  readonly location: string;
  readonly body: Readonly<{
    readonly id: Ulid;
    readonly state: "queued";
    readonly created_at: string;
    readonly updated_at: string;
    readonly project_id: Ulid;
  }>;
}

export interface AddDevelopmentEnvironmentPersistenceInput {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly principalId: string;
  readonly idempotencyKey: string;
  readonly canonicalRequestDigest: Uint8Array;
  readonly requestId: string;
  readonly delegation?: {
    readonly grantId: string;
    readonly clientId: string;
    readonly consentHash: string;
    readonly authorizationRestriction?: AuthorizationRestriction;
    readonly action: "projects:write";
  };
}

export interface AuditEventView {
  readonly eventId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly operationId: Ulid | null;
  readonly eventType: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly summary: string;
  readonly occurredAt: string;
}

export interface AuditPageView {
  readonly events: readonly AuditEventView[];
  readonly nextCursor: string | null;
}

export interface ProjectView {
  readonly projectId: Ulid;
  readonly organizationId: Ulid;
  readonly name: string;
  readonly handle: string;
  readonly dataMode: "shared" | "isolated";
  readonly region: HostingRegion;
  readonly createdAt: string;
}

export interface ProjectPageView {
  readonly projects: readonly ProjectView[];
  readonly nextCursor: Ulid | null;
}

export class InvalidProjectCursorError extends Error {
  public constructor() {
    super("Project cursor was not emitted for this tenant scope");
    this.name = "InvalidProjectCursorError";
  }
}

export class ProjectHandleAllocationExhaustedError extends Error {
  public readonly code = "project_handle_unavailable" as const;

  public constructor() {
    super("Project handle allocation exhausted every permitted candidate");
    this.name = "ProjectHandleAllocationExhaustedError";
  }
}

export class ProjectIdentityAllocationExhaustedError extends Error {
  public readonly code = "project_identity_unavailable" as const;

  public constructor() {
    super("Project identity allocation exhausted every permitted candidate");
    this.name = "ProjectIdentityAllocationExhaustedError";
  }
}

export type OperationView = Operation & {
  readonly blockingOperationId?: Ulid;
  /** The typed refusal stored with an auto-deploy planning rejection; rendered as error.detail. */
  readonly failureDiagnostic?: OperationFailureDiagnostic;
  /** The deployment this operation created, in every state, so a failed one can be diagnosed. */
  readonly deploymentId?: Ulid;
  readonly deploymentObservation?: {
    readonly buildCompletedAt?: string;
    readonly deploymentId: Ulid;
    readonly projectId: Ulid;
    readonly phase: "queued" | "building" | "publishing";
    readonly mailRequired: boolean;
  };
  readonly reconciliation?: import("@ohmyhost/contracts/operation-failure").OperationReconciliationObservation;
};

export interface ControlApiPersistence {
  submitFeedback(
    input: Omit<import("@ohmyhost/database").SubmitFeedbackInput, "feedbackId" | "submittedAt">,
  ): Promise<import("@ohmyhost/contracts/feedback").FeedbackReceipt>;
  /** The customer view of one report inside the caller's organizations, or null. */
  readFeedbackStatus(input: {
    readonly feedbackId: Ulid;
    readonly organizationIds: readonly Ulid[];
    readonly cursor?: Ulid;
  }): Promise<import("@ohmyhost/database").CustomerFeedbackStatusRecord | null>;
  createProject(input: CreateProjectPersistenceInput): Promise<ProjectCreateResponse>;
  addDevelopmentEnvironment?(
    input: AddDevelopmentEnvironmentPersistenceInput,
  ): Promise<CreatedProjectResponse>;
  /**
   * The handles among `candidates` that a project already holds. Availability is global, so this
   * answers across organizations without telling the caller which organization holds one.
   */
  takenProjectHandles(candidates: readonly string[]): Promise<ReadonlySet<string>>;
  listProjects(input: {
    readonly organizationIds: readonly Ulid[];
    readonly projectIds?: readonly Ulid[];
    readonly cursor?: Ulid;
    readonly limit: number;
  }): Promise<ProjectPageView>;
  getProject(organizationId: Ulid, projectId: Ulid): Promise<ProjectView | null>;
  getOperation(organizationId: Ulid, operationId: Ulid): Promise<OperationView | null>;
  readAuditEvents(input: {
    readonly organizationId: Ulid;
    readonly projectIds?: readonly Ulid[];
    readonly projectId?: Ulid;
    readonly operationId?: Ulid;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<AuditPageView>;
}

export interface ProductSurfaceResult {
  readonly status: 200 | 201 | 202;
  readonly body: Readonly<Record<string, unknown>>;
  readonly location?: string;
  readonly etag?: string;
}

export interface ProviderReconciliationPort {
  reconcile(input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly operationId: Ulid;
    readonly principalId: string;
    readonly idempotencySha256: `sha256:${string}`;
  }): Promise<
    Readonly<{
      attemptId: Ulid;
      operationId: Ulid;
      state: "completed" | "pending" | "uncertain";
    }>
  >;
}

export interface ProductSurfaceContext {
  readonly delegation?: {
    readonly action: AuthorizationAction;
    readonly authorizationRestriction?: AuthorizationRestriction;
    readonly grantId: string;
    readonly clientId: string;
    readonly consentHash: string;
  };
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly principalId: string;
  readonly requestId: string;
}

export interface ProductSurfaceMutationContext extends ProductSurfaceContext {
  readonly idempotencyKey: string;
  readonly canonicalRequestDigest: Uint8Array;
}

export interface EnvironmentSecretMetadataView {
  readonly name: string;
  readonly revision: number;
  readonly keyVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RuntimeSecretDeliveryMetadataView {
  readonly desiredGeneration: number;
  readonly appliedGeneration: number;
  readonly state: "not_deployed" | "pending" | "ready" | "failed";
  readonly runtimeProvider: "wfp" | null;
  readonly appliedSecretCount: number;
  readonly lastError: string | null;
}

export interface EnvironmentSecretContext extends ProductSurfaceContext {
  readonly delegation?: import("@ohmyhost/database").McpHandoffAuthority;
  readonly environmentId: Ulid;
}

export interface EnvironmentSecretMutationContext extends EnvironmentSecretContext {
  readonly idempotencyKey: string;
  readonly canonicalRequestDigest: Uint8Array;
}

/** Plaintext crosses this boundary only for one write and is never readable through the port. */
export interface EnvironmentSecretsPort {
  list(input: EnvironmentSecretContext): Promise<
    Readonly<{
      items: readonly EnvironmentSecretMetadataView[];
      delivery: RuntimeSecretDeliveryMetadataView;
    }>
  >;
  put(
    input: EnvironmentSecretMutationContext & {
      readonly name: string;
      readonly value: string;
    },
  ): Promise<EnvironmentSecretMetadataView & RuntimeSecretDeliveryMetadataView>;
  remove(
    input: EnvironmentSecretMutationContext & { readonly name: string },
  ): Promise<
    Readonly<{ name: string; status: "deleted" | "absent" }> & RuntimeSecretDeliveryMetadataView
  >;
  /** Generates a new value for an installed platform key; the value is sealed here and never returned. */
  rotate(
    input: EnvironmentSecretMutationContext & { readonly name: string },
  ): Promise<EnvironmentSecretMetadataView & RuntimeSecretDeliveryMetadataView>;
}

export interface ProjectMailDomainView {
  readonly domain: string;
  readonly status:
    | "configured"
    | "delegation_required"
    | "ready"
    | "verification_pending"
    | "verification_failed";
  readonly configuredAt: string;
  readonly observedAt?: string;
  readonly verificationIssue?:
    | "identity_missing"
    | "identity_verification_failed"
    | "dkim_verification_failed"
    | "dkim_records_changed"
    | "tenant_association_missing"
    | null;
  readonly nextCheckAfterSeconds?: 60 | 3600 | null;
  readonly nameServers?: readonly [string, string, string, string];
  readonly changeId?: string;
  readonly sending?: "disabled" | "pending" | "ready" | "failed";
  readonly receiving?: "disabled" | "pending" | "ready" | "failed";
  readonly dnsRecords?: readonly Readonly<{
    type: "MX" | "TXT" | "CNAME";
    name: string;
    value: string;
    status: string;
    priority?: number;
  }>[];
}

export interface ProjectMailDomainsPort {
  configure(
    input: ProductSurfaceMutationContext & { readonly domain: string },
  ): Promise<ProjectMailDomainView>;
  get(input: ProductSurfaceContext): Promise<ProjectMailDomainView | null>;
}

export interface CloudflareDomainAuthorizationView {
  readonly authorizationId: Ulid;
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

export interface CloudflareDnsAuthorizationStatusView {
  readonly status:
    | "not_authorized"
    | "pending"
    | "authorized"
    | "reauthorization_required"
    | "expired"
    | "revoked";
  readonly zone: string | null;
  readonly scopes: readonly ("dns.write" | "zone.read")[];
  readonly expiresAt: string | null;
}

export type CloudflareDomainAuthorizationCompletion =
  | "authorized"
  | "invalid"
  | "token_exchange_failed"
  | "zone_observe_failed"
  | "token_encrypt_failed"
  | "grant_persist_failed";

export interface PaidDomainPlanView {
  readonly status: "planned";
  readonly hostname: string;
  readonly environment: "prod";
  readonly cnameTarget: SaasCnameTarget;
  readonly effects: readonly string[];
  readonly risks: readonly string[];
}

export interface PaidDomainView {
  readonly status:
    | "not_configured"
    | "awaiting_deployment"
    | "pending"
    | "active"
    | "reconciliation_required"
    | "deleted"
    | "suspended";
  readonly suspensionReason:
    | "paid_plan_required"
    | "insufficient_organization_credits"
    | "project_budget_exceeded"
    | null;
  readonly hostname: string | null;
  readonly environment: "prod";
  readonly cnameTarget: SaasCnameTarget;
  readonly customHostnameStatus: string | null;
  readonly sslStatus: string | null;
  readonly validationRecords: readonly Readonly<{
    type: "CNAME" | "TXT";
    name: string;
    content: string;
    purpose: "traffic" | "ownership" | "ssl" | "dcv_delegation";
  }>[];
  readonly url: string | null;
}

export interface CloudflareDomainManagementPort {
  beginAuthorization(
    input: ProductSurfaceMutationContext & { readonly zone: string },
  ): Promise<CloudflareDomainAuthorizationView>;
  getStatus(input: ProductSurfaceContext): Promise<CloudflareDnsAuthorizationStatusView>;
  configureDomains(
    input: ProductSurfaceMutationContext & {
      readonly projectHandle: string;
    },
  ): Promise<ProductSurfaceResult>;
  planPaidDomain(
    input: ProductSurfaceContext & { readonly hostname: string },
  ): Promise<PaidDomainPlanView>;
  applyPaidDomain(
    input: ProductSurfaceMutationContext & { readonly hostname: string },
  ): Promise<PaidDomainView>;
  getPaidDomain(input: ProductSurfaceContext): Promise<PaidDomainView>;
  deletePaidDomain(
    input: ProductSurfaceMutationContext & { readonly hostname: string },
  ): Promise<PaidDomainView>;
  /** `principalId` is the user signed in to the portal in this browser; only the initiating user completes the state. */
  completeAuthorization(input: {
    readonly code: string;
    readonly state: string;
    readonly principalId: string;
  }): Promise<CloudflareDomainAuthorizationCompletion>;
}

export interface DevAccessTicketsPort {
  issue(input: ProductSurfaceContext): Promise<
    Readonly<{
      ticketId: Ulid;
      projectId: Ulid;
      environmentId: Ulid;
      origin: string;
      redeemUrl: string;
      expiresAt: string;
    }>
  >;
}

export interface DevAccessRedeemInput {
  readonly ticket: string;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly handle: string;
  readonly origin: string;
  /** The gateway-observed client address, aggregated by the rate-limit key helper. */
  readonly clientAddress: string;
}

export interface DevAccessRedeemResult {
  readonly sessionToken: string;
  readonly expiresAt: string;
}

export interface DevAccessAuthorizeInput {
  readonly organizationHint?: Ulid;
  readonly sessionToken: string | null;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly handle: string;
  readonly origin: string;
}

export interface DevAccessAuthorizeResult {
  readonly authorized: boolean;
}
export interface DeploymentDiagnosticsPort {
  list(
    input: ProductSurfaceContext & {
      readonly deploymentId: Ulid;
      readonly cursor?: string;
      readonly limit: number;
    },
  ): Promise<
    Readonly<{ items: readonly Readonly<Record<string, unknown>>[]; nextCursor: string | null }>
  >;
}

/** One scheduled function run as the customer sees it; values are timing and outcome only. */
export interface FunctionRunView {
  readonly id: Ulid;
  readonly deployment_id: Ulid;
  readonly cron: string;
  readonly scheduled_at: string;
  readonly state: "due" | "running" | "retry" | "succeeded" | "failed" | "skipped";
  readonly attempt: number;
  readonly status_code: number | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

export interface FunctionRunsPort {
  list(
    input: ProductSurfaceContext & { readonly environmentId: Ulid; readonly limit: number },
  ): Promise<Readonly<{ items: readonly FunctionRunView[] }>>;
}

export type ProjectDatabaseAccessIssueInput = ProductSurfaceContext &
  import("@ohmyhost/contracts/database-access").ProjectDatabaseAccessRequest;

export interface ProjectDatabaseAccessListInput extends ProductSurfaceContext {
  readonly environment?: "dev" | "prod";
}

export interface ProjectDatabaseAccessRevokeInput extends ProductSurfaceContext {
  readonly accessId: Ulid;
}

/** A credential leaves the platform once; every later read is metadata only. */
export interface ProjectDatabaseAccessPort {
  issue(
    input: ProjectDatabaseAccessIssueInput,
  ): Promise<import("@ohmyhost/contracts/database-access").ProjectDatabaseAccessCredential | null>;
  list(
    input: ProjectDatabaseAccessListInput,
  ): Promise<import("@ohmyhost/contracts/database-access").ProjectDatabaseAccessPage>;
  revoke(
    input: ProjectDatabaseAccessRevokeInput,
  ): Promise<import("@ohmyhost/contracts/database-access").ProjectDatabaseAccess | null>;
}

type DatabaseEventsScope = ProductSurfaceContext & {
  readonly environment: import("@ohmyhost/contracts/database-access").DatabaseEnvironment;
};

/** Every refusal the management boundary can give, mapped to a public problem by the routes. */
export type ProjectDatabaseEventsRejection =
  | "invalid"
  | "webhook_limit"
  | "schedule_limit"
  | "schedule_not_runnable"
  | "delivery_pending"
  | "throttled"
  | "idempotency_key_reused"
  | "pending"
  | "watch_table_unavailable"
  | "watch_column_unavailable"
  | "watch_events_unavailable"
  | "watch_conflict"
  | "watch_limit"
  | "table_conflict"
  | "table_limit";

/** A table the boundary created or found identical, with the environment it was asked in. */
export type ProjectDatabaseTableCreated =
  import("@ohmyhost/contracts/database-tables").DatabaseTableCreated & {
    readonly environment: import("@ohmyhost/contracts/database-access").DatabaseEnvironment;
  };

/** Webhooks, deliveries, schedules, watches, tables and execution usage; null means absent for this project. */
export interface ProjectDatabaseEventsPort {
  activateWebhookSubscription(
    input: DatabaseEventsScope & {
      readonly subscriptionId: string;
      readonly generation: number;
      readonly idempotencyKey: string;
      readonly request: import("@ohmyhost/contracts/database-events").DatabaseWebhookCreateRequest;
    },
  ): Promise<
    import("@ohmyhost/contracts/database-events").DatabaseWebhookSubscriptionActivation | null
  >;
  deactivateWebhookSubscription(
    input: DatabaseEventsScope & {
      readonly subscriptionId: string;
      readonly generation: number;
      readonly idempotencyKey: string;
    },
  ): Promise<import("@ohmyhost/contracts/database-events").DatabaseWebhookSubscription | null>;
  getWebhookSubscription(
    input: DatabaseEventsScope & { readonly subscriptionId: string },
  ): Promise<import("@ohmyhost/contracts/database-events").DatabaseWebhookSubscription | null>;
  createWebhook(
    input: DatabaseEventsScope & {
      readonly idempotencyKey: string;
      readonly request: import("@ohmyhost/contracts/database-events").DatabaseWebhookCreateRequest;
    },
  ): Promise<import("@ohmyhost/contracts/database-events").DatabaseWebhookCreated | null>;
  listWebhooks(
    input: DatabaseEventsScope,
  ): Promise<import("@ohmyhost/contracts/database-events").DatabaseWebhookPage | null>;
  getWebhook(
    input: DatabaseEventsScope & { readonly webhookId: string },
  ): Promise<import("@ohmyhost/contracts/database-events").DatabaseWebhook | null>;
  deleteWebhook(
    input: DatabaseEventsScope & { readonly webhookId: string; readonly idempotencyKey: string },
  ): Promise<import("@ohmyhost/contracts/database-events").DatabaseWebhookDeleted | null>;
  testWebhook(
    input: DatabaseEventsScope & { readonly webhookId: string; readonly idempotencyKey: string },
  ): Promise<import("@ohmyhost/contracts/database-events").DatabaseWebhookTestResult | null>;
  listDeliveries(
    input: DatabaseEventsScope & {
      readonly webhookId: string | null;
      readonly limit: number;
      readonly cursor: string | null;
    },
  ): Promise<import("@ohmyhost/contracts/database-events").DatabaseWebhookDeliveryPage | null>;
  replayDelivery(
    input: DatabaseEventsScope & { readonly deliveryId: string; readonly idempotencyKey: string },
  ): Promise<import("@ohmyhost/contracts/database-events").DatabaseWebhookReplayAccepted | null>;
  createWatch(
    input: DatabaseEventsScope & {
      readonly request: import("@ohmyhost/contracts/database-events").DatabaseWatchRequest;
    },
  ): Promise<import("@ohmyhost/contracts/database-events").DatabaseWatch | null>;
  listWatches(
    input: DatabaseEventsScope,
  ): Promise<import("@ohmyhost/contracts/database-events").DatabaseWatchPage | null>;
  createTable(
    input: DatabaseEventsScope & {
      readonly request: import("@ohmyhost/contracts/database-tables").DatabaseTableRequest;
    },
  ): Promise<ProjectDatabaseTableCreated | null>;
  deleteWatch(
    input: DatabaseEventsScope & { readonly watchId: string },
  ): Promise<import("@ohmyhost/contracts/database-events").DatabaseWatchDeleted | null>;
  setSchedule(
    input: DatabaseEventsScope & {
      readonly name: string;
      readonly request: import("@ohmyhost/contracts/database-events").DatabaseScheduleSetRequest;
    },
  ): Promise<import("@ohmyhost/contracts/database-events").DatabaseSchedule | null>;
  listSchedules(
    input: DatabaseEventsScope,
  ): Promise<import("@ohmyhost/contracts/database-events").DatabaseSchedulePage | null>;
  getSchedule(
    input: DatabaseEventsScope & { readonly name: string },
  ): Promise<import("@ohmyhost/contracts/database-events").DatabaseSchedule | null>;
  deleteSchedule(
    input: DatabaseEventsScope & { readonly name: string },
  ): Promise<import("@ohmyhost/contracts/database-events").DatabaseScheduleDeleted | null>;
  listScheduleRuns(
    input: DatabaseEventsScope & { readonly name: string; readonly limit: number },
  ): Promise<import("@ohmyhost/contracts/database-events").DatabaseScheduleRunPage | null>;
  runSchedule(
    input: DatabaseEventsScope & { readonly name: string; readonly idempotencyKey: string },
  ): Promise<import("@ohmyhost/contracts/database-events").DatabaseScheduleRunAccepted | null>;
  readExecutionUsage(
    input: DatabaseEventsScope & {
      readonly window: import("@ohmyhost/contracts/database-events").DatabaseUsageWindow;
      readonly limit: number;
      readonly cursor: string | null;
    },
  ): Promise<import("@ohmyhost/contracts/database-events").DatabaseExecutionUsagePage | null>;
}

export interface ProjectDatabaseDiagnosticsPort {
  query(
    input: ProductSurfaceContext & {
      readonly environment: "dev" | "prod";
      readonly statement: string;
      readonly parameters: readonly (string | number | boolean | null)[];
    },
  ): Promise<
    | Readonly<{
        environment: "dev" | "prod";
        rows: readonly Readonly<Record<string, unknown>>[];
        rowCount: number;
        truncated: boolean;
      }>
    // null: the environment has no database
    | null
  >;
}

/** Provider-neutral use-case boundary for the public WP-26--WP-30 API surface. */
export interface ProductSurfacePort {
  planDataChange?(
    input: ProductSurfaceContext & {
      readonly change: import("@ohmyhost/contracts/project-data-changes").ProjectDataChangeKind;
    },
  ): Promise<ProductSurfaceResult | null>;
  changeData?(
    input: ProductSurfaceMutationContext & {
      readonly change: import("@ohmyhost/contracts/project-data-changes").ProjectDataChangeKind;
      readonly ifMatch: string;
      readonly confirmationToken: string;
    },
  ): Promise<ProductSurfaceResult | null>;
  getProjectStatus(input: ProductSurfaceContext): Promise<ProductSurfaceResult | null>;
  getSource(input: ProductSurfaceContext): Promise<ProductSurfaceResult | null>;
  configureAutoDeploy(
    input: ProductSurfaceMutationContext & {
      readonly branchRef: string;
      readonly enabled: boolean;
    },
  ): Promise<ProductSurfaceResult | null>;
  getAutoDeploy(input: ProductSurfaceContext): Promise<ProductSurfaceResult | null>;
  planDeployment(
    input: ProductSurfaceContext & {
      readonly commitSha: string;
      readonly sourceConnectionId?: Ulid;
      /** Dev unless the customer builds straight into Prod (D312). */
      readonly environment?: "dev" | "prod";
    },
  ): Promise<ProductSurfaceResult>;
  createDeployment(
    input: ProductSurfaceMutationContext & { readonly planId: Ulid },
  ): Promise<ProductSurfaceResult>;
  listDeployments(
    input: ProductSurfaceContext & { readonly cursor?: string; readonly limit: number },
  ): Promise<ProductSurfaceResult>;
  getDeployment(
    input: ProductSurfaceContext & { readonly deploymentId: Ulid },
  ): Promise<ProductSurfaceResult | null>;
  planRollback(
    input: ProductSurfaceContext & { readonly targetDeploymentId: Ulid },
  ): Promise<ProductSurfaceResult | null>;
  rollback(
    input: ProductSurfaceMutationContext & {
      readonly targetDeploymentId: Ulid;
      readonly ifMatch: string;
      readonly confirmationToken: string;
    },
  ): Promise<ProductSurfaceResult | null>;
  /** Moves a project to the address its customer chose; both gateways move before it is stored. */
  changeProjectHandle(
    input: ProductSurfaceMutationContext & {
      readonly handle: string;
      readonly ifMatch: string;
    },
  ): Promise<ProductSurfaceResult | null>;
  planPromotion(
    input: ProductSurfaceContext & { readonly sourceDeploymentId: Ulid },
  ): Promise<ProductSurfaceResult | null>;
  promote(
    input: ProductSurfaceMutationContext & {
      readonly sourceDeploymentId: Ulid;
      readonly ifMatch: string;
      readonly confirmationToken: string;
    },
  ): Promise<ProductSurfaceResult | null>;
  planDelete(input: ProductSurfaceContext): Promise<ProductSurfaceResult | null>;
  deleteProject(
    input: ProductSurfaceMutationContext & {
      readonly ifMatch: string;
      readonly confirmationToken: string;
    },
  ): Promise<ProductSurfaceResult | null>;
}

export interface ControlApiDependencies {
  readonly integrations?: import("./integrations.js").IntegrationManagementPort;
  readonly usageLog?: {
    readonly report: import("./usage-log.js").UsageReporter;
    readonly environment: "development" | "production";
    readonly version: string | null;
  };
  readonly growthProductResult?: (result: {
    accountId: string | null;
    organizationId: string;
    status: number;
  }) => void;
  /** The selected store can atomically accept the initial managed-source waiting recipe; this does not expose source editing. */
  readonly managedProjectCreation?: boolean;
  readonly managedSources?: import("./managed-source-surface.js").ManagedSourceSurface;
  readonly previews?: import("./preview-surface.js").PreviewSurface;
  /** Internal composition only; no HTTP header can create this authentication context. */
  readonly internalAuthentication?: {
    resolve(request: Request): Promise<AuthenticatedPrincipal | null>;
    revalidate(principal: AuthenticatedPrincipal): Promise<AuthenticatedPrincipal | null>;
  };
  readonly remoteAuthorization?: (
    principal: AuthenticatedPrincipal,
    resource: AuthorizationResource,
    action: AuthorizationAction,
  ) => Promise<boolean>;
  readonly remoteProjectIds?: (
    principal: AuthenticatedPrincipal,
    organizationIds: readonly Ulid[],
  ) => Promise<readonly Ulid[]>;
  readonly remoteMailDomainDelegation?: (
    principal: AuthenticatedPrincipal,
    organizationId: string,
    mailDomainId: string,
  ) => Promise<{
    readonly grantId: string;
    readonly clientId: string;
    readonly consentHash: string;
    readonly grantRevision: number;
    readonly authorizationRestriction?: AuthorizationRestriction;
  } | null>;
  readonly remoteDelegation?: (
    principal: AuthenticatedPrincipal,
    projectId: string,
  ) => Promise<{
    readonly grantId: string;
    readonly clientId: string;
    readonly consentHash: string;
    readonly grantRevision?: number;
    readonly authorizationRestriction?: AuthorizationRestriction;
  } | null>;
  readonly accountProfile?: ReturnType<
    typeof import("./account-profile.js").createAccountProfilePortWithPersistence
  >;
  readonly currentIdentity?: ReturnType<
    typeof import("./current-identity.js").createCurrentIdentityPortWithMappings
  >;
  readonly publicEntry?: import("./public-entry.js").PublicEntryPort;
  readonly databaseCompute?: ReturnType<
    typeof import("./database-compute.js").createD1DatabaseComputePort
  >;
  readonly projectNotes?: import("./project-context.js").ProjectNotesPort;
  readonly poweredByFlag?: import("./powered-by-flag.js").PoweredByFlagPort;
  readonly projectExports?: import("./project-exports.js").ProjectExportsPort;
  readonly userApiKeys?: import("./user-api-key-management.js").UserApiKeyManagementPort;
  readonly billing?: import("./billing.js").BillingManagementPort;
  readonly credits?: import("./credits.js").CreditManagementPort;
  readonly githubSourceAuthorization?: GithubSourceAuthorizationPort;
  readonly githubOrganizationConnection?: GithubOrganizationConnectionPort;
  readonly organizationMcpConnections?: import("./organization-mcp-connections.js").OrganizationMcpConnectionsPort;
  /**
   * The user signed in to the portal in the requesting browser (`user:<id>`), read from the sealed portal cookie,
   * or null. The GitHub and Cloudflare provider callbacks complete a state only for the user who started it.
   */
  readonly portalSessionPrincipal?: (request: Request) => Promise<string | null>;
  readonly sessionRevocation?: { revoke(principal: AuthenticatedPrincipal): Promise<void> };
  readonly organizationOnboarding?: {
    create(input: {
      readonly principal: AuthenticatedPrincipal;
      readonly name: string;
      readonly signupSource: string;
      readonly idempotencyKey: string;
    }): Promise<{ readonly id: string; readonly name: string }>;
  };
  readonly authentication: BearerAuthenticator;
  readonly authorization: AuthorizationPort;
  readonly persistence: ControlApiPersistence;
  readonly productSurface: ProductSurfacePort;
  readonly providerReconciliation: ProviderReconciliationPort;
  readonly environmentSecrets: EnvironmentSecretsPort;
  readonly projectMailDomains: ProjectMailDomainsPort;
  readonly managedMail?: ManagedMailPort;
  readonly sharedMail?: import("./shared-mail.js").SharedMailPort;
  readonly sharedMailIdentity?: import("./shared-mail.js").SharedMailIdentityPort;
  readonly nativeAuthManagement?: import("./native-auth-management.js").NativeAuthManagementPort;
  readonly remoteMailDomainIds?: (
    principal: AuthenticatedPrincipal,
    organizationId: Ulid,
  ) => Promise<readonly string[]>;
  readonly cloudflareDomains?: CloudflareDomainManagementPort;
  readonly devAccessTickets: DevAccessTicketsPort;
  readonly devAccessManagement?: import("./dev-access-management.js").DevAccessManagementPort;
  readonly deploymentDiagnostics?: DeploymentDiagnosticsPort;
  readonly functionRuns?: FunctionRunsPort;
  readonly projectDatabaseDiagnostics?: ProjectDatabaseDiagnosticsPort;
  readonly projectDatabaseWrite?: ReturnType<
    typeof import("./project-database-write.js").createProjectDatabaseWritePort
  >;
  readonly projectDatabaseAccess?: ProjectDatabaseAccessPort;
  readonly projectDatabaseEvents?: ProjectDatabaseEventsPort;
  readonly clock: Clock;
  readonly ids: UlidFactory;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly applicationId: string;
  readonly rateLimits: RateLimitPort;
  readonly reporter: SafeErrorReporter;
  readonly requestId?: () => string;
}

export type RateLimitDimension =
  | "application"
  | "credential"
  | "actor"
  | "organization"
  | "project";

export interface RateLimitPort {
  consume(input: {
    readonly dimension: RateLimitDimension;
    readonly key: string;
  }): Promise<
    { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number }
  >;
}

export interface SafeErrorReporter {
  report(input: {
    readonly requestId: string;
    readonly code: string;
    readonly route: string;
  }): Promise<void> | void;
}

/** The management boundary refused the request; the routes map each code to its problem. */
export class ProjectDatabaseEventsError extends Error {
  public readonly code: ProjectDatabaseEventsRejection;

  constructor(code: ProjectDatabaseEventsRejection) {
    super("Database events request was rejected");
    this.name = "ProjectDatabaseEventsError";
    this.code = code;
  }
}

export class IdempotencyKeyReusedError extends Error {
  constructor() {
    super("Idempotency key was reused with a different canonical request");
    this.name = "IdempotencyKeyReusedError";
  }
}

export type ProductSurfaceConflictReason =
  | "deployment_plan_expired"
  | "deployment_plan_incompatible"
  | "confirmation_expired"
  | "confirmation_invalid"
  | "etag_mismatch"
  | "promotion_source_stale"
  | "promotion_target_stale"
  | "promotion_invalid_target"
  | "mail_domain_conflict"
  | "mail_domain_required"
  | "storage_jurisdiction_conflict"
  | "shared_data_requires_promotion"
  | "development_environment_exists"
  | "development_environment_missing"
  | "production_deployment_required"
  | "framework_conversion_required"
  | "source_commit_not_found"
  | "domain_hostname_taken"
  | "domain_ownership_required"
  | "domain_dns_conflict"
  | "domain_already_configured"
  | "domain_deleting"
  | "project_domains_conflict"
  | "data_change_blocked"
  | "data_change_in_progress"
  | "data_change_not_applicable"
  | "rollback_target_data_changed"
  | "native_domain_sync_pending"
  | "repository_configuration_missing"
  | "migration_filename_noncanonical"
  | "workers_runtime_incompatible"
  | "project_handle_invalid"
  | "project_handle_taken"
  | "project_handle_unchanged"
  | "project_rename_blocked"
  | "database_limit_reached"
  | "auto_deploy_source_unavailable"
  | "cutover_pending"
  | "project_operation_in_progress";

export class ProductSurfaceConflictError extends Error {
  readonly diagnostic: FrameworkConversionDiagnostic | null;
  constructor(
    readonly reason: ProductSurfaceConflictReason,
    diagnostic?: unknown,
  ) {
    super("Product surface precondition failed");
    this.name = "ProductSurfaceConflictError";
    this.diagnostic =
      reason === "framework_conversion_required"
        ? parseFrameworkConversionDiagnostic(diagnostic)
        : null;
  }
}

/**
 * SourceFetcher refused a framework version that Control's own copy of the shared policy decides
 * differently. The platform's policies disagree, so the refusal is a platform fault, not the
 * customer's: it carries nothing from the refusal.
 */
export class SourceAdmissionPolicyInconsistentError extends Error {
  constructor() {
    super("Source admission policies disagree");
    this.name = "SourceAdmissionPolicyInconsistentError";
  }
}

export class AuthenticationUnavailableError extends Error {
  constructor(options: ErrorOptions = {}) {
    super("Authentication infrastructure is unavailable", options);
    this.name = "AuthenticationUnavailableError";
  }
}
