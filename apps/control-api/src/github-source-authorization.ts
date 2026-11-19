import type { ProductSurfaceMutationContext } from "./contracts.js";
import type {
  WorkosSessionStatusRequest,
  WorkosUserApiKeyMetadata,
} from "@ohmyhost/workos-auth-contracts";

export interface GithubAuthorizationBinding {
  beginRepositoryAuthorization(input: unknown): Promise<unknown>;
  completeRepositoryAuthorization(input: unknown): Promise<unknown>;
}

export interface GithubAuthorizationView {
  authorization_id: string;
  status: "pending" | "authorizing" | "authorized" | "failed" | "expired";
  /** Why the last callback did not finish, so the next message names the one thing to do. */
  last_failure:
    | "repository_not_installed"
    | "repository_access_required"
    | "authorization_code_rejected"
    | "provider_unavailable"
    | GithubTerminalReason
    | null;
  authorization_url: string | null;
  installation_url: string | null;
  expires_at: string;
  operation_id: string | null;
  installation_id: string | null;
  repository_id: string | null;
  repository_owner: string;
  repository_name: string;
}

export type GithubTerminalReason = "expired" | "session_inactive" | "denied" | "code_spent";

export class GithubAuthorizationRejectedError extends Error {
  /** Why this authorization ended for good, so the customer reads a cause instead of a shrug. */
  public constructor(public readonly reason: GithubTerminalReason = "code_spent") {
    super("GitHub authorization is no longer valid");
  }
}

export class GithubRepositoryAccessRequiredError extends Error {}

export class GithubRepositoryNotInstalledError extends Error {}

export class GithubAuthorizationCodeRejectedError extends Error {}

export interface GithubSourceAuthorizationPort {
  begin(
    request: ProductSurfaceMutationContext & {
      repositoryOwner: string;
      repositoryName: string;
      session?: WorkosSessionStatusRequest;
      userApiKey?: WorkosUserApiKeyMetadata;
    },
  ): Promise<GithubAuthorizationView>;
  /** Completes only for `signedInPrincipalId`, the portal user in this browser, when it started the authorization. */
  callback(request: {
    state: string;
    signedInPrincipalId: string;
    code?: string;
    denied?: boolean;
  }): Promise<GithubAuthorizationView>;
}
