export class ProjectNotesConflict extends Error {
  constructor(readonly kind: "scope" | "version" | "idempotency") {
    super(`Project notes ${kind} conflict`);
  }
}
