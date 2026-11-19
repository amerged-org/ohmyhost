export interface PoweredByFlagState {
  readonly enabled: boolean;
  readonly enabledAt: string | null;
}

/** A Free organization's custom domain is served only while this project shows the flag. */
export class PoweredByFlagRequiredError extends Error {
  public constructor() {
    super("A custom domain of a Free organization depends on the powered-by flag");
    this.name = "PoweredByFlagRequiredError";
  }
}

/** The principal already used this key on this project for a different flag request. */
export class PoweredByFlagIdempotencyConflictError extends Error {
  public constructor() {
    super("The idempotency key was used for a different powered-by flag request");
    this.name = "PoweredByFlagIdempotencyConflictError";
  }
}
