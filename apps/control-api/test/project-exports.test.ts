import { parseUlid } from "@ohmyhost/platform";
import { ProjectRecoveryDailyLimitError } from "@ohmyhost/database";
import { expect, it } from "vitest";
import {
  createControlApi,
  createUnavailableEnvironmentSecretsPort,
  createUnavailableProductSurfacePort,
  createUnavailableProviderReconciliationPort,
  createUnavailableProjectMailDomainsPort,
  type ControlApiDependencies,
  type ProjectMailDomainsPort,
} from "../src/index.js";
import {
  createProjectExports,
  ProjectExportLinkLimitError,
  ProjectExportNotReadyError,
  type ProjectExportPersistence,
} from "../src/project-exports.js";
const ORGANIZATION_ID = parseUlid("00000000000000000000000001"),
  PROJECT_ID = parseUlid("00000000000000000000000002"),
  EVENT_ID = parseUlid("00000000000000000000000003"),
  NOW = "2026-09-09T12:00:00.000Z";
const queued = { id: EVENT_ID, state: "queued", created_at: NOW, updated_at: NOW };
const status = {
  id: EVENT_ID,
  project_id: PROJECT_ID,
  state: "queued",
  requested_at: NOW,
  next_request_at: "2026-09-10T12:00:00.000Z",
  next_poll_after_seconds: 5,
  error: null,
  archive: null,
};
class Exports {
  failure: "quota" | "database" | null = null;
  async create(input: { password: string }) {
    expect(input.password).toMatch(/^test-pass-\d+$/);
    if (this.failure === "quota") throw new ProjectRecoveryDailyLimitError(status.next_request_at);
    if (this.failure === "database") throw new ProjectExportNotReadyError();
    return { status: 202 as const, body: queued, location: `/v1/operations/${EVENT_ID}` };
  }
  async get() {
    return { status: 200 as const, body: status };
  }
  refuseLinks = false;
  async issueDownloadLink() {
    if (this.refuseLinks) throw new ProjectExportLinkLimitError();
    return {
      status: 200 as const,
      body: {
        id: EVENT_ID,
        project_id: PROJECT_ID,
        download_url: "https://example.r2.cloudflarestorage.com/link",
        download_expires_at: "2026-09-10T12:00:00.000Z",
      },
    };
  }
}
it("accepts and polls Owner exports, reports the rolling-day limit and never exposes the password", async () => {
  const exports = new Exports();
  const app = createControlApi(dependencies({ projectExports: exports }));
  const url = `https://api.test/v1/projects/${PROJECT_ID}/exports`;
  const request = {
    method: "POST",
    headers: {
      Authorization: "Bearer valid",
      "Content-Type": "application/json",
      "Idempotency-Key": "sql-export",
    },
    body: JSON.stringify({ password: "test-pass-1234" }),
  };
  const accepted = await app.request(url, request);
  expect(accepted.status).toBe(202);
  expect(accepted.headers.get("Location")).toBe(`/v1/operations/${EVENT_ID}`);
  expect(await accepted.json()).toEqual(queued);
  const read = await app.request(`${url}/${EVENT_ID}`, {
    headers: { Authorization: "Bearer valid" },
  });
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual(status);
  exports.failure = "quota";
  const limited = await app.request(url, request);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBe("86400");
  expect(await limited.json()).toMatchObject({ code: "rate_limited", retry_after_seconds: 86400 });
  exports.failure = "database";
  const absent = await app.request(url, request);
  expect(absent.status).toBe(409);
  expect(await absent.json()).toMatchObject({ code: "project_export_not_ready" });
  for (const body of [
    {},
    { password: "" },
    { password: "test-pass-1234", files: true },
    { password: "x".repeat(1025) },
    { password: "€".repeat(350) },
  ])
    expect((await app.request(url, { ...request, body: JSON.stringify(body) })).status).toBe(400);
});
it("requires export passwords of at least 12 characters and never echoes a rejected one", async () => {
  const app = createControlApi(dependencies({ projectExports: new Exports() }));
  const url = `https://api.test/v1/projects/${PROJECT_ID}/exports`;
  const post = (password: string) =>
    app.request(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer valid",
        "Content-Type": "application/json",
        "Idempotency-Key": "sql-export-length",
      },
      body: JSON.stringify({ password }),
    });
  const short = await post("test-pass-1");
  expect(short.status).toBe(400);
  const rejected = await short.json();
  expect(rejected).toMatchObject({ code: "invalid_request" });
  expect(JSON.stringify(rejected)).toContain("12 characters");
  expect(JSON.stringify(rejected)).not.toContain("test-pass-1");
  expect((await post("test-pass-12")).status).toBe(202);
});
it("denies non-Owner and foreign project access and rejects malformed export projections", async () => {
  const exports = new Exports();
  const app = createControlApi(
    dependencies({
      projectExports: exports,
      authorization: {
        async check(input) {
          return input.action === "projects:read" ? "allow" : "deny";
        },
      },
    }),
  );
  const url = `https://api.test/v1/projects/${PROJECT_ID}/exports`;
  expect(
    (await app.request(`${url}/${EVENT_ID}`, { headers: { Authorization: "Bearer member" } }))
      .status,
  ).toBe(404);
  expect(
    (
      await app.request(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer member",
          "Content-Type": "application/json",
          "Idempotency-Key": "x",
        },
        body: JSON.stringify({ password: "test-pass-1234" }),
      })
    ).status,
  ).toBe(404);
  const unavailable = createControlApi(dependencies({ projectExports: undefined }));
  expect(
    (
      await unavailable.request(`${url}/${EVENT_ID}`, {
        headers: { Authorization: "Bearer valid" },
      })
    ).status,
  ).toBe(404);
  const malformed = createControlApi(
    dependencies({
      projectExports: {
        ...exports,
        create: exports.create.bind(exports),
        async get() {
          return { status: 200, body: { ...status, password: "must-not-leak" } };
        },
        issueDownloadLink: exports.issueDownloadLink.bind(exports),
      },
    }),
  );
  const response = await malformed.request(`${url}/${EVENT_ID}`, {
    headers: { Authorization: "Bearer valid" },
  });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("must-not-leak");
});
function dependencies(overrides: Partial<ControlApiDependencies> = {}): ControlApiDependencies {
  const projectMailDomains: ProjectMailDomainsPort = createUnavailableProjectMailDomainsPort();
  return {
    authentication: {
      authenticate: async () => ({
        actorId: "user:user_1",
        credentialId: "workos_session:session_1",
        authorizationPrincipal: { kind: "user", subjectId: "user:user_1" },
        organizationIds: [ORGANIZATION_ID],
      }),
    },
    authorization: { check: async () => "allow" },
    persistence: {
      submitFeedback: async () => {
        throw new Error("Unused feedback fixture");
      },
      readFeedbackStatus: async () => {
        throw new Error("Unused feedback fixture");
      },
      listProjects: async () => ({ projects: [], nextCursor: null }),
      takenProjectHandles: async () => new Set<string>(),
      createProject: async () => {
        throw new Error("unused");
      },
      getProject: async (organizationId, projectId) => ({
        dataMode: "shared" as const,
        region: "us" as const,
        organizationId,
        projectId,
        name: "fixture",
        handle: "calm-otter-waves",
        createdAt: NOW,
      }),
      getOperation: async () => null,
      readAuditEvents: async () => ({ events: [], nextCursor: null }),
    },
    productSurface: createUnavailableProductSurfacePort(),
    providerReconciliation: createUnavailableProviderReconciliationPort(),
    environmentSecrets: createUnavailableEnvironmentSecretsPort(),
    projectMailDomains,
    devAccessTickets: overrides.devAccessTickets ?? {
      issue: async () => {
        throw new Error("unused");
      },
    },
    clock: { now: () => new Date(NOW) },
    ids: { next: () => EVENT_ID },
    allowedOrigins: new Set(),
    applicationId: "control-api-test",
    rateLimits: { consume: async () => ({ allowed: true }) },
    reporter: { report: () => undefined },
    requestId: () => "req_mail_domain",
    ...overrides,
  };
}

it("answers an export GET without signing a link, and signs one link only for an audited download-link request", async () => {
  const BUCKET = "ohmyho-development-backups";
  const expiresAt = "2026-09-12T12:00:00.000Z";
  const archive = {
    bytes: 1024,
    sha256: "a".repeat(64),
    sqlFiles: ["public.sql"],
    capturedAt: NOW,
    expiresAt,
  };
  const url = `https://00000000000000000000000000000001.eu.r2.cloudflarestorage.com/${BUCKET}/snapshots/${ORGANIZATION_ID}/${PROJECT_ID}/${EVENT_ID}.zip?X-Amz-Date=20260909T120000Z&X-Amz-Expires=86400&X-Amz-Signature=${"b".repeat(64)}`;
  const signed: string[] = [];
  const audits: unknown[] = [];
  let allowLink = true;
  const persistence = {
    replay: async () => null,
    inventory: async () => ({ environments: [] }),
    accept: async () => {
      throw new Error("unused");
    },
    status: async () => ({
      state: "succeeded",
      requestedAt: NOW,
      nextRequestAt: expiresAt,
      failureCode: null,
      archive,
    }),
    recordDownloadLink: async (request: unknown) => {
      audits.push(request);
      return allowLink;
    },
  } as unknown as ProjectExportPersistence;
  const exportsPort = createProjectExports({
    key: new Uint8Array(32).fill(7),
    crypto: globalThis.crypto,
    clock: { now: () => new Date(NOW) },
    ids: { next: () => parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV") },
    archiveBucket: BUCKET,
    r2AccountId: "00000000000000000000000000000001",
    downloadBinding: {
      invokeRecovery: async (input: unknown) => {
        signed.push((input as { action: string }).action);
        return {
          status: "ready",
          operationId: EVENT_ID,
          url,
          downloadExpiresAt: "2026-09-10T12:00:00.000Z",
          archiveExpiresAt: expiresAt,
          bytes: archive.bytes,
          sha256: archive.sha256,
          sqlFiles: archive.sqlFiles,
          capturedAt: NOW,
        };
      },
    },
    persistence,
  });
  const scope = {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    principalId: "user:owner",
    requestId: "req_export",
  };

  const read = await exportsPort.get({ ...scope, operationId: EVENT_ID });
  expect(read?.body["archive"]).toMatchObject({ download_url: null, download_expires_at: null });
  expect(signed).toEqual([]);

  const link = await exportsPort.issueDownloadLink({ ...scope, operationId: EVENT_ID });
  expect(link).toEqual({
    status: 200,
    body: {
      id: EVENT_ID,
      project_id: PROJECT_ID,
      download_url: url,
      download_expires_at: "2026-09-10T12:00:00.000Z",
    },
  });
  expect(signed).toEqual(["download"]);
  expect(audits).toEqual([
    expect.objectContaining({ principalId: "user:owner", operationId: EVENT_ID }),
  ]);

  allowLink = false;
  await expect(exportsPort.issueDownloadLink({ ...scope, operationId: EVENT_ID })).rejects.toThrow(
    "Download links are limited",
  );
  expect(signed).toEqual(["download"]);
});

it("signs a download link after its container waited in the queue for 90 seconds, and that link is fresh when it is answered", async () => {
  const BUCKET = "ohmyho-development-backups";
  const archive = {
    bytes: 1024,
    sha256: "a".repeat(64),
    sqlFiles: ["public.sql"],
    capturedAt: NOW,
    expiresAt: "2026-09-12T12:00:00.000Z",
  };
  // The URL carries the instant its container signed it: the queue wait came before that instant.
  const signedUrl = (at: number) =>
    `https://00000000000000000000000000000001.eu.r2.cloudflarestorage.com/${BUCKET}/snapshots/${ORGANIZATION_ID}/${PROJECT_ID}/${EVENT_ID}.zip?X-Amz-Date=${new Date(at).toISOString().replace(/[-:]/gu, "").slice(0, 15)}Z&X-Amz-Expires=86400&X-Amz-Signature=${"b".repeat(64)}`;
  let clockMs = Date.parse(NOW);
  const persistence = {
    replay: async () => null,
    inventory: async () => ({ environments: [] }),
    accept: async () => {
      throw new Error("unused");
    },
    status: async () => ({
      state: "succeeded",
      requestedAt: NOW,
      nextRequestAt: archive.expiresAt,
      failureCode: null,
      archive,
    }),
    recordDownloadLink: async () => true,
  } as unknown as ProjectExportPersistence;
  const exportsPort = createProjectExports({
    key: new Uint8Array(32).fill(7),
    crypto: globalThis.crypto,
    clock: { now: () => new Date(clockMs) },
    ids: { next: () => parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV") },
    archiveBucket: BUCKET,
    r2AccountId: "00000000000000000000000000000001",
    downloadBinding: {
      invokeRecovery: async () => {
        clockMs += 90_000;
        const signedAt = clockMs;
        return {
          status: "ready",
          operationId: EVENT_ID,
          url: signedUrl(signedAt),
          downloadExpiresAt: new Date(signedAt + 86_400_000).toISOString(),
          archiveExpiresAt: archive.expiresAt,
          bytes: archive.bytes,
          sha256: archive.sha256,
          sqlFiles: archive.sqlFiles,
          capturedAt: NOW,
        };
      },
    },
    persistence,
  });

  const link = await exportsPort.issueDownloadLink({
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    principalId: "user:owner",
    requestId: "req_export_queued",
    operationId: EVENT_ID,
  });
  expect(link).toMatchObject({ status: 200, body: { id: EVENT_ID, project_id: PROJECT_ID } });
});

it("issues a download link only through the POST, no-store, and answers an over-limit link with 429 and a retry in a minute", async () => {
  const exports = new Exports();
  const app = createControlApi(dependencies({ projectExports: exports }));
  const url = `https://api.test/v1/projects/${PROJECT_ID}/exports/${EVENT_ID}/download-links`;
  const linked = await app.request(url, {
    method: "POST",
    headers: { Authorization: "Bearer valid" },
  });
  expect(linked.status).toBe(200);
  expect(linked.headers.get("Cache-Control")).toBe("no-store");
  expect(await linked.json()).toEqual({
    id: EVENT_ID,
    project_id: PROJECT_ID,
    download_url: "https://example.r2.cloudflarestorage.com/link",
    download_expires_at: "2026-09-10T12:00:00.000Z",
  });
  exports.refuseLinks = true;
  const refused = await app.request(url, {
    method: "POST",
    headers: { Authorization: "Bearer valid" },
  });
  expect(refused.status).toBe(429);
  expect(refused.headers.get("Retry-After")).toBe("60");
  expect(await refused.json()).toMatchObject({ code: "rate_limited" });
});
