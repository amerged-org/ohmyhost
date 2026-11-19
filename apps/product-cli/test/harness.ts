import {
  WorkosDeviceFlowClient,
  type WorkosClock,
  type WorkosPublicHttpRequest,
  type WorkosPublicTransport,
} from "@ohmyhost/workos-auth-contracts/device-flow";

import {
  LifecycleTransportError,
  NetworkTransportError,
  ProductCli,
  type DiagnosticSink,
  type DeviceAuthorizationPresenter,
  type TokenRefresher,
  type TokenRevoker,
} from "../src/cli.js";
import type {
  CredentialStore,
  CurrentCredential,
  StoredCredential,
} from "../src/credential-store.js";
import { GeneratedSdkProductApi } from "../src/product-api.js";
import {
  ProfileNameConflictError,
  sameLogin,
  type LocalProfile,
  type ProfileRegistry,
} from "../src/profile-store.js";
import type {
  ApiCall,
  CreateProductCliTestHarness,
  DeviceTokenOutcome,
  ProductCliHarnessOptions,
  ProductCliSnapshot,
  ProductCliTestHarness,
  TestWorkspace,
} from "./contract.js";

const OPERATION_ID = "01K2F3G4H5J6K7M8N9P0QRSTVW";

export const createProductCliTestHarness: CreateProductCliTestHarness = async (
  options = {},
): Promise<ProductCliTestHarness> => {
  const state = new HarnessState(
    options.storedCredential,
    options.deviceTokenOutcomes ?? [],
    options.deviceTokenExpiresInSeconds === undefined ? 3_600 : options.deviceTokenExpiresInSeconds,
    options.apiError,
    options.invalidOperation ?? false,
    options.failedOperation ?? false,
    options.apiNetworkError ?? false,
    options.apiProgrammingError ?? false,
    options.apiSpoofedErrorName,
    options.organizations ?? [],
    options.profileError ?? false,
    options.identityOrganizationIds ?? ["00000000000000000000000001"],
  );
  const profiles = new HarnessProfiles(
    state,
    options.storedCredential,
    options.organizations ?? [],
  );
  const cli = new ProductCli({
    commandPrefix: "OHMYHOST_ENVIRONMENT=development ohmyhost",
    credentialStore: () => state,
    profiles,
    ...(profiles.selected === undefined ? {} : { profile: profiles.selected }),
    ...(options.profileName === undefined ? {} : { profileName: options.profileName }),
    currentIdentity: async (accessToken) =>
      await new GeneratedSdkProductApi(
        "https://control.example.test",
        accessToken,
        state.fetch.bind(state),
      ).getCurrentIdentity(),
    deviceFlow: new WorkosDeviceFlowClient(
      {
        clientId: "client-public-a",
        scope: "openid offline_access",
        verificationUri: "https://auth.example.test/device?tenant=internal",
      },
      state,
      state,
    ),
    deviceAuthorizationPresenter: state,
    productApi: (accessToken) =>
      new GeneratedSdkProductApi(
        "https://control.example.test",
        accessToken,
        state.fetch.bind(state),
      ),
    accountProfile: async (accessToken) =>
      await new GeneratedSdkProductApi(
        "https://control.example.test",
        accessToken,
        state.fetch.bind(state),
      ).getAccountProfile(),
    projectLinkStore: { save: async () => undefined },
    productApiOrigin: "https://control.example.test",
    tokenRevoker: new HarnessRevoker(
      state,
      options.revokeError,
      options.revokeNeverSettles ?? false,
    ),
    tokenRefresher: new HarnessRefresher(state, options.refreshedCredential, options.refreshError),
    now: () => state.now(),
    waitUntil: async (instant, signal) => state.advanceTo(instant, signal),
    lifecycleTimeoutMs: options.lifecycleTimeoutMs ?? 5_000,
    createCorrelationId: () => "correlation-a",
    diagnosticSink: state,
    readSecretValue: async () => "fixture-secret-value",
  });
  return {
    run: (argv, signal) => cli.run(argv, signal),
    snapshot: async () => ({ ...state.snapshot(), profiles: [...profiles.saved] }),
  };
};

/**
 * The saved logins of one harness. It models one credential entry, the harness state, which the
 * selected login and every newly saved login use.
 */
class HarnessProfiles implements ProfileRegistry {
  saved: LocalProfile[];
  readonly selected: LocalProfile | undefined;

  public constructor(
    private readonly state: HarnessState,
    stored: StoredCredential | undefined,
    organizations: readonly TestWorkspace[],
  ) {
    this.selected =
      stored === undefined
        ? undefined
        : {
            name: "harness",
            userId: "user-a",
            organizationId: stored.organizationId ?? null,
            organizationName:
              organizations.find((organization) => organization.id === stored.organizationId)
                ?.name ?? null,
          };
    this.saved = this.selected === undefined ? [] : [this.selected];
  }

  public async list(): Promise<readonly LocalProfile[]> {
    return [...this.saved];
  }

  public credential(): CredentialStore {
    return this.state;
  }

  public legacy(): CredentialStore {
    return {
      read: async () => undefined,
      replace: async () => undefined,
      clear: async () => undefined,
    };
  }

  public async save(
    profile: LocalProfile,
    credential: CurrentCredential,
    replaces?: LocalProfile,
  ): Promise<void> {
    const kept = (saved: LocalProfile): boolean =>
      !sameLogin(saved, profile) && (replaces === undefined || !sameLogin(saved, replaces));
    const conflict = this.saved.find((saved) => saved.name === profile.name && kept(saved));
    if (conflict !== undefined) throw new ProfileNameConflictError(conflict);
    await this.state.replace(credential);
    this.saved = [...this.saved.filter(kept), profile];
  }

  public async remove(profile: LocalProfile): Promise<void> {
    await this.state.clear();
    this.saved = this.saved.filter((saved) => !sameLogin(saved, profile));
  }
}

class HarnessState
  implements
    CredentialStore,
    WorkosPublicTransport,
    WorkosClock,
    DeviceAuthorizationPresenter,
    DiagnosticSink
{
  readonly diagnostics: Array<{
    correlationId: string;
    category: string;
    subsystem: string;
    errorKind: string;
  }> = [];
  readonly lifecycleEvents: Array<"authorization-presented" | "token-polled"> = [];
  readonly presentedAuthorizations: Array<{ verificationUri: string; userCode: string }> = [];
  readonly deviceAuthorizationRequests: Array<{ clientId: string; scope: string }> = [];
  readonly tokenPollRequests: Array<{
    clientId: string;
    deviceCode: string;
    grantType: "urn:ietf:params:oauth:grant-type:device_code";
  }> = [];
  readonly revokeRequests: Array<{ token: string }> = [];
  readonly refreshRequests: Array<{ token: string; workosOrganizationId?: string }> = [];
  /** Access tokens the device flow issued; they carry no organization until a refresh names one. */
  readonly deviceAccessTokens = new Set<string>();
  readonly apiCalls: Array<ApiCall> = [];
  credentialReplaceCount = 0;
  credential: StoredCredential | undefined;
  #now = new Date("2026-08-18T00:00:00.000Z");

  public constructor(
    storedCredential: StoredCredential | undefined,
    private readonly tokenOutcomes: readonly DeviceTokenOutcome[],
    private readonly tokenExpiresInSeconds: number | null,
    private readonly apiError: ProductCliHarnessOptions["apiError"],
    private readonly invalidOperation: boolean,
    private readonly failedOperation: boolean,
    private readonly apiNetworkError: boolean,
    private readonly apiProgrammingError: boolean,
    private readonly apiSpoofedErrorName: string | undefined,
    private readonly organizations: readonly TestWorkspace[],
    private readonly profileError: boolean,
    private readonly identityOrganizationIds: readonly string[],
  ) {
    this.credential = storedCredential;
  }

  public now(): Date {
    return new Date(this.#now.getTime());
  }

  public advanceTo(instant: Date, signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason;
    const minimum = this.#now.getTime() + 5_000;
    this.#now = new Date(Math.max(minimum, instant.getTime()));
  }

  public async present(input: {
    readonly verificationUri: string;
    readonly verificationUriComplete?: string;
    readonly userCode: string;
  }): Promise<void> {
    this.lifecycleEvents.push("authorization-presented");
    this.presentedAuthorizations.push({
      verificationUri: input.verificationUri,
      ...(input.verificationUriComplete === undefined
        ? {}
        : { verificationUriComplete: input.verificationUriComplete }),
      userCode: input.userCode,
    });
  }

  public record(event: {
    readonly correlationId: string;
    readonly category: string;
    readonly subsystem: string;
    readonly errorKind: string;
  }): void {
    this.diagnostics.push(event);
  }

  public async read(): Promise<StoredCredential | undefined> {
    return this.credential;
  }

  public async replace(credential: CurrentCredential): Promise<void> {
    this.credentialReplaceCount += 1;
    this.credential = credential;
  }

  public async clear(): Promise<void> {
    this.credential = undefined;
  }

  public async send(request: WorkosPublicHttpRequest): Promise<{ status: number; body: string }> {
    const body = new URLSearchParams(request.body);
    if (request.url.endsWith("/authorize/device")) {
      this.deviceAuthorizationRequests.push({
        clientId: body.get("client_id") ?? "",
        scope: body.get("scope") ?? "",
      });
      return {
        status: 200,
        body: JSON.stringify({
          device_code: "device-code-a",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.example.test/device?tenant=internal",
          expires_in: 600,
          interval: 5,
        }),
      };
    }
    this.tokenPollRequests.push({
      clientId: body.get("client_id") ?? "",
      deviceCode: body.get("device_code") ?? "",
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
    });
    this.lifecycleEvents.push("token-polled");
    const outcome = this.tokenOutcomes[this.tokenPollRequests.length - 1] ?? "expired_token";
    if (typeof outcome !== "string") this.deviceAccessTokens.add(outcome.accessToken);
    return typeof outcome === "string"
      ? { status: 400, body: JSON.stringify({ error: outcome }) }
      : {
          status: 200,
          body: JSON.stringify({
            access_token: outcome.accessToken,
            refresh_token: outcome.refreshToken,
            token_type: "Bearer",
            ...(this.tokenExpiresInSeconds === null
              ? {}
              : { expires_in: this.tokenExpiresInSeconds }),
          }),
        };
  }

  public async fetch(
    input: string | URL | globalThis.Request,
    init?: RequestInit,
  ): Promise<Response> {
    const request = new Request(input, init);
    const requestBody = request.method === "GET" ? "" : await request.text();
    const body = requestBody === "" ? undefined : (JSON.parse(requestBody) as unknown);
    const path = new URL(request.url).pathname;
    const authorization = request.headers.get("authorization");
    const idempotencyKey = request.headers.get("idempotency-key");
    this.apiCalls.push({
      method: request.method,
      path,
      transport: "generated-sdk",
      headers: {
        ...(authorization === null ? {} : { Authorization: authorization }),
        ...(idempotencyKey === null ? {} : { "Idempotency-Key": idempotencyKey }),
      },
      ...(body === undefined ? {} : { body }),
    });
    if (this.apiNetworkError) throw new NetworkTransportError();
    if (this.apiProgrammingError) throw new TypeError("programming detail secret.internal");
    if (this.apiSpoofedErrorName !== undefined) {
      return new Response(JSON.stringify({ name: this.apiSpoofedErrorName }), {
        headers: { "content-type": "application/problem+json" },
        status: 503,
      });
    }
    if (this.apiError !== undefined) {
      return new Response(
        JSON.stringify({
          type: "https://api.ohmyho.st/problems/service-unavailable",
          title: "Service unavailable",
          status: 503,
          request_id: "request-a",
          ...this.apiError,
        }),
        {
          headers: { "content-type": "application/problem+json" },
          status: 503,
        },
      );
    }
    if (path === "/v1/me/profile") {
      if (this.profileError)
        return new Response(
          JSON.stringify({
            type: "https://api.ohmyho.st/problems/forbidden",
            title: "Forbidden",
            status: 403,
            code: "forbidden",
            request_id: "request-profile",
            retryable: false,
            suggested_action: "Use an interactive user session.",
          }),
          { headers: { "content-type": "application/problem+json" }, status: 403 },
        );
      return new Response(
        JSON.stringify({
          user_id: "user-a",
          name: "Harness user",
          email: "harness@example.test",
          email_verified: true,
          organizations: this.organizations,
          organization_ids: this.organizations.map((organization) => organization.id),
          signup_source: null,
          attributed_at: null,
          initial_workspace_id: null,
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    }
    if (new URL(request.url).pathname === "/v1/me") {
      // The workspace lives in the access token, so a refresh that named one changes this answer.
      const named = this.refreshRequests.at(-1)?.workosOrganizationId;
      const scoped = this.organizations.find((organization) => organization.workos_id === named);
      const device = this.deviceAccessTokens.has(authorization?.replace(/^Bearer /u, "") ?? "");
      const organizationIds = device
        ? []
        : scoped === undefined
          ? this.identityOrganizationIds
          : [scoped.id];
      return new Response(
        JSON.stringify({
          actor_id: "user:user-a",
          email: "harness@example.test",
          organization_ids: organizationIds,
          organizations: organizationIds.map((id) => ({
            id,
            name:
              this.organizations.find((organization) => organization.id === id)?.name ??
              "Workspace",
          })),
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    }
    if (request.method === "GET" && new URL(request.url).pathname === "/v1/projects") {
      return new Response(
        JSON.stringify({
          items: [
            {
              data_mode: "shared" as const,
              region: "us" as const,
              id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
              organization_id: "00000000000000000000000001",
              name: "alpha",
              handle: "calm-otter-waves",
              created_at: "2026-08-18T00:00:00.000Z",
            },
          ],
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    }
    if (request.method === "GET" && new URL(request.url).pathname.endsWith("/status")) {
      const projectId = new URL(request.url).pathname.split("/").at(-2) ?? OPERATION_ID;
      return new Response(
        JSON.stringify({
          project_id: projectId,
          handle: "calm-otter-waves",
          region: "us",
          dev_access_mode: "protected",
          lifecycle: "active",
          source: null,
          default_environment: null,
          head_deployment: null,
          dev_url: null,
          prod_url: null,
          latest_operation: null,
          cleanup_state: "not_started",
          etag: `"sha256-${"a".repeat(64)}"`,
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    }
    if (request.method === "POST" && path.endsWith("/cloudflare-dns/authorization")) {
      return Response.json(
        {
          authorization_id: "01K2F3G4H5J6K7M8N9P0QRSTVY",
          authorization_url:
            "https://dash.cloudflare.com/oauth2/auth?client_id=client-a&state=opaque-state",
          expires_at: "2026-08-18T00:10:00.000Z",
        },
        { status: 201 },
      );
    }
    if (request.method === "GET" && path.endsWith("/cloudflare-dns")) {
      return Response.json({
        status: "authorized",
        zone: "aixyte.com",
        scopes: ["dns.write", "zone.read"],
        expires_at: "2026-08-18T01:00:00.000Z",
      });
    }
    if (request.method === "PUT" && path.endsWith("/domains")) {
      return Response.json(
        {
          id: OPERATION_ID,
          state: "queued",
          created_at: "2026-08-18T00:00:00.000Z",
          updated_at: "2026-08-18T00:00:00.000Z",
        },
        { status: 202 },
      );
    }
    if (request.method === "POST" && new URL(request.url).pathname === "/v1/projects") {
      return new Response(
        JSON.stringify({
          id: OPERATION_ID,
          state: "queued",
          created_at: "2026-08-18T00:00:00.000Z",
          updated_at: "2026-08-18T00:00:00.000Z",
          project_id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
        }),
        { headers: { "content-type": "application/json" }, status: 202 },
      );
    }
    const operationId =
      request.method === "POST"
        ? OPERATION_ID
        : (new URL(request.url).pathname.split("/").at(-1) ?? OPERATION_ID);
    return new Response(
      JSON.stringify({
        id: operationId,
        state: this.failedOperation ? "failed" : request.method === "POST" ? "queued" : "succeeded",
        created_at: "2026-08-18T00:00:00.000Z",
        updated_at: "2026-08-18T00:00:00.000Z",
        ...(this.failedOperation
          ? {
              error: {
                code: "operation_failed",
                message: "provider secret.internal failed",
                retryable: false,
                suggested_action: "provider secret.internal action",
              },
            }
          : {}),
        ...(this.invalidOperation ? { provider_debug: "secret.internal" } : {}),
      }),
      {
        headers: { "content-type": "application/json" },
        status: request.method === "POST" ? 202 : 200,
      },
    );
  }

  public snapshot(): ProductCliSnapshot {
    return {
      diagnostics: [...this.diagnostics],
      lifecycleEvents: [...this.lifecycleEvents],
      presentedAuthorizations: [...this.presentedAuthorizations],
      deviceAuthorizationRequests: [...this.deviceAuthorizationRequests],
      tokenPollRequests: [...this.tokenPollRequests],
      revokeRequests: [...this.revokeRequests],
      refreshRequests: [...this.refreshRequests],
      credentialReplaceCount: this.credentialReplaceCount,
      apiCalls: [...this.apiCalls],
      ...(this.credential === undefined ? {} : { storedCredential: this.credential }),
    };
  }
}

class HarnessRevoker implements TokenRevoker {
  public constructor(
    private readonly state: HarnessState,
    private readonly error: Error | undefined,
    private readonly neverSettles: boolean,
  ) {}

  public async revoke(token: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    this.state.revokeRequests.push({ token });
    if (this.neverSettles) {
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (this.error !== undefined) throw this.error;
  }
}

class HarnessRefresher implements TokenRefresher {
  public constructor(
    private readonly state: HarnessState,
    private readonly credential: CurrentCredential | undefined,
    private readonly error: Error | undefined,
  ) {}

  public async refresh(
    token: string,
    signal: AbortSignal,
    workosOrganizationId?: string,
  ): Promise<CurrentCredential> {
    if (signal.aborted) throw signal.reason;
    this.state.refreshRequests.push({
      token,
      ...(workosOrganizationId === undefined ? {} : { workosOrganizationId }),
    });
    if (this.error !== undefined) throw this.error;
    if (this.credential === undefined) throw new LifecycleTransportError();
    return this.credential;
  }
}
