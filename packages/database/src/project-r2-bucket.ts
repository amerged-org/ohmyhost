export interface ProjectR2BucketScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly operationId: string;
  readonly claimId: string;
}

export interface ProjectR2BucketInput extends ProjectR2BucketScope {
  readonly bucketName: string;
  readonly jurisdiction: "eu" | "us";
  readonly storageClass: "Standard";
  readonly publicAccess: false;
}

export interface ProjectR2BucketReceipt extends ProjectR2BucketInput {
  readonly bucketId: string;
  readonly observedAt: Date;
}

export type ProjectR2BucketClaimResult =
  | Readonly<{ status: "claimed"; mode: "create" | "observe" }>
  | Readonly<{ status: "completed"; receipt: ProjectR2BucketReceipt }>;

export class ProjectR2BucketConflictError extends Error {
  public readonly code = "project_r2_bucket_conflict";
  public constructor() {
    super("Project R2 bucket conflicts with durable state");
    this.name = "ProjectR2BucketConflictError";
  }
}
