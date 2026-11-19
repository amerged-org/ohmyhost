export class ManagedSourceReservationError extends Error {
  constructor(
    readonly kind: "scope" | "state" | "expired" | "identity" | "limit" | "generation" | "commit",
  ) {
    super(`Managed source reservation ${kind} conflict`);
    this.name = "ManagedSourceReservationError";
  }
}
