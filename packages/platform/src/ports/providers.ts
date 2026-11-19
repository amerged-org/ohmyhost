/* v8 ignore file -- compile-time contract; exercised by TypeScript tests */

import type { DatabaseComputeProfile } from "../modules/projects/compute-profile.js";
import type { CreditMicros, Ulid } from "../shared/index.js";
import type { FrameworkPlan } from "./framework.js";

export type ProviderCapability =
  | "static-hosting"
  | "edge-runtime"
  | "build"
  | "database"
  | "domain"
  | "mail"
  | "usage";

export interface ProviderRef<C extends ProviderCapability> {
  readonly capability: C;
  readonly provider: string;
  readonly externalId: string;
}

export interface ProviderPlan<C extends ProviderCapability> {
  readonly capability: C;
  readonly actions: readonly string[];
  readonly estimatedCreditCharge: CreditMicros;
}

export interface ProviderResource<C extends ProviderCapability> extends ProviderRef<C> {
  readonly createdAt: Date;
}

export interface ObservedResource<C extends ProviderCapability> {
  readonly ref: ProviderRef<C>;
  readonly state: "pending" | "ready" | "failed" | "removed";
  readonly observedAt: Date;
}

export interface ProviderScope {
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
}

export interface ProviderMutationContext extends ProviderScope {
  readonly operationId: Ulid;
  readonly idempotencyKey: string;
}

export interface DeploymentPlanInput extends ProviderScope {
  readonly artifactDigest: string;
  readonly frameworkPlan: FrameworkPlan;
}

export interface DeploymentApplyInput<C extends ProviderCapability> {
  readonly artifactDigest: string;
  readonly context: ProviderMutationContext;
  readonly frameworkPlan: FrameworkPlan;
  readonly plan: ProviderPlan<C>;
}

export interface ProviderRemoveInput<C extends ProviderCapability> {
  readonly ref: ProviderRef<C>;
  readonly context: ProviderMutationContext;
}

export interface StaticHostingProvider {
  plan(input: DeploymentPlanInput): Promise<ProviderPlan<"static-hosting">>;
  apply(input: DeploymentApplyInput<"static-hosting">): Promise<ProviderResource<"static-hosting">>;
  observe(ref: ProviderRef<"static-hosting">): Promise<ObservedResource<"static-hosting">>;
  observeByMutation(
    context: ProviderMutationContext,
  ): Promise<ObservedResource<"static-hosting"> | null>;
  remove(input: ProviderRemoveInput<"static-hosting">): Promise<void>;
}

export interface EdgeRuntimeProvider {
  plan(input: DeploymentPlanInput): Promise<ProviderPlan<"edge-runtime">>;
  apply(input: DeploymentApplyInput<"edge-runtime">): Promise<ProviderResource<"edge-runtime">>;
  observe(ref: ProviderRef<"edge-runtime">): Promise<ObservedResource<"edge-runtime">>;
  remove(input: ProviderRemoveInput<"edge-runtime">): Promise<void>;
}

export interface BuildPlanInput extends ProviderScope {
  readonly sourceDigest: string;
  readonly buildPlanDigest: string;
}

export interface BuildStartInput {
  readonly sourceDigest: string;
  readonly buildPlanDigest: string;
  readonly plan: ProviderPlan<"build">;
  readonly acceptedPlanDigest: string;
  readonly context: ProviderMutationContext;
}

export interface BuildJob extends ProviderResource<"build"> {
  readonly state: "queued" | "running" | "succeeded" | "failed" | "stopped";
  readonly artifactDigest?: string;
}

export interface BuildProvider {
  plan(input: BuildPlanInput): Promise<ProviderPlan<"build">>;
  start(input: BuildStartInput): Promise<BuildJob>;
  read(ref: ProviderRef<"build">): Promise<BuildJob>;
  stop(input: ProviderRemoveInput<"build">): Promise<void>;
}

export interface DatabasePlanInput extends ProviderScope {
  readonly region: string;
}

export interface DatabaseApplyInput {
  readonly region: string;
  readonly plan: ProviderPlan<"database">;
  readonly context: ProviderMutationContext;
}

export interface DatabaseProvider {
  plan(input: DatabasePlanInput): Promise<ProviderPlan<"database">>;
  apply(input: DatabaseApplyInput): Promise<ProviderResource<"database">>;
  observe(ref: ProviderRef<"database">): Promise<ObservedResource<"database">>;
  remove(input: ProviderRemoveInput<"database">): Promise<void>;
}

export interface DatabaseProjectScope {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
}

export interface DatabaseProjectPlacement {
  readonly projectName: string;
  readonly regionId: string;
  readonly postgresVersion: 14 | 15 | 16 | 17 | 18;
}

export interface DatabaseProjectPlacementReceipt {
  readonly provider: string;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly providerProjectId: string;
  readonly projectName: string;
  readonly regionId: string;
  readonly postgresVersion: DatabaseProjectPlacement["postgresVersion"];
  readonly defaultBranchId: string;
  readonly operationIds: readonly string[];
  readonly state: "provisioning" | "ready" | "failed";
  readonly observedAt: Date;
}

export type DatabaseProjectPlacementObservation =
  | Readonly<{
      state: "found";
      providerProjectId: string;
      defaultBranchId: string;
      projectName: string;
      regionId: string;
      postgresVersion: DatabaseProjectPlacement["postgresVersion"];
      observedAt: Date;
    }>
  | Readonly<{ state: "absent"; projectName: string; observedAt: Date }>;

export interface DatabaseProjectPlacementProvider {
  createProject(input: {
    readonly computeProfile: DatabaseComputeProfile;
    readonly scope: DatabaseProjectScope;
    readonly placement: DatabaseProjectPlacement;
  }): Promise<DatabaseProjectPlacementReceipt>;
  observeProject(input: {
    readonly computeProfile: DatabaseComputeProfile;
    readonly scope: DatabaseProjectScope;
    readonly placement: DatabaseProjectPlacement;
  }): Promise<DatabaseProjectPlacementObservation>;
}

export interface DomainPlanInput extends ProviderScope {
  readonly hostname: string;
}

export interface DomainApplyInput {
  readonly hostname: string;
  readonly plan: ProviderPlan<"domain">;
  readonly context: ProviderMutationContext;
}

export interface DomainProvider {
  plan(input: DomainPlanInput): Promise<ProviderPlan<"domain">>;
  apply(input: DomainApplyInput): Promise<ProviderResource<"domain">>;
  observe(ref: ProviderRef<"domain">): Promise<ObservedResource<"domain">>;
  remove(input: ProviderRemoveInput<"domain">): Promise<void>;
}

export interface MailSendInput {
  readonly context: ProviderMutationContext;
  readonly from: string;
  readonly to: readonly string[];
  readonly rawMessage: Uint8Array;
}

export interface MailTenantScope {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
}

export interface MailTenantReceipt extends MailTenantScope {
  readonly provider: "aws-ses-v2";
  readonly region: string;
  readonly tenantName: string;
  readonly tenantId: string;
  readonly tenantArn: string;
  readonly sendingStatus: "enabled" | "reinstated" | "disabled";
  readonly createdAt: Date;
}

export type MailTenantObservation =
  | Readonly<MailTenantReceipt & { state: "found" }>
  | Readonly<{ state: "absent"; tenantName: string }>;

export interface MailTenantReputationReceipt extends MailTenantScope {
  readonly provider: "aws-ses-v2";
  readonly region: string;
  readonly tenantName: string;
  readonly tenantId: string;
  readonly tenantArn: string;
  readonly reputationPolicyArn: string;
  readonly awsManagedStatus: "enabled" | "reinstated" | "disabled" | "unknown";
  readonly customerManagedStatus: "enabled" | "reinstated" | "disabled" | "unknown";
  readonly aggregateSendingStatus: "enabled" | "reinstated" | "disabled";
}

export type MailTenantReputationObservation =
  | Readonly<MailTenantReputationReceipt & { state: "found" }>
  | Readonly<{ state: "absent"; tenantArn: string }>;

export interface MailTenantProvider {
  createTenant(scope: MailTenantScope): Promise<MailTenantReceipt>;
  observeTenant(scope: MailTenantScope): Promise<MailTenantObservation>;
  observeTenantReputation(tenant: MailTenantReceipt): Promise<MailTenantReputationObservation>;
}

export interface MailReceipt {
  readonly ref: ProviderRef<"mail">;
  readonly acceptedAt: Date;
}

export interface MailProvider {
  send(input: MailSendInput): Promise<MailReceipt>;
}

export interface UsageReadInput {
  readonly projectId: Ulid;
  readonly fromInclusive: Date;
  readonly toExclusive: Date;
  readonly cursor?: string;
}

export interface ProviderUsageRecord {
  readonly externalId: string;
  readonly meter: string;
  readonly unit: string;
  readonly quantity: bigint;
  readonly eventTime: Date;
}

export interface UsagePage {
  readonly records: readonly ProviderUsageRecord[];
  readonly nextCursor?: string;
}

export interface UsageSource {
  read(input: UsageReadInput): Promise<UsagePage>;
}
