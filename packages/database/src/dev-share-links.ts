export type DevAccessMode = "protected" | "public";

export class DevShareRotationConflictError extends Error {
  public constructor() {
    super("Dev share rotation key was already used for another link generation");
    this.name = "DevShareRotationConflictError";
  }
}
