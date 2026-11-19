import { createHash, randomBytes } from "node:crypto";
import { parseUlid, type Clock, type UlidFactory } from "@ohmyhost/platform";
import {
  parseWorkosUserApiKeyResponse,
  type WorkosSessionStatusRequest,
  type WorkosUserApiKeyMetadata,
} from "@ohmyhost/workos-auth-contracts";

import {
  IdempotencyKeyReusedError,
  type AuthenticatedPrincipal,
  type ProductSurfaceMutationContext,
} from "./contracts.js";
import {
  createD1ProductSurfaceDataPort,
  type D1ProductSurfaceRuntime,
} from "./d1-product-surface.js";
import type { createEnvironmentSecretCipherKeyring } from "./environment-secret-cipher.js";
import {
  GithubConnectionRequiredError,
  GithubConnectionStateUnknownError,
  type GithubOrganizationBinding,
} from "./github-organization-connection.js";
import {
  GithubAuthorizationCodeRejectedError,
  GithubAuthorizationRejectedError,
  GithubRepositoryAccessRequiredError,
  GithubRepositoryNotInstalledError,
  type GithubAuthorizationBinding,
  type GithubAuthorizationView,
  type GithubTerminalReason,
} from "./github-source-authorization.js";
import { productOperationView } from "./d1-product-operation.js";
import { operationResult } from "./product-operation-result.js";
import type { WorkosSessionStatusPort } from "./workos-session-status.js";
import type { WorkosUserApiKeyStatusPort } from "./workos-user-api-keys.js";

type Row = Record<string, unknown>;
/** The Core's GitHub state commands: plain reads and compare-and-set transitions, no SQL and no provider authority. */
export interface D1GithubRuntime {
  readGithubSourceAuthorization(input: unknown): Promise<Row | null>;
  readGithubSourceAuthorizationByState(input: unknown): Promise<Row | null>;
  readGithubSourceAuthorizationById(input: unknown): Promise<Row | null>;
  insertGithubSourceAuthorization(input: unknown): Promise<boolean>;
  claimGithubSourceAuthorization(input: unknown): Promise<Row | null>;
  releaseGithubSourceAuthorization(input: unknown): Promise<unknown>;
  completeGithubSourceAuthorization(input: unknown): Promise<Row | null>;
  readGithubOrganizationMapping(input: unknown): Promise<{ workosOrganizationId: string } | null>;
  readGithubConnection(input: unknown): Promise<Row | null>;
  readGithubConnectionById(input: unknown): Promise<Row | null>;
  hasActiveGithubConnection(input: unknown): Promise<boolean>;
  readGithubInstallationHints(input: unknown): Promise<string[]>;
  revokeGithubConnection(input: unknown): Promise<Row | null>;
  readGithubConnectionAuthorization(input: unknown): Promise<Row | null>;
  readGithubConnectionAuthorizationByState(input: unknown): Promise<Row | null>;
  readGithubConnectionAuthorizationById(input: unknown): Promise<Row | null>;
  insertGithubConnectionAuthorization(input: unknown): Promise<boolean>;
  failGithubConnectionAuthorization(input: unknown): Promise<Row | null>;
  advanceGithubConnectionToOauth(input: unknown): Promise<Row | null>;
  claimGithubConnectionAuthorization(input: unknown): Promise<boolean>;
  renewGithubConnectionProviderUse(input: unknown): Promise<boolean>;
  releaseGithubConnectionProviderUse(input: unknown): Promise<boolean>;
  completeGithubConnection(input: unknown): Promise<{ outcome: string; row?: Row }>;
  readGithubRepositoryLinkConsent(input: unknown): Promise<{
    operationId: string;
    requestSha256: string;
  } | null>;
  insertGithubRepositoryLinkConsent(input: unknown): Promise<boolean>;
}
export const D1_GITHUB_METHODS = [
  "readGithubSourceAuthorization",
  "readGithubSourceAuthorizationByState",
  "readGithubSourceAuthorizationById",
  "insertGithubSourceAuthorization",
  "claimGithubSourceAuthorization",
  "releaseGithubSourceAuthorization",
  "completeGithubSourceAuthorization",
  "readGithubOrganizationMapping",
  "readGithubConnection",
  "readGithubConnectionById",
  "hasActiveGithubConnection",
  "readGithubInstallationHints",
  "revokeGithubConnection",
  "readGithubConnectionAuthorization",
  "readGithubConnectionAuthorizationByState",
  "readGithubConnectionAuthorizationById",
  "insertGithubConnectionAuthorization",
  "failGithubConnectionAuthorization",
  "advanceGithubConnectionToOauth",
  "claimGithubConnectionAuthorization",
  "renewGithubConnectionProviderUse",
  "releaseGithubConnectionProviderUse",
  "completeGithubConnection",
  "readGithubRepositoryLinkConsent",
  "insertGithubRepositoryLinkConsent",
] as const;
export function isD1GithubRuntime(value: unknown): value is D1GithubRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    D1_GITHUB_METHODS.every((method) => typeof Reflect.get(value, method) === "function")
  );
}
/** The slices of other Core capabilities these flows compose; each is the unchanged original decision. */
export interface D1GithubDependencies {
  readonly runtime: D1GithubRuntime;
  readonly product: D1ProductSurfaceRuntime & {
    readApiProductOperation(input: unknown): Promise<unknown>;
  };
  readonly control: { authorizeOrganizationAction(input: unknown): Promise<"allow" | "deny"> };
  readonly callbackUri: string;
  readonly clock: Clock;
  readonly ids: UlidFactory;
  readonly cipher: ReturnType<typeof createEnvironmentSecretCipherKeyring>;
  readonly sessionStatus: WorkosSessionStatusPort;
  readonly apiKeyStatus?: WorkosUserApiKeyStatusPort;
}

const digest = (value: string) => createHash("sha256").update(value).digest();
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const bytes = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const instantOf = (stored: unknown) => new Date(`${String(stored).slice(0, 23)}Z`);
const text = (row: Row, column: string) => String(row[column]);
const nullable = (row: Row, column: string) => (row[column] === null ? null : String(row[column]));
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid private GitHub response");
  return value as Record<string, unknown>;
};
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const login = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(value);
const principalPattern = /^user:user_[A-Za-z0-9_]+$/u;
const AUTHORIZATION_WINDOW_MS = 30 * 60 * 1000;

interface Credential {
  readonly sessionId: string | null;
  readonly userApiKeyId: string | null;
  readonly tokenExpiresAt: number | null;
}
/** The one credential a flow runs under: a browser session, or a user API key allowed to link sources. */
async function credentialOf(
  request: { session?: WorkosSessionStatusRequest; userApiKey?: WorkosUserApiKeyMetadata },
  principalId: string,
): Promise<Credential & { userId: string; organizationId: string }> {
  const session = request.session,
    key =
      request.userApiKey === undefined
        ? null
        : parseWorkosUserApiKeyResponse({ key: request.userApiKey }).key;
  if ((session === undefined) === (key === null)) throw new GithubAuthorizationRejectedError();
  const userId = session?.userId ?? key?.userId,
    organizationId = session?.organizationId ?? key?.organizationId;
  if (
    userId === undefined ||
    organizationId === undefined ||
    principalId !== `user:${userId}` ||
    (key !== null && !key.permissions.includes("sources:link"))
  )
    throw new GithubAuthorizationRejectedError();
  return {
    sessionId: session?.sessionId ?? null,
    userApiKeyId: key?.id ?? null,
    tokenExpiresAt:
      session?.tokenExpiresAt ??
      (key?.expiresAt === null || key === null
        ? null
        : Math.floor(Date.parse(key.expiresAt ?? "") / 1000)),
    userId,
    organizationId,
  };
}

/** Whether the credential that opened a browser flow is still alive; only the session decides a session flow. */
function credentialActive(dependencies: D1GithubDependencies) {
  return async (row: Row): Promise<boolean> => {
    const sessionId = nullable(row, "session_id"),
      keyId = nullable(row, "user_api_key_id"),
      principalId = text(row, "principal_id"),
      organizationId = text(row, "workos_organization_id");
    if (sessionId !== null && keyId === null && row["token_expires_at"] !== null)
      return dependencies.sessionStatus.isActive({
        sessionId,
        userId: principalId.slice(5),
        organizationId,
        tokenExpiresAt: Number(row["token_expires_at"]),
      });
    if (sessionId !== null || keyId === null || !dependencies.apiKeyStatus) return false;
    const key = await dependencies.apiKeyStatus.observe({
      keyId,
      userId: principalId.slice(5),
      organizationId,
    });
    return (
      key !== null &&
      key.id === keyId &&
      key.userId === principalId.slice(5) &&
      key.organizationId === organizationId &&
      key.permissions.includes("sources:link") &&
      (key.expiresAt === null || Date.parse(key.expiresAt) > dependencies.clock.now().getTime())
    );
  };
}

function sealedOf(row: Row) {
  return {
    ciphertext: bytes(text(row, "ciphertext")),
    nonce: bytes(text(row, "nonce")),
    valueSha256: bytes(text(row, "value_sha256")),
    keyVersion: Number(row["key_version"]),
  };
}
const wireOfSealed = (encrypted: {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  valueSha256: Uint8Array;
  keyVersion: number;
}) => ({
  ciphertext: hex(encrypted.ciphertext),
  nonce: hex(encrypted.nonce),
  valueSha256: hex(encrypted.valueSha256),
  keyVersion: encrypted.keyVersion,
});

const TERMINAL_REASONS = new Set<string>(["expired", "session_inactive", "denied", "code_spent"]);
type SourceFailure =
  | "repository_not_installed"
  | "repository_access_required"
  | "authorization_code_rejected"
  | "provider_unavailable"
  | GithubTerminalReason;
const failureOf = (error: unknown): SourceFailure =>
  error instanceof GithubRepositoryNotInstalledError
    ? "repository_not_installed"
    : error instanceof GithubRepositoryAccessRequiredError
      ? "repository_access_required"
      : error instanceof GithubAuthorizationCodeRejectedError
        ? "authorization_code_rejected"
        : error instanceof GithubAuthorizationRejectedError
          ? error.reason
          : "provider_unavailable";

/** The project-scoped source authorization of the original, with its state kept in the Core. */
export function createD1GithubSourceAuthorization(
  dependencies: D1GithubDependencies & { readonly source: GithubAuthorizationBinding },
) {
  const { runtime, clock, ids, cipher } = dependencies,
    active = credentialActive(dependencies),
    data = createD1ProductSurfaceDataPort(dependencies.product);
  const identity = (row: Row) => ({
    organizationId: text(row, "organization_id"),
    projectId: text(row, "project_id"),
    environmentId: text(row, "environment_id"),
    name: `GITHUB_PKCE_${text(row, "authorization_id")}`,
  });
  const plaintext = async (row: Row) => {
    const value = object(JSON.parse(await cipher.decrypt({ ...identity(row), ...sealedOf(row) })));
    if (
      typeof value["state"] !== "string" ||
      typeof value["verifier"] !== "string" ||
      hex(digest(value["state"])) !== text(row, "state_sha256")
    )
      throw new Error("Invalid persisted GitHub authorization");
    return { state: value["state"], verifier: value["verifier"] };
  };
  const authorized = async (organizationId: string, projectId: string, principalId: string) => {
    if (
      !principalPattern.test(principalId) ||
      (await dependencies.control.authorizeOrganizationAction({
        organizationId,
        projectId,
        principalId,
        action: "sources:link",
      })) !== "allow"
    )
      throw new GithubAuthorizationRejectedError();
  };
  const view = async (row: Row): Promise<GithubAuthorizationView> => {
    const expiresAt = instantOf(row["expires_at"]),
      state = text(row, "state"),
      status = state !== "authorized" && expiresAt <= clock.now() ? "expired" : state;
    let authorizationUrl: string | null = null;
    let installationUrl: string | null = null;
    if (status === "pending") {
      const value = await plaintext(row);
      const response = object(
        await dependencies.source.beginRepositoryAuthorization({
          state: value.state,
          codeChallenge: digest(value.verifier).toString("base64url"),
        }),
      );
      const url = new URL(String(response["authorizationUrl"]));
      const install = new URL(String(response["installationUrl"]));
      if (
        url.origin !== "https://github.com" ||
        url.pathname !== "/login/oauth/authorize" ||
        url.searchParams.get("state") !== value.state ||
        url.searchParams.get("code_challenge") !== digest(value.verifier).toString("base64url") ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        url.searchParams.get("prompt") !== "select_account" ||
        url.searchParams.get("redirect_uri") !== dependencies.callbackUri ||
        [...url.searchParams.keys()].sort().join(",") !==
          "client_id,code_challenge,code_challenge_method,prompt,redirect_uri,state" ||
        install.origin !== "https://github.com" ||
        !/^\/apps\/[a-z0-9-]+\/installations\/new$/u.test(install.pathname) ||
        url.username ||
        url.password ||
        install.username ||
        install.password
      )
        throw new Error("Unexpected GitHub authorization URL");
      authorizationUrl = url.href;
      installationUrl = install.href;
    }
    return {
      authorization_id: text(row, "authorization_id"),
      status: status as GithubAuthorizationView["status"],
      last_failure: nullable(row, "last_failure") as GithubAuthorizationView["last_failure"],
      authorization_url: authorizationUrl,
      installation_url: installationUrl,
      expires_at: expiresAt.toISOString(),
      operation_id: nullable(row, "operation_id"),
      installation_id: nullable(row, "installation_id"),
      repository_id: nullable(row, "repository_id"),
      repository_owner: text(row, "repository_owner"),
      repository_name: text(row, "repository_name"),
    };
  };
  const sameRequest = (row: Row, request: ProductSurfaceMutationContext, credential: Credential) =>
    text(row, "request_sha256") === hex(request.canonicalRequestDigest) &&
    nullable(row, "session_id") === credential.sessionId &&
    nullable(row, "user_api_key_id") === credential.userApiKeyId;
  return {
    async begin(
      request: ProductSurfaceMutationContext & {
        repositoryOwner: string;
        repositoryName: string;
        session?: WorkosSessionStatusRequest;
        userApiKey?: WorkosUserApiKeyMetadata;
      },
    ): Promise<GithubAuthorizationView> {
      const credential = await credentialOf(request, request.principalId);
      if (
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(request.repositoryOwner) ||
        !/^[A-Za-z0-9_.-]{1,100}$/u.test(request.repositoryName)
      )
        throw new GithubAuthorizationRejectedError();
      await authorized(request.organizationId, request.projectId, request.principalId);
      const scope = await data.readScope({
        organizationId: request.organizationId,
        projectId: request.projectId,
      });
      const mapping = await runtime.readGithubOrganizationMapping({
        organizationId: request.organizationId,
      });
      if (!scope || !mapping || mapping.workosOrganizationId !== credential.organizationId)
        throw new GithubAuthorizationRejectedError();
      const key = {
        organizationId: request.organizationId,
        projectId: request.projectId,
        principalId: request.principalId,
        idempotencyKey: request.idempotencyKey,
      };
      const settle = (row: Row | null) => {
        if (row === null || !sameRequest(row, request, credential))
          throw new IdempotencyKeyReusedError();
        return view(row);
      };
      const prior = await runtime.readGithubSourceAuthorization(key);
      if (prior !== null) return settle(prior);
      const id = ids.next(),
        state = `${id}_${randomBytes(32).toString("base64url")}`,
        verifier = randomBytes(32).toString("base64url"),
        now = clock.now(),
        encrypted = await cipher.encrypt({
          ...identity({
            authorization_id: id,
            organization_id: request.organizationId,
            project_id: request.projectId,
            environment_id: scope.environmentId,
          }),
          value: JSON.stringify({ state, verifier }),
        });
      await runtime.insertGithubSourceAuthorization({
        ...key,
        authorizationId: id,
        environmentId: scope.environmentId,
        billingEpochId: scope.billingEpochId,
        sessionId: credential.sessionId,
        userApiKeyId: credential.userApiKeyId,
        workosOrganizationId: mapping.workosOrganizationId,
        tokenExpiresAt: credential.tokenExpiresAt,
        repositoryOwner: request.repositoryOwner,
        repositoryName: request.repositoryName,
        requestSha256: hex(request.canonicalRequestDigest),
        stateSha256: hex(digest(state)),
        ...wireOfSealed(encrypted),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + AUTHORIZATION_WINDOW_MS).toISOString(),
      });
      return settle(await runtime.readGithubSourceAuthorization(key));
    },
    async callback(request: {
      state: string;
      signedInPrincipalId: string;
      code?: string;
      denied?: boolean;
    }): Promise<GithubAuthorizationView> {
      if (
        !/^[0-7][0-9A-HJKMNP-TV-Z]{25}_[A-Za-z0-9_-]{43}$/u.test(request.state) ||
        (!request.denied && (!request.code || request.code.length > 4096))
      )
        throw new GithubAuthorizationRejectedError();
      const row = await runtime.readGithubSourceAuthorizationByState({
        stateSha256: hex(digest(request.state)),
      });
      // Another user's browser learns nothing and claims nothing: it is answered as for an unknown state.
      if (!row || text(row, "principal_id") !== request.signedInPrincipalId)
        throw new GithubConnectionStateUnknownError();
      if (text(row, "state") !== "authorized" && instantOf(row["expires_at"]) <= clock.now())
        throw new GithubAuthorizationRejectedError("expired");
      if (!(await active(row))) throw new GithubAuthorizationRejectedError("session_inactive");
      await authorized(
        text(row, "organization_id"),
        text(row, "project_id"),
        text(row, "principal_id"),
      );
      if (text(row, "state") !== "pending") return view(row);
      // A denial is a decision, not a fault, and the customer reads that rather than a stale-link sentence.
      const claimed = await runtime.claimGithubSourceAuthorization({
        authorizationId: text(row, "authorization_id"),
        denied: request.denied === true,
        now: clock.now().toISOString(),
      });
      if (claimed === null || request.denied) {
        const current = await runtime.readGithubSourceAuthorizationById({
          authorizationId: text(row, "authorization_id"),
        });
        if (!current) throw new GithubAuthorizationRejectedError();
        return view(current);
      }
      try {
        const value = await plaintext(row);
        const proof = object(
          await dependencies.source.completeRepositoryAuthorization({
            code: request.code,
            codeVerifier: value.verifier,
            owner: text(row, "repository_owner"),
            repository: text(row, "repository_name"),
          }),
        );
        if (Object.keys(proof).join(",") === "status") {
          if (proof["status"] === "repository_access_required")
            throw new GithubRepositoryAccessRequiredError("GitHub repository access is required");
          if (proof["status"] === "repository_not_installed")
            throw new GithubRepositoryNotInstalledError(
              "The GitHub App does not cover this repository",
            );
          if (proof["status"] === "authorization_code_rejected")
            throw new GithubAuthorizationCodeRejectedError("GitHub rejected the confirmation");
        }
        if (
          Object.keys(proof).sort().join(",") !==
            "installationId,owner,permission,repository,repositoryId,userId" ||
          proof["owner"] !== row["repository_owner"] ||
          proof["repository"] !== row["repository_name"] ||
          proof["permission"] !== "contents:read" ||
          ![proof["userId"], proof["installationId"], proof["repositoryId"]].every(positive)
        )
          throw new GithubAuthorizationRejectedError();
        if (!(await active(row))) throw new GithubAuthorizationRejectedError();
        await authorized(
          text(row, "organization_id"),
          text(row, "project_id"),
          text(row, "principal_id"),
        );
        const scope = await data.readScope({
          organizationId: parseUlid(text(row, "organization_id")),
          projectId: parseUlid(text(row, "project_id")),
        });
        if (
          !scope ||
          scope.billingEpochId !== row["billing_epoch_id"] ||
          scope.environmentId !== row["environment_id"]
        )
          throw new GithubAuthorizationRejectedError();
        // Acceptance is idempotent by the stored key and digest, so a retry after a lost reply finds the same operation.
        const accepted = await data.acceptProductOperation(
          () => ({
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            billingEpochId: scope.billingEpochId,
            operationId: ids.next(),
            operationEventId: ids.next(),
            auditEventId: ids.next(),
            outboxEventId: ids.next(),
            principalId: text(row, "principal_id"),
            requestId: `github:${text(row, "authorization_id")}`,
            httpMethod: "POST",
            routeTemplate: "/v1/projects/{project_id}/source:link",
            idempotencyKey: text(row, "idempotency_key"),
            canonicalRequestDigest: bytes(text(row, "request_sha256")),
            eventType: "SourceLinkRequestedV1",
            installationId: String(proof["installationId"]),
            repositoryOwner: text(row, "repository_owner"),
            repositoryName: text(row, "repository_name"),
            occurredAt: clock.now().toISOString(),
          }),
          "SourceLinkRequestedV1",
        );
        const saved = await runtime.completeGithubSourceAuthorization({
          authorizationId: text(row, "authorization_id"),
          operationId: accepted.operationId,
          githubUserId: String(proof["userId"]),
          installationId: String(proof["installationId"]),
          repositoryId: String(proof["repositoryId"]),
        });
        if (saved === null) throw new GithubAuthorizationRejectedError();
        return view(saved);
      } catch (error) {
        const failure = failureOf(error);
        // A reason the customer can still act on leaves the authorization open; a terminal one ends it but names itself.
        await runtime.releaseGithubSourceAuthorization({
          authorizationId: text(row, "authorization_id"),
          resumable: !TERMINAL_REASONS.has(failure),
          failure,
        });
        throw error;
      }
    },
  };
}

type Failure =
  | "installation_access_required"
  | "account_admin_required"
  | "authorization_code_rejected"
  | "provider_unavailable"
  | "expired"
  | "session_inactive"
  | "denied"
  | "code_spent";
const connectionView = (row: Row) => ({
  connection_id: text(row, "connection_id"),
  organization_id: text(row, "organization_id"),
  installation_id: text(row, "installation_id"),
  account_id: text(row, "account_id"),
  account_login: text(row, "account_login"),
  account_type: text(row, "account_type") as "User" | "Organization",
  github_user_id: text(row, "github_user_id"),
  github_user_login: text(row, "github_user_login"),
  connected_at: instantOf(row["connected_at"]).toISOString(),
  revoked_at: row["revoked_at"] === null ? null : instantOf(row["revoked_at"]).toISOString(),
  settings_url: text(row, "settings_url"),
});

/** GitHub matches owner and repository names without regard to case; the link compares them the same way. */
function sameRepositoryName(value: unknown, typed: string): boolean {
  return typeof value === "string" && value.toLowerCase() === typed.toLowerCase();
}

/** The organization-wide GitHub App connection of the original, with its state kept in the Core. */
export function createD1GithubOrganizationConnection(
  dependencies: D1GithubDependencies & { readonly source: GithubOrganizationBinding },
) {
  const { runtime, clock, ids, cipher } = dependencies,
    active = credentialActive(dependencies),
    data = createD1ProductSurfaceDataPort(dependencies.product);
  const identity = (row: Row) => ({
    scope: "organization-authorization" as const,
    organizationId: text(row, "organization_id"),
    authorizationId: text(row, "authorization_id"),
    name: "GITHUB_CONNECTION",
  });
  const authorized = async (organizationId: string, principalId: string, projectId?: string) => {
    if (
      !principalPattern.test(principalId) ||
      (await dependencies.control.authorizeOrganizationAction({
        organizationId,
        principalId,
        action: "sources:link",
        ...(projectId === undefined ? {} : { projectId }),
      })) !== "allow"
    )
      throw new GithubAuthorizationRejectedError("session_inactive");
  };
  const plaintext = async (row: Row) => {
    const value = object(JSON.parse(await cipher.decrypt({ ...identity(row), ...sealedOf(row) })));
    if (
      typeof value["state"] !== "string" ||
      typeof value["verifier"] !== "string" ||
      hex(digest(value["state"])) !== text(row, "state_sha256")
    )
      throw new Error("Invalid stored GitHub connection authorization");
    return { state: value["state"], verifier: value["verifier"] };
  };
  const urls = async (row: Row) => {
    const value = await plaintext(row);
    const proof = object(
      await dependencies.source.beginOrganizationAuthorization({
        state: value.state,
        codeChallenge: digest(value.verifier).toString("base64url"),
      }),
    );
    const install = new URL(String(proof["installationUrl"]));
    const oauth = new URL(String(proof["authorizationUrl"]));
    if (
      install.origin !== "https://github.com" ||
      !/^\/apps\/[a-z0-9-]+\/installations\/new$/u.test(install.pathname) ||
      install.searchParams.get("state") !== value.state ||
      [...install.searchParams.keys()].join(",") !== "state" ||
      oauth.origin !== "https://github.com" ||
      oauth.pathname !== "/login/oauth/authorize" ||
      oauth.searchParams.get("state") !== value.state ||
      oauth.searchParams.get("code_challenge") !== digest(value.verifier).toString("base64url") ||
      oauth.searchParams.get("code_challenge_method") !== "S256" ||
      oauth.searchParams.get("prompt") !== "select_account" ||
      oauth.searchParams.get("redirect_uri") !== dependencies.callbackUri ||
      [...oauth.searchParams.keys()].sort().join(",") !==
        "client_id,code_challenge,code_challenge_method,prompt,redirect_uri,state" ||
      install.username ||
      install.password ||
      install.hash ||
      oauth.username ||
      oauth.password ||
      oauth.hash
    )
      throw new Error("Invalid GitHub connection URL");
    return { install: install.href, oauth: oauth.href };
  };
  const recordFailure = async (row: Row, reason: Failure): Promise<Row> => {
    const changed = await runtime.failGithubConnectionAuthorization({
      authorizationId: text(row, "authorization_id"),
      reason,
      nextState:
        reason === "provider_unavailable" || reason === "authorization_code_rejected"
          ? "pending"
          : "failed",
    });
    if (changed === null) throw new Error("GitHub connection authorization is unavailable");
    return changed;
  };
  const status = async (organizationId: string) => {
    const row = await runtime.readGithubConnection({ organizationId });
    if (row === null) return { status: "not_connected" as const, connection: null };
    if (row["revoked_at"] !== null)
      return { status: "revoked" as const, connection: connectionView(row) };
    const observed = object(
      await dependencies.source.observeOrganizationInstallation({
        installationId: text(row, "installation_id"),
      }),
    );
    if (observed["status"] === "revoked") {
      const revoked = await runtime.revokeGithubConnection({
        organizationId,
        connectionId: text(row, "connection_id"),
        now: clock.now().toISOString(),
        reason: "installation_uninstalled",
      });
      return { status: "revoked" as const, connection: connectionView(revoked ?? row) };
    }
    if (
      String(observed["installationId"]) !== text(row, "installation_id") ||
      String(observed["accountId"]) !== text(row, "account_id") ||
      observed["accountType"] !== row["account_type"]
    )
      throw new Error("GitHub installation identity changed");
    return { status: "connected" as const, connection: connectionView(row) };
  };
  const view = async (current: Row) => {
    let row = current;
    if (
      text(row, "state") !== "connected" &&
      text(row, "state") !== "failed" &&
      instantOf(row["expires_at"]) <= clock.now()
    )
      row = await recordFailure(row, "expired");
    const saved =
      row["connection_id"] === null
        ? null
        : await runtime.readGithubConnectionById({
            organizationId: text(row, "organization_id"),
            connectionId: text(row, "connection_id"),
          });
    return {
      authorization_id: text(row, "authorization_id"),
      status:
        row["last_failure"] === "expired"
          ? ("expired" as const)
          : (text(row, "state") as "pending" | "authorizing" | "connected" | "failed"),
      last_failure: nullable(row, "last_failure") as Failure | null,
      authorization_url:
        text(row, "state") === "pending"
          ? (await urls(row))[row["flow"] === "oauth" ? "oauth" : "install"]
          : null,
      expires_at: instantOf(row["expires_at"]).toISOString(),
      connection: saved ? connectionView(saved) : null,
    };
  };
  const terminal = async (row: Row, reason: Failure) => view(await recordFailure(row, reason));
  const operationOf = async (organizationId: string, operationId: string) => {
    const raw = await dependencies.product.readApiProductOperation({ organizationId, operationId });
    if (raw === null) throw new Error("Linked source operation unavailable");
    return operationResult(
      productOperationView(raw, parseUlid(organizationId), parseUlid(operationId)),
    );
  };
  const linkingPrincipal = (principal: AuthenticatedPrincipal) => {
    const principalId = principal.authorizationPrincipal.subjectId,
      session = principal.session,
      key = principal.userApiKey;
    if (
      (session === undefined) === (key === undefined) ||
      principalId !== `user:${session?.userId ?? key?.userId}` ||
      (key !== undefined &&
        (!key.permissions.includes("sources:link") ||
          principal.credentialId !== `user_api_key:${key.id}`))
    )
      throw new GithubAuthorizationRejectedError("session_inactive");
    return { principalId, session, key };
  };
  return {
    status,
    /** Owner disconnect: the connection and every GitHub repository grant it covers stop being usable at once. */
    async disconnect(request: { organizationId: string; principal: AuthenticatedPrincipal }) {
      const { principalId } = linkingPrincipal(request.principal);
      await authorized(request.organizationId, principalId);
      const row = await runtime.readGithubConnection({ organizationId: request.organizationId });
      if (row === null) return { status: "not_connected" as const, connection: null };
      const revoked = await runtime.revokeGithubConnection({
        organizationId: request.organizationId,
        connectionId: text(row, "connection_id"),
        now: clock.now().toISOString(),
        reason: "permission_revoked",
      });
      return { status: "revoked" as const, connection: connectionView(revoked ?? row) };
    },
    async begin(request: {
      organizationId: string;
      principal: AuthenticatedPrincipal;
      idempotencyKey: string;
    }) {
      const { principalId, session, key } = linkingPrincipal(request.principal);
      await authorized(request.organizationId, principalId);
      const mapping = await runtime.readGithubOrganizationMapping({
        organizationId: request.organizationId,
      });
      if (
        !mapping ||
        mapping.workosOrganizationId !== (session?.organizationId ?? key?.organizationId)
      )
        throw new GithubAuthorizationRejectedError("session_inactive");
      const attemptKey = {
        organizationId: request.organizationId,
        principalId,
        idempotencyKey: request.idempotencyKey,
      };
      const settle = (row: Row) => {
        if (
          nullable(row, "session_id") !== (session?.sessionId ?? null) ||
          nullable(row, "user_api_key_id") !== (key?.id ?? null)
        )
          throw new IdempotencyKeyReusedError();
        return row;
      };
      let row: Row | null = null;
      const prior = await runtime.readGithubConnectionAuthorization(attemptKey);
      if (prior !== null) row = settle(prior);
      else if (
        !(await runtime.hasActiveGithubConnection({ organizationId: request.organizationId }))
      ) {
        // A previous project consent is only a routing hint for an already-installed App; the new OAuth exchange
        // must still prove ownership before any organization grant exists.
        const hints = await runtime.readGithubInstallationHints({
          organizationId: request.organizationId,
          principalId,
        });
        const installationHint = hints.length === 1 ? (hints[0] ?? null) : null,
          id = ids.next(),
          state = `${id}_${randomBytes(32).toString("base64url")}`,
          now = clock.now(),
          encrypted = await cipher.encrypt({
            ...identity({ authorization_id: id, organization_id: request.organizationId }),
            value: JSON.stringify({ state, verifier: randomBytes(32).toString("base64url") }),
          });
        await runtime.insertGithubConnectionAuthorization({
          ...attemptKey,
          ...(request.principal.handoffDelegation === undefined
            ? {}
            : { handoffDelegation: request.principal.handoffDelegation }),
          authorizationId: id,
          sessionId: session?.sessionId ?? null,
          userApiKeyId: key?.id ?? null,
          workosOrganizationId: mapping.workosOrganizationId,
          tokenExpiresAt:
            session?.tokenExpiresAt ??
            (key?.expiresAt ? Math.floor(Date.parse(key.expiresAt) / 1000) : null),
          stateSha256: hex(digest(state)),
          ...wireOfSealed(encrypted),
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + AUTHORIZATION_WINDOW_MS).toISOString(),
          installationId: installationHint,
          flow: installationHint === null ? "installation" : "oauth",
        });
        const saved = await runtime.readGithubConnectionAuthorization(attemptKey);
        if (saved === null) throw new Error("GitHub connection authorization was not persisted");
        row = settle(saved);
      }
      if (row !== null) return view(row);
      const current = await status(request.organizationId);
      if (current.status !== "connected")
        throw new GithubConnectionRequiredError("github_connection_revoked");
      return {
        authorization_id: null,
        status: "connected" as const,
        last_failure: null,
        authorization_url: null,
        expires_at: null,
        connection: current.connection,
      };
    },
    async callback(request: {
      state: string;
      signedInPrincipalId: string;
      code?: string;
      installationId?: string;
      setupAction?: "install" | "update" | "request";
      denied?: boolean;
    }) {
      if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}_[A-Za-z0-9_-]{43}$/u.test(request.state))
        throw new GithubAuthorizationRejectedError();
      const stateSha256 = hex(digest(request.state)),
        row = await runtime.readGithubConnectionAuthorizationByState({ stateSha256 });
      if (!row) {
        // Only an actual already-open project authorization uses the bounded cutover reader.
        if (await runtime.readGithubSourceAuthorizationByState({ stateSha256 })) return null;
        throw new GithubConnectionStateUnknownError();
      }
      // The provider proof is taken only from the browser of the user who started the attempt. Anyone else is
      // answered as for an unknown state, before the attempt is read any further, failed or consumed.
      if (text(row, "principal_id") !== request.signedInPrincipalId)
        throw new GithubConnectionStateUnknownError();
      const state = text(row, "state");
      if (state === "connected" || state === "failed")
        return { view: await view(row), redirect: null };
      if (instantOf(row["expires_at"]) <= clock.now())
        return { view: await terminal(row, "expired"), redirect: null };
      if (!(await active(row)))
        return { view: await terminal(row, "session_inactive"), redirect: null };
      try {
        await authorized(text(row, "organization_id"), text(row, "principal_id"));
      } catch (error) {
        if (error instanceof GithubAuthorizationRejectedError)
          return { view: await terminal(row, "session_inactive"), redirect: null };
        throw error;
      }
      if (request.denied) return { view: await terminal(row, "denied"), redirect: null };
      if (request.setupAction === "request")
        return { view: await terminal(row, "account_admin_required"), redirect: null };
      if (state === "authorizing") return { view: await view(row), redirect: null };
      const installationId = nullable(row, "installation_id") ?? request.installationId;
      if (
        !installationId ||
        !/^[1-9][0-9]*$/u.test(installationId) ||
        !Number.isSafeInteger(Number(installationId)) ||
        (row["installation_id"] !== null &&
          request.installationId !== undefined &&
          row["installation_id"] !== request.installationId)
      )
        return { view: await terminal(row, "installation_access_required"), redirect: null };
      if (!request.code) {
        const next = await runtime.advanceGithubConnectionToOauth({
          authorizationId: text(row, "authorization_id"),
          installationId,
        });
        if (!next) return { view: await view(row), redirect: null };
        return { view: await view(next), redirect: (await urls(next)).oauth };
      }
      if (request.code.length > 4096)
        return { view: await terminal(row, "authorization_code_rejected"), redirect: null };
      const delegated = row["handoff_delegation"] != null;
      const leaseNow = clock.now();
      const claimed = await runtime.claimGithubConnectionAuthorization({
        authorizationId: text(row, "authorization_id"),
        installationId,
        ...(delegated
          ? {
              now: leaseNow.toISOString(),
              expiresAt: new Date(leaseNow.getTime() + 60_000).toISOString(),
            }
          : {}),
      });
      if (!claimed) return { view: await view({ ...row, state: "authorizing" }), redirect: null };
      try {
        const secret = await plaintext(row);
        let leaseExpiresAt: string | undefined;
        if (delegated) {
          const now = clock.now();
          leaseExpiresAt = new Date(now.getTime() + 60_000).toISOString();
          if (
            !(await runtime.renewGithubConnectionProviderUse({
              authorizationId: text(row, "authorization_id"),
              now: now.toISOString(),
              expiresAt: leaseExpiresAt,
            }))
          )
            throw new GithubAuthorizationRejectedError("session_inactive");
        }
        const proof = object(
          await dependencies.source.completeOrganizationAuthorization({
            code: request.code,
            codeVerifier: secret.verifier,
            installationId,
            flow: row["flow"],
            ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }),
          }),
        );
        if (
          Object.keys(proof).join(",") === "status" &&
          ["account_admin_required", "authorization_code_rejected"].includes(
            String(proof["status"]),
          )
        )
          return { view: await terminal(row, proof["status"] as Failure), redirect: null };
        if (
          Object.keys(proof).sort().join(",") !==
            "accountId,accountLogin,accountType,installationId,repositorySelection,settingsUrl,userId,userLogin" ||
          !positive(proof["installationId"]) ||
          String(proof["installationId"]) !== installationId ||
          !positive(proof["accountId"]) ||
          !positive(proof["userId"]) ||
          !login(proof["accountLogin"]) ||
          !login(proof["userLogin"]) ||
          !["User", "Organization"].includes(String(proof["accountType"])) ||
          !["all", "selected"].includes(String(proof["repositorySelection"])) ||
          typeof proof["settingsUrl"] !== "string"
        )
          throw new Error("Invalid GitHub installation proof");
        const settings = new URL(proof["settingsUrl"]);
        if (
          settings.origin !== "https://github.com" ||
          settings.username ||
          settings.password ||
          settings.hash ||
          settings.search ||
          !/^\/(?:settings|organizations\/[A-Za-z0-9-]+\/settings)\/installations\/[1-9][0-9]*$/u.test(
            settings.pathname,
          ) ||
          !settings.pathname.endsWith(`/${installationId}`)
        )
          throw new Error("Invalid GitHub installation settings URL");
        if (!(await active(row)))
          return { view: await terminal(row, "session_inactive"), redirect: null };
        await authorized(text(row, "organization_id"), text(row, "principal_id"));
        const completed = await runtime.completeGithubConnection({
          authorizationId: text(row, "authorization_id"),
          organizationId: text(row, "organization_id"),
          principalId: text(row, "principal_id"),
          connectionId: ids.next(),
          now: clock.now().toISOString(),
          proof: {
            installationId,
            accountId: String(proof["accountId"]),
            accountLogin: proof["accountLogin"],
            accountType: proof["accountType"],
            githubUserId: String(proof["userId"]),
            githubUserLogin: proof["userLogin"],
            settingsUrl: settings.href,
          },
        });
        if (completed.outcome === "different_account")
          throw new GithubAuthorizationRejectedError("code_spent");
        if (completed.outcome !== "connected" || completed.row === undefined)
          throw new GithubAuthorizationRejectedError("expired");
        return { view: await view(completed.row), redirect: null };
      } catch (error) {
        const reason: Failure =
          error instanceof GithubAuthorizationRejectedError ? error.reason : "provider_unavailable";
        return { view: await terminal(row, reason), redirect: null };
      } finally {
        if (delegated)
          await runtime.releaseGithubConnectionProviderUse({
            authorizationId: text(row, "authorization_id"),
          });
      }
    },
    async link(
      request: ProductSurfaceMutationContext & { repositoryOwner: string; repositoryName: string },
    ) {
      await authorized(request.organizationId, request.principalId, request.projectId);
      const consentKey = {
        organizationId: request.organizationId,
        projectId: request.projectId,
        principalId: request.principalId,
        idempotencyKey: request.idempotencyKey,
      };
      const previous = async () => {
        const consent = await runtime.readGithubRepositoryLinkConsent(consentKey);
        if (consent === null) return null;
        if (consent.requestSha256 !== hex(request.canonicalRequestDigest))
          throw new IdempotencyKeyReusedError();
        return operationOf(request.organizationId, consent.operationId);
      };
      const prior = await previous();
      if (prior) return prior;
      const current = await status(request.organizationId);
      if (current.status !== "connected" || !current.connection)
        throw new GithubConnectionRequiredError(
          current.status === "revoked" ? "github_connection_revoked" : "github_connection_required",
        );
      const connected = current.connection,
        scope = await data.readScope({
          organizationId: request.organizationId,
          projectId: request.projectId,
        });
      if (!scope) throw new GithubAuthorizationRejectedError("session_inactive");
      const operationId = ids.next();
      const proof = object(
        await dependencies.source.validateOrganizationRepository({
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          billingEpochId: scope.billingEpochId,
          operationId,
          installationId: Number(connected.installation_id),
          owner: request.repositoryOwner,
          name: request.repositoryName,
        }),
      );
      if (proof["status"] === "repository_not_installed")
        throw new GithubConnectionRequiredError("repository_not_installed", connected.settings_url);
      if (
        Object.keys(proof).sort().join(",") !==
          "externalRepositoryId,installationId,name,owner,permission" ||
        String(proof["installationId"]) !== connected.installation_id ||
        !sameRepositoryName(proof["owner"], request.repositoryOwner) ||
        !sameRepositoryName(proof["name"], request.repositoryName) ||
        proof["permission"] !== "contents:read" ||
        typeof proof["externalRepositoryId"] !== "string" ||
        !/^[1-9][0-9]*$/u.test(proof["externalRepositoryId"])
      )
        throw new Error("Invalid GitHub repository proof");
      // GitHub's spelling of the owner and repository is the one the link records, whatever case was typed.
      const repositoryOwner = String(proof["owner"]),
        repositoryName = String(proof["name"]);
      await authorized(request.organizationId, request.principalId, request.projectId);
      const replay = await previous();
      if (replay) return replay;
      const fresh = await data.readScope({
        organizationId: request.organizationId,
        projectId: request.projectId,
      });
      if (
        !fresh ||
        fresh.environmentId !== scope.environmentId ||
        fresh.billingEpochId !== scope.billingEpochId ||
        !(await runtime.hasActiveGithubConnection({ organizationId: request.organizationId }))
      )
        throw new GithubAuthorizationRejectedError("session_inactive");
      const accepted = await data.acceptProductOperation(
        () => ({
          organizationId: fresh.organizationId,
          projectId: fresh.projectId,
          environmentId: fresh.environmentId,
          billingEpochId: fresh.billingEpochId,
          operationId,
          operationEventId: ids.next(),
          auditEventId: ids.next(),
          outboxEventId: ids.next(),
          principalId: request.principalId,
          requestId: request.requestId,
          httpMethod: "POST",
          routeTemplate: "/v1/projects/{project_id}/source:link",
          idempotencyKey: request.idempotencyKey,
          canonicalRequestDigest: request.canonicalRequestDigest,
          eventType: "SourceLinkRequestedV1",
          ...(request.delegation === undefined ? {} : { delegation: request.delegation }),
          installationId: connected.installation_id,
          repositoryOwner,
          repositoryName,
          occurredAt: clock.now().toISOString(),
        }),
        "SourceLinkRequestedV1",
      );
      await runtime.insertGithubRepositoryLinkConsent({
        ...consentKey,
        operationId: accepted.operationId,
        environmentId: fresh.environmentId,
        billingEpochId: fresh.billingEpochId,
        connectionId: connected.connection_id,
        installationId: connected.installation_id,
        repositoryId: proof["externalRepositoryId"],
        repositoryOwner,
        repositoryName,
        requestSha256: hex(request.canonicalRequestDigest),
        authorizedAt: clock.now().toISOString(),
      });
      return operationOf(request.organizationId, accepted.operationId);
    },
  };
}
