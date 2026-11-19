import type {
  WorkloadIdentitySecretResolver,
  WorkosManagementCredential,
  WorkosManagementTransport,
  WorkosSessionTransport,
} from "./ports.js";
import { WorkosTransportFailure } from "./ports.js";

const WORKOS_ORIGIN = "https://api.workos.com";
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/u;

type WorkosFetcher = (request: Request) => Promise<Response>;

export interface WorkosCapabilityProbeConfiguration {
  readonly authkitDomain: string;
  readonly connectApplicationId: string;
  readonly connectClientId: string;
  readonly connectClientSecret: string;
}

interface WorkosPrivateCredentials {
  readonly managementSecret: string;
  readonly capabilityProbe: WorkosCapabilityProbeConfiguration | null;
}

/** A WorkOS answer a later attempt can succeed on: a request timeout, a rate limit or a server failure. */
const transientStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkosTransportFailure("permanent");
  }
  return value as Record<string, unknown>;
};

const text = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkosTransportFailure("permanent");
  }
  return value;
};

export const readJson = async (response: Response, maximumBytes: number): Promise<unknown> => {
  if (response.body === null) throw new WorkosTransportFailure("permanent");
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maximumBytes) {
      throw new WorkosTransportFailure("permanent");
    }
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      total += read.value.byteLength;
      if (total > maximumBytes) throw new WorkosTransportFailure("permanent");
      chunks.push(read.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new WorkosTransportFailure("permanent");
  }
};

const minimizeOrganization = (value: unknown) => {
  const input = record(value);
  return {
    id: text(input["id"]),
    name: text(input["name"]),
    created_at: text(input["created_at"]),
    updated_at: text(input["updated_at"]),
  };
};

const minimizeMembership = (value: unknown, organizationId: string) => {
  const input = record(value);
  if (input["organization_id"] !== organizationId || !Array.isArray(input["roles"])) {
    throw new WorkosTransportFailure("permanent");
  }
  return {
    id: text(input["id"]),
    organization_id: organizationId,
    user_id: text(input["user_id"]),
    status: text(input["status"]),
    roles: input["roles"].map((role) => ({ slug: text(record(role)["slug"]) })),
    created_at: text(input["created_at"]),
    updated_at: text(input["updated_at"]),
  };
};

const minimizeSession = (value: unknown) => {
  const input = record(value);
  const expiresAt = text(input["expires_at"]);
  const expiresAtMs = Date.parse(expiresAt);
  if (
    input["object"] !== "session" ||
    !Number.isFinite(expiresAtMs) ||
    new Date(expiresAtMs).toISOString() !== expiresAt
  ) {
    throw new WorkosTransportFailure("permanent");
  }
  return {
    id: text(input["id"]),
    userId: text(input["user_id"]),
    status: text(input["status"]),
    expiresAt: expiresAtMs / 1_000,
  };
};

export function createWorkosReadOnlyBoundary(input: {
  readonly secret: string;
  readonly capabilityProbe?: WorkosCapabilityProbeConfiguration;
  readonly fetcher: WorkosFetcher;
  readonly timeoutMs?: number;
  readonly snapshotTimeoutMs?: number;
  readonly maxResponseBytes?: number;
}): {
  readonly resolver: WorkloadIdentitySecretResolver;
  readonly transport: WorkosManagementTransport & WorkosSessionTransport;
} {
  if (typeof input.secret !== "string" || input.secret.length < 8) {
    throw new TypeError("WorkOS management secret binding is invalid");
  }
  let capabilityProbe: WorkosCapabilityProbeConfiguration | null = null;
  if (input.capabilityProbe !== undefined) {
    const domain = new URL(input.capabilityProbe.authkitDomain);
    if (
      domain.protocol !== "https:" ||
      !domain.hostname.endsWith(".authkit.app") ||
      domain.username !== "" ||
      domain.password !== "" ||
      domain.pathname !== "/" ||
      domain.search !== "" ||
      domain.hash !== "" ||
      !IDENTIFIER.test(input.capabilityProbe.connectApplicationId) ||
      !IDENTIFIER.test(input.capabilityProbe.connectClientId) ||
      input.capabilityProbe.connectClientSecret.length < 8
    ) {
      throw new TypeError("WorkOS capability probe configuration is invalid");
    }
    capabilityProbe = {
      authkitDomain: domain.origin,
      connectApplicationId: input.capabilityProbe.connectApplicationId,
      connectClientId: input.capabilityProbe.connectClientId,
      connectClientSecret: input.capabilityProbe.connectClientSecret,
    };
  }
  const timeoutMs = input.timeoutMs ?? 5_000;
  const snapshotTimeoutMs = input.snapshotTimeoutMs ?? 20_000;
  const maximumBytes = input.maxResponseBytes ?? 1_048_576;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("WorkOS timeout must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new RangeError("WorkOS response limit must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(snapshotTimeoutMs) ||
    snapshotTimeoutMs <= 0 ||
    snapshotTimeoutMs > 20_000
  ) {
    throw new RangeError("WorkOS snapshot timeout must be between 1 and 20000 milliseconds");
  }
  const fetcher = input.fetcher.bind(globalThis);
  const secrets = new WeakMap<object, WorkosPrivateCredentials>();
  const credential = Object.freeze({}) as WorkosManagementCredential;
  secrets.set(credential, { managementSecret: input.secret, capabilityProbe });

  const performRequest = async (request: Request, deadlineSignal?: AbortSignal) => {
    if (deadlineSignal?.aborted === true) throw new WorkosTransportFailure("unavailable");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetcher(
        new Request(request, {
          signal:
            deadlineSignal === undefined
              ? controller.signal
              : AbortSignal.any([controller.signal, deadlineSignal]),
        }),
      );
    } catch {
      throw new WorkosTransportFailure("unavailable");
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 404) throw new WorkosTransportFailure("not_found");
    if (!response.ok) {
      throw new WorkosTransportFailure(
        transientStatus(response.status) ? "unavailable" : "permanent",
      );
    }
    try {
      return await readJson(response, maximumBytes);
    } catch (error) {
      if (error instanceof WorkosTransportFailure) throw error;
      // A body that fails to stream is a network failure, not a malformed answer.
      throw new WorkosTransportFailure("unavailable");
    }
  };

  const request = async (
    credentialInput: WorkosManagementCredential,
    url: URL,
    deadlineSignal?: AbortSignal,
  ) => {
    const privateCredentials = secrets.get(credentialInput);
    if (privateCredentials === undefined) throw new WorkosTransportFailure("permanent");
    return performRequest(
      new Request(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${privateCredentials.managementSecret}`,
          accept: "application/json",
        },
      }),
      deadlineSignal,
    );
  };

  const capabilityCredentials = (credentialInput: WorkosManagementCredential) => {
    const privateCredentials = secrets.get(credentialInput);
    if (privateCredentials?.capabilityProbe === null || privateCredentials === undefined) {
      throw new WorkosTransportFailure("permanent");
    }
    return privateCredentials.capabilityProbe;
  };

  const observation = async <Result>(
    id: import("@ohmyhost/workos-auth-contracts").WorkosCapabilityObservationId,
    probe: () => Promise<Result>,
    count: (result: Result) => number | undefined = () => undefined,
  ) => {
    try {
      const result = await probe();
      const measuredCount = count(result);
      return measuredCount === undefined
        ? { id, available: true, statusCode: 200 }
        : { id, available: true, statusCode: 200, count: measuredCount };
    } catch (error) {
      if (!(error instanceof WorkosTransportFailure)) throw error;
      return { id, available: false, statusCode: error.code === "not_found" ? 404 : 503 };
    }
  };

  const list = (value: unknown): unknown[] => {
    const response = record(value);
    if (response["object"] !== "list" || !Array.isArray(response["data"])) {
      throw new WorkosTransportFailure("permanent");
    }
    return response["data"];
  };

  const transport: WorkosManagementTransport & WorkosSessionTransport = {
    async isSessionActive(credentialInput, input) {
      if (
        !IDENTIFIER.test(input.sessionId) ||
        !IDENTIFIER.test(input.userId) ||
        (input.organizationId !== null && !IDENTIFIER.test(input.organizationId))
      ) {
        throw new TypeError("WorkOS session identity is invalid");
      }
      let after: string | null = null;
      for (let page = 0; page < 100; page += 1) {
        const sessionUrl = new URL(
          `/user_management/users/${encodeURIComponent(input.userId)}/sessions`,
          WORKOS_ORIGIN,
        );
        sessionUrl.searchParams.set("limit", "100");
        // Newest first: the session of the current sign-in is then on the first page, not behind the whole history.
        sessionUrl.searchParams.set("order", "desc");
        if (after !== null) sessionUrl.searchParams.set("after", after);
        const pageBody = record(await request(credentialInput, sessionUrl));
        if (pageBody["object"] !== "list" || !Array.isArray(pageBody["data"])) {
          throw new WorkosTransportFailure("permanent");
        }
        const sessions = pageBody["data"].map(minimizeSession);
        if (
          sessions.some(
            (session) =>
              session.id === input.sessionId &&
              session.userId === input.userId &&
              session.status === "active" &&
              session.expiresAt >= input.tokenExpiresAt,
          )
        ) {
          return true;
        }
        const metadata = record(pageBody["list_metadata"]);
        const next = metadata["after"];
        if (next === null || next === undefined) return false;
        if (typeof next !== "string" || !CURSOR.test(next) || next === after) {
          throw new WorkosTransportFailure("permanent");
        }
        after = next;
        if (page === 99) throw new WorkosTransportFailure("permanent");
      }
      throw new WorkosTransportFailure("permanent");
    },
    async fetchCurrentOrganizationSnapshot(credentialInput, workosOrganizationId) {
      if (!IDENTIFIER.test(workosOrganizationId)) {
        throw new TypeError("WorkOS organization ID is invalid");
      }
      const deadline = new AbortController();
      const timeout = setTimeout(() => deadline.abort(), snapshotTimeoutMs);
      try {
        const organizationUrl = new URL(
          `/organizations/${encodeURIComponent(workosOrganizationId)}`,
          WORKOS_ORIGIN,
        );
        const organization = minimizeOrganization(
          await request(credentialInput, organizationUrl, deadline.signal),
        );
        const memberships: unknown[] = [];
        let after: string | null = null;
        for (let page = 0; page < 100; page += 1) {
          const membershipUrl = new URL("/user_management/organization_memberships", WORKOS_ORIGIN);
          membershipUrl.searchParams.set("organization_id", workosOrganizationId);
          membershipUrl.searchParams.set("limit", "100");
          membershipUrl.searchParams.set("order", "asc");
          if (after !== null) membershipUrl.searchParams.set("after", after);
          const pageBody = record(await request(credentialInput, membershipUrl, deadline.signal));
          if (pageBody["object"] !== "list" || !Array.isArray(pageBody["data"])) {
            throw new WorkosTransportFailure("permanent");
          }
          memberships.push(
            ...pageBody["data"].map((item) => minimizeMembership(item, workosOrganizationId)),
          );
          const metadata = record(pageBody["list_metadata"]);
          const next = metadata["after"];
          if (next === null || next === undefined) {
            after = null;
            break;
          }
          if (typeof next !== "string" || !CURSOR.test(next) || next === after) {
            throw new WorkosTransportFailure("permanent");
          }
          after = next;
          if (page === 99) throw new WorkosTransportFailure("permanent");
        }
        return { organization, memberships };
      } finally {
        clearTimeout(timeout);
      }
    },
    async checkCandidateFga() {
      throw new WorkosTransportFailure("permanent");
    },
    async probeReadOnlyCapabilities(credentialInput) {
      const configuration = capabilityCredentials(credentialInput);
      const organizations = await request(
        credentialInput,
        new URL("/organizations?limit=1", WORKOS_ORIGIN),
      );
      const organizationList = list(organizations);
      const organizationId =
        organizationList.length === 0 ? null : text(record(organizationList[0])["id"]);
      const authkitMetadata = async () => {
        const metadata = record(
          await performRequest(
            new Request(`${configuration.authkitDomain}/.well-known/openid-configuration`, {
              method: "GET",
              headers: { accept: "application/json" },
            }),
          ),
        );
        if (
          metadata["issuer"] !== configuration.authkitDomain ||
          metadata["token_endpoint"] !== `${configuration.authkitDomain}/oauth2/token`
        ) {
          throw new WorkosTransportFailure("permanent");
        }
      };
      const connectApplication = async () => {
        const application = record(
          await request(
            credentialInput,
            new URL(
              `/connect/applications/${encodeURIComponent(configuration.connectApplicationId)}`,
              WORKOS_ORIGIN,
            ),
          ),
        );
        if (
          application["object"] !== "connect_application" ||
          application["id"] !== configuration.connectApplicationId
        ) {
          throw new WorkosTransportFailure("permanent");
        }
        return [application];
      };
      const clientSecretMetadata = async () => {
        const metadata = await request(
          credentialInput,
          new URL(
            `/connect/applications/${encodeURIComponent(configuration.connectApplicationId)}/client_secrets`,
            WORKOS_ORIGIN,
          ),
        );
        if (!Array.isArray(metadata)) throw new WorkosTransportFailure("permanent");
        for (const item of metadata) {
          const secret = record(item);
          if (
            secret["object"] !== "connect_application_secret" ||
            typeof secret["secret_hint"] !== "string" ||
            "secret" in secret
          ) {
            throw new WorkosTransportFailure("permanent");
          }
        }
        return metadata;
      };
      const organizationScopedList = async (path: string) => {
        if (organizationId === null) return [];
        const url = new URL(path, WORKOS_ORIGIN);
        url.searchParams.set("organization_id", organizationId);
        url.searchParams.set("limit", "1");
        return list(await request(credentialInput, url));
      };
      const m2mToken = async () => {
        const body = new URLSearchParams({
          client_id: configuration.connectClientId,
          client_secret: configuration.connectClientSecret,
          grant_type: "client_credentials",
        });
        const response = record(
          await performRequest(
            new Request(`${configuration.authkitDomain}/oauth2/token`, {
              method: "POST",
              headers: {
                accept: "application/json",
                "content-type": "application/x-www-form-urlencoded",
              },
              body,
            }),
          ),
        );
        if (
          typeof response["access_token"] !== "string" ||
          response["access_token"].length === 0 ||
          response["token_type"] !== "bearer" ||
          !Number.isSafeInteger(response["expires_in"])
        ) {
          throw new WorkosTransportFailure("permanent");
        }
      };
      const webhookEndpoints = async () =>
        list(await request(credentialInput, new URL("/webhook_endpoints?limit=1", WORKOS_ORIGIN)));
      return Promise.all([
        observation("authkit_oidc_metadata", authkitMetadata),
        observation("connect_applications_read", connectApplication, (items) => items.length),
        observation(
          "connect_client_secrets_metadata_read",
          clientSecretMetadata,
          (items) => items.length,
        ),
        observation(
          "fga_resources_read",
          () => organizationScopedList("/authorization/resources"),
          (items) => items.length,
        ),
        observation(
          "memberships_read",
          () => organizationScopedList("/user_management/organization_memberships"),
          (items) => items.length,
        ),
        observation("m2m_token_flow", m2mToken),
        Promise.resolve({
          id: "organizations_read" as const,
          available: true,
          statusCode: 200,
          count: organizationList.length,
        }),
        observation("webhook_endpoints_read", webhookEndpoints, (items) => items.length),
      ]);
    },
  };

  return {
    resolver: {
      async withWorkosManagementCredential<Result>(
        use: (credential: WorkosManagementCredential) => Promise<Result>,
      ): Promise<Result> {
        return use(credential);
      },
    },
    transport,
  };
}
