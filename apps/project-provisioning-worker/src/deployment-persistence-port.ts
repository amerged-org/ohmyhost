/* v8 ignore file -- typed persistence contracts have no runtime behavior */
import type { Ulid } from "@ohmyhost/platform";
import type {
  ProductWorkflowContext,
  ProductWorkflowDeletionDataEnvironment,
} from "@ohmyhost/database/provisioning-persistence";

export type DeploymentWorkflowWireContext = Omit<ProductWorkflowContext, "intent"> & {
  readonly intent: Omit<
    ProductWorkflowContext["intent"],
    "sourceArtifactDigest" | "sourceDigest" | "buildPlanDigest"
  > & {
    readonly sourceArtifactDigest: Uint8Array | null;
    readonly sourceDigest: Uint8Array | null;
    readonly buildPlanDigest: Uint8Array | null;
  };
};

/** The accepted-run mutation claim and metadata reader already qualified over the shared Core. */
export interface DeploymentPersistenceReaderPort {
  readContext(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly environmentId: string;
    readonly operationId: string;
  }): Promise<ProductWorkflowContext | null>;
  readDatabaseTarget(input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly physicalEnvironmentId: string;
  }): Promise<ProductWorkflowDeletionDataEnvironment>;
  claimProviderMutation(input: {
    readonly claimId: Ulid;
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly environmentId: Ulid;
    readonly operationId: Ulid;
    readonly eventId: Ulid;
    readonly logicalWorkflowId: string;
    readonly eventType:
      | "DeploymentRequestedV1"
      | "DeploymentRollbackRequestedV1"
      | "DeploymentPromotionRequestedV1"
      | "ProjectHandleChangeRequestedV1"
      | "ProjectDataChangeRequestedV1";
    readonly acceptedLifecycleVersion: number;
  }): Promise<"created" | "existing">;
}
export interface DeploymentWorkflowRuntimeBinding {
  readProductWorkflowContext(
    input: Parameters<DeploymentPersistenceReaderPort["readContext"]>[0],
  ): Promise<DeploymentWorkflowWireContext | null>;
  readProductWorkflowDatabaseTarget(
    input: Parameters<DeploymentPersistenceReaderPort["readDatabaseTarget"]>[0],
  ): ReturnType<DeploymentPersistenceReaderPort["readDatabaseTarget"]>;
  claimProductProviderMutation(
    input: Parameters<DeploymentPersistenceReaderPort["claimProviderMutation"]>[0],
  ): ReturnType<DeploymentPersistenceReaderPort["claimProviderMutation"]>;
}
