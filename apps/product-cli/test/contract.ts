export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DeviceAuthorizationRequest {
  readonly clientId: string;
  readonly scope: string;
  readonly clientSecret?: never;
}

export interface TokenPollRequest {
  readonly clientId: string;
  readonly deviceCode: string;
  readonly grantType: "urn:ietf:params:oauth:grant-type:device_code";
  readonly clientSecret?: never;
}

export interface ApiCall {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly transport: "generated-sdk";
}

export interface ProductCliSnapshot {
  readonly diagnostics: readonly {
    readonly correlationId: string;
    readonly category: string;
    readonly subsystem: string;
    readonly errorKind: string;
  }[];
  readonly lifecycleEvents: readonly ("authorization-presented" | "token-polled")[];
  readonly presentedAuthorizations: readonly {
    readonly verificationUri: string;
    readonly verificationUriComplete?: string;
    readonly userCode: string;
  }[];
  readonly deviceAuthorizationRequests: readonly DeviceAuthorizationRequest[];
  readonly tokenPollRequests: readonly TokenPollRequest[];
  readonly revokeRequests: readonly { readonly token: string; readonly clientSecret?: never }[];
  readonly refreshRequests: readonly {
    readonly token: string;
    readonly workosOrganizationId?: string;
    readonly clientSecret?: never;
  }[];
  readonly credentialReplaceCount: number;
  readonly apiCalls: readonly ApiCall[];
  readonly storedCredential?: StoredTestCredential;
  /** The saved logins after the run: alias, user and organization, never a credential. */
  readonly profiles?: readonly {
    readonly name: string;
    readonly userId: string;
    readonly organizationId: string | null;
    readonly organizationName: string | null;
  }[];
}

export interface StoredTestCredential {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt?: string;
  readonly workosOrganizationId?: string;
  readonly organizationId?: string;
}

/** One workspace of the signed-in user, exactly as `GET /v1/me/profile` reports it. */
export interface TestWorkspace {
  readonly id: string;
  readonly workos_id: string;
  readonly name: string;
}

export type DeviceTokenOutcome =
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  | "invalid_grant"
  | {
      readonly accessToken: string;
      readonly refreshToken: string;
    };

export interface ProductCliHarnessOptions {
  readonly deviceTokenOutcomes?: readonly DeviceTokenOutcome[];
  /** The alias a login gives the login it saves. */
  readonly profileName?: string;
  readonly deviceTokenExpiresInSeconds?: number | null;
  readonly storedCredential?: StoredTestCredential;
  readonly organizations?: readonly TestWorkspace[];
  /** What the access token carries; an empty list is a session signed in before any selection. */
  readonly identityOrganizationIds?: readonly string[];
  readonly profileError?: boolean;
  readonly revokeError?: Error;
  readonly revokeNeverSettles?: boolean;
  readonly lifecycleTimeoutMs?: number;
  readonly refreshError?: Error;
  readonly refreshedCredential?: {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly expiresAt: string;
  };
  readonly apiError?: {
    readonly code: string;
    readonly retryable: boolean;
    readonly suggested_action: string;
    readonly detail: string;
  };
  readonly invalidOperation?: boolean;
  readonly failedOperation?: boolean;
  readonly apiNetworkError?: boolean;
  readonly apiProgrammingError?: boolean;
  readonly apiSpoofedErrorName?: string;
}

export interface ProductCliTestHarness {
  run(argv: readonly string[], signal?: AbortSignal): Promise<CliResult>;
  snapshot(): Promise<ProductCliSnapshot>;
}

export type CreateProductCliTestHarness = (
  options?: ProductCliHarnessOptions,
) => Promise<ProductCliTestHarness>;
