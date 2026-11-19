export class InvalidWorkosTokenError extends Error {
  public constructor(public readonly code: string) {
    super("WorkOS token is invalid");
    this.name = "InvalidWorkosTokenError";
  }
}

export class InvalidWorkosJwksError extends Error {
  public constructor(public readonly code: string) {
    super("WorkOS JWKS is invalid");
    this.name = "InvalidWorkosJwksError";
  }
}

export class WorkosTokenVerifierConfigurationError extends Error {
  public constructor(public readonly code: string) {
    super("WorkOS token verifier configuration is invalid");
    this.name = "WorkosTokenVerifierConfigurationError";
  }
}
