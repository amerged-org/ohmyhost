import type {
  AuthenticatedPrincipal,
  ProductSurfaceMutationContext,
  ProductSurfaceResult,
} from "./contracts.js";

export interface GithubOrganizationBinding {
  beginOrganizationAuthorization(input: unknown): Promise<unknown>;
  completeOrganizationAuthorization(input: unknown): Promise<unknown>;
  observeOrganizationInstallation(input: unknown): Promise<unknown>;
  validateOrganizationRepository(input: unknown): Promise<unknown>;
}

type GithubConnectionFailure =
  | "installation_access_required"
  | "account_admin_required"
  | "authorization_code_rejected"
  | "provider_unavailable"
  | "expired"
  | "session_inactive"
  | "denied"
  | "code_spent";
export class GithubConnectionRequiredError extends Error {
  constructor(
    public readonly code:
      | "github_connection_required"
      | "github_connection_revoked"
      | "repository_not_installed",
    public readonly settingsUrl?: string,
  ) {
    super("GitHub connection needs customer action");
  }
}

export class GithubConnectionStateUnknownError extends Error {}

interface GithubConnectionView {
  connection_id: string;
  organization_id: string;
  installation_id: string;
  account_id: string;
  account_login: string;
  account_type: "User" | "Organization";
  github_user_id: string;
  github_user_login: string;
  connected_at: string;
  revoked_at: string | null;
  settings_url: string;
}

interface GithubConnectionAuthorizationView {
  authorization_id: string;
  status: "pending" | "authorizing" | "failed" | "expired" | "connected";
  last_failure: GithubConnectionFailure | null;
  authorization_url: string | null;
  expires_at: string;
  connection: GithubConnectionView | null;
}

export interface GithubOrganizationConnectionPort {
  status: (
    organizationId: string,
  ) => Promise<
    | { status: "not_connected"; connection: null }
    | { status: "revoked"; connection: GithubConnectionView }
    | { status: "connected"; connection: GithubConnectionView }
  >;
  begin(request: {
    organizationId: string;
    principal: AuthenticatedPrincipal;
    idempotencyKey: string;
  }): Promise<
    | GithubConnectionAuthorizationView
    | {
        authorization_id: null;
        status: "connected";
        last_failure: null;
        authorization_url: null;
        expires_at: null;
        connection: GithubConnectionView;
      }
  >;
  /**
   * Continues or completes only for `signedInPrincipalId`, the portal user in this browser, when it started the
   * attempt. Any other user, like an unknown state, gets `GithubConnectionStateUnknownError` and consumes nothing.
   */
  callback(request: {
    state: string;
    signedInPrincipalId: string;
    code?: string;
    installationId?: string;
    setupAction?: "install" | "update" | "request";
    denied?: boolean;
  }): Promise<
    | { view: GithubConnectionAuthorizationView; redirect: null }
    | { view: GithubConnectionAuthorizationView; redirect: string }
    | null
  >;
  /** Owner disconnect: revokes the workspace connection and every GitHub repository grant under it. */
  disconnect(request: {
    organizationId: string;
    principal: AuthenticatedPrincipal;
  }): Promise<
    | { status: "not_connected"; connection: null }
    | { status: "revoked"; connection: GithubConnectionView }
  >;
  link(
    request: ProductSurfaceMutationContext & { repositoryOwner: string; repositoryName: string },
  ): Promise<ProductSurfaceResult>;
}
