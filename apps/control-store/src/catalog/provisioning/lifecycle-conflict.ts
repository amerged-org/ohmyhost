/** Same private native error contract; no framework or transport dependency. */
export class LifecycleInventoryConflictError extends Error {
  readonly code = "deployment_persistence_conflict";
  constructor(message: string) {
    super(message);
    this.name = "DeploymentPersistenceConflictError";
  }
}
