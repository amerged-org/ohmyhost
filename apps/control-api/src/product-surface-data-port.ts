import type * as Native from "@ohmyhost/database";
import type {
  ProductSurfaceContext,
  ProductSurfaceMutationContext,
  ProductSurfaceResult,
} from "./contracts.js";
import type { Ulid } from "@ohmyhost/platform";
import type { ProjectHandle } from "@ohmyhost/project-handles";
type TransactionMethod<K extends keyof typeof Native> = (typeof Native)[K] extends (
  client: never,
  input: infer I,
) => infer R
  ? (produce: () => I) => R
  : never;
/** Closed domain operations. A producer builds one command's input when the command is sent. */
export interface ProductSurfaceDataPort {
  readonly readProductProject: TransactionMethod<"readProductProject">;
  readonly configureGithubAutoDeployIdempotently: TransactionMethod<"configureGithubAutoDeployIdempotently">;
  readonly readGithubAutoDeployConfig: TransactionMethod<"readGithubAutoDeployConfig">;
  readonly createDeploymentPlan: TransactionMethod<"createDeploymentPlan">;
  readonly readDeploymentPlan: TransactionMethod<"readDeploymentPlan">;
  readonly readProductDeployments: TransactionMethod<"readProductDeployments">;
  readonly readProductDeployment: TransactionMethod<"readProductDeployment">;
  readonly readPromotionPlanTarget: TransactionMethod<"readPromotionPlanTarget">;
  readonly readDeletePlanTarget: TransactionMethod<"readDeletePlanTarget">;
  readonly readProjectRenameAdmission: TransactionMethod<"readProjectRenameAdmission">;
  readonly readProjectDeletionAdmission: TransactionMethod<"readProjectDeletionAdmission">;
  readonly issueActionConfirmation: TransactionMethod<"issueActionConfirmation">;
  readonly readProjectStatus: (scope: ProductSurfaceContext) => Promise<ProductStatusFacts | null>;
  readonly readScope: (
    scope: Pick<ProductSurfaceContext, "organizationId" | "projectId">,
  ) => ReturnType<typeof Native.readActiveProductCommandScope>;
  readonly readPlanningSource: (
    scope: Pick<ProductSurfaceContext, "organizationId" | "projectId"> & {
      readonly sourceConnectionId?: Ulid;
      readonly environmentName?: "dev" | "prod";
    },
  ) => Promise<ProductPlanningSource | null>;
  readonly readRollbackTargetForDeployment: (
    input: Parameters<typeof Native.readProductDeployment>[1],
  ) => ReturnType<typeof Native.readRollbackPlanTarget>;
  readonly requireUsableConfirmation: (input: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly principalId: string;
    readonly action: "delete" | "rollback" | "promote";
    readonly targetDeploymentId?: Ulid;
    readonly subjectEtag: string;
    readonly tokenDigest: Uint8Array;
    readonly now: string;
  }) => Promise<void>;
  readonly readPromotionEnvironments: (scope: {
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
  }) => Promise<Readonly<{
    readonly sourceEnvironmentId: Ulid;
    readonly targetEnvironmentId: Ulid;
  }> | null>;
  readonly replayAcceptedOperation: (
    request: ProductSurfaceMutationContext,
    method: "POST" | "PUT" | "DELETE",
    route: string,
  ) => Promise<ProductSurfaceResult | null>;
  readonly acceptProductOperation: (
    produce: () => Parameters<typeof Native.acceptProductApiOperation>[1],
    eventType: Parameters<typeof Native.acceptProductApiOperation>[1]["eventType"],
  ) => Promise<{
    readonly operationId: string;
    readonly state: Native.StoredOperation["state"];
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly failure?: { readonly code: string } | null;
    readonly failureDiagnostic?: unknown;
  }>;
}

/** The project, source and environment facts one deployment plan is built from. */
interface ProductPlanningSource {
  projectHandle: ProjectHandle;
  region: "us" | "eu";
  storageJurisdiction: "us" | "eu";
  environmentName: "dev" | "prod";
  publicOrigin: string;
  dataMode: string;
  sourceConnectionId: Ulid;
  grantId: Ulid;
  provider: "github" | "managed";
  installationId: string | null;
  externalRepositoryId: string;
  repositoryOwner: string;
  repositoryName: string;
  grantedAt: string;
  revoked: false;
  sourceGeneration: number;
  organizationId: Ulid;
  projectId: Ulid;
  environmentId: Ulid;
  billingEpochId: Ulid;
  lifecycleVersion: number;
  headVersion: number;
}

export interface ProductStatusFacts {
  readonly customDomains?: readonly {
    readonly hostname: string;
    readonly environment: "prod";
    readonly state: "awaiting_deployment" | "pending" | "active" | "deleting";
  }[];
  readonly projection: Readonly<Record<string, unknown>>;
  readonly headDeployment: Native.ProductDeploymentRead | null;
  readonly latestOperation:
    | {
        readonly operation_id: string;
        readonly state: string;
        readonly created_at: string;
        readonly updated_at: string;
        readonly failure_code: string | null;
        readonly failure_diagnostic: unknown;
        readonly blockingOperationId: string | null;
        readonly reconciliation: Awaited<
          ReturnType<typeof Native.readProductOperationReconciliation>
        >;
      }
    | undefined;
  readonly cleanupState: string | undefined;
}
