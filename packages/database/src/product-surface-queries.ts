import { type Ulid, type ProductionFrameworkPlan } from "@ohmyhost/platform";

import type { TransactionClient } from "./transaction.js";

export declare function readProductProject(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
  },
): Promise<Readonly<Record<string, unknown>> | null>;

export declare function readActiveProductCommandScope(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    /** Commands act on Dev unless a caller explicitly targets Prod (D312). */
    readonly environmentName?: "dev" | "prod";
  },
): Promise<{
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly billingEpochId: Ulid;
  readonly lifecycleVersion: number;
  readonly headVersion: number;
} | null>;

export declare function readActiveSourceGrant(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly sourceConnectionId: Ulid;
  },
): Promise<{
  readonly sourceConnectionId: Ulid;
  readonly grantId: Ulid;
  readonly provider: "github" | "managed";
  readonly installationId: string | null;
  readonly externalRepositoryId: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly grantedAt: string;
  readonly revoked: false;
  readonly sourceGeneration: number;
} | null>;

export declare function readDeploymentPlan(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly planId: Ulid;
    readonly readAt: string;
  },
): Promise<{
  readonly planId: Ulid;
  readonly sourceConnectionId: Ulid;
  readonly environmentId: Ulid;
  readonly billingEpochId: Ulid;
  readonly commitSha: string;
  readonly planDigest: Buffer;
  readonly sourceDigest: Buffer;
  readonly buildPlanDigest: Buffer;
  readonly runtime: string;
  readonly applicationRoot: ProductionFrameworkPlan["applicationRoot"];
  readonly frameworkPlan: ProductionFrameworkPlan;
  readonly expiresAt: string;
  readonly sourceGeneration: number;
} | null>;

export declare function readRollbackPlanTarget(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly environmentId: Ulid;
    readonly deploymentId: Ulid;
    readonly revisionId?: Ulid;
  },
): Promise<{
  readonly deploymentId: Ulid;
  readonly environmentId: Ulid;
  readonly revisionId: Ulid;
  readonly artifactId: Ulid;
  readonly artifactDigest: Buffer;
  readonly expectedHeadVersion: number;
  readonly dataEnvironmentId: Ulid;
  readonly assignmentVersion: number;
  readonly registrationVersion: number;
  readonly dataChanged: boolean;
  readonly dataChangeInProgress: boolean;
} | null>;

export interface ProductDeploymentRead {
  readonly buildCompletedAt?: string;
  readonly mailRequired?: boolean;
  readonly deploymentId: Ulid;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
  readonly commitSha: string;
  readonly sourceDigest: Buffer;
  readonly buildPlanDigest: Buffer;
  readonly artifactDigest: Buffer | null;
  readonly status: "queued" | "running" | "succeeded" | "failed" | "reconciliation_required";
  readonly deploymentUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activeVersion: number;
  readonly kind: "deploy" | "rollback" | "promotion";
  readonly isEnvironmentHead: boolean;
  readonly environmentHeadVersion: number;
}

export declare function readProductDeployment(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly deploymentId: Ulid;
  },
): Promise<ProductDeploymentRead | null>;

export declare function readProductDeployments(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly cursor?: Ulid;
    readonly limit: number;
  },
): Promise<{
  readonly items: readonly ProductDeploymentRead[];
  readonly nextCursor: string | null;
} | null>;

export declare function readDeletePlanTarget(
  client: TransactionClient,
  input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
  },
): Promise<{
  readonly expectedProjectVersion: number;
  readonly expectedEtag: string;
  readonly managedRepositoryCount: number;
  readonly stagedSourceObjectCount: number;
} | null>;
