import { describe, expect, it, vi } from "vitest";
import { createEnvironmentSecretCipherKeyring } from "../src/environment-secret-cipher.js";
import { createPreviewSurface } from "../src/preview-surface.js";
import type { PreviewCustomerRecord, ProductApiPreviewRuntime } from "@ohmyhost/contracts/previews";
import { createControlApi } from "../src/app.js";
import { API, BEARER, PROJECT_ID, routeDependencies } from "./helpers/app-routes-fixture.js";

const organizationId = "01J00000000000000000000001";
const projectId = "01J00000000000000000000002";
const environmentId = "01J00000000000000000000003";
const previewId = "01J00000000000000000000004";
const scope = {
  organizationId,
  projectId,
  environment: "prod" as const,
  principalId: "user:owner",
};
const record = {
  previewId,
  organizationId,
  projectId,
  environment: "prod",
  environmentId,
  dataEnvironmentId: environmentId,
  assignmentVersion: 1,
  billingEpochId: organizationId,
  ownershipVersion: 1,
  lifecycleVersion: 1,
  region: "eu",
  rowVersion: 1,
  runtimeGeneration: 1,
  tokenGeneration: 1,
  authGeneration: 1,
  state: "sleeping",
  targetSource: null,
  appliedSource: null,
  lastActivityAt: "2026-11-16T00:00:00.000Z",
  paidUntil: null,
  retirement: "none",
} as const;

describe("private preview capability", () => {
  it("returns the same sealed URL on reads and closes old connections before rotation succeeds", async () => {
    let stored: PreviewCustomerRecord | null = null;
    const serialized: string[] = [];
    const events: string[] = [];
    const core: ProductApiPreviewRuntime = {
      prepare: async (value) => {
        expect(value).toEqual(scope);
        return { environmentId, preview: stored };
      },
      get: async () => stored,
      listProjectPendingSources: async () => [],
      readGithubCandidates: async () => [],
      acceptGithubSource: async () => {
        throw new Error("unused");
      },
      readInitialGithubCandidate: async () => null,
      acceptInitialGithubSource: async () => {
        throw new Error("unused");
      },
      ensure: async (value) => {
        serialized.push(JSON.stringify(value));
        stored = { preview: record, capability: value.capability };
        return stored;
      },
      rotate: async (value) => {
        serialized.push(JSON.stringify(value));
        stored = {
          preview: { ...record, rowVersion: 2, tokenGeneration: 2, retirement: "rotating" },
          capability: value.capability,
        };
        return stored;
      },
      confirmRotation: async () => {
        events.push("confirm");
        if (!stored) throw new Error("rotating preview missing");
        stored = { ...stored, preview: { ...stored.preview, retirement: "none" } };
      },
      destroy: async () => {
        throw new Error("unused");
      },
      confirmDestroy: async () => {
        throw new Error("unused");
      },
    };
    const cipher = createEnvironmentSecretCipherKeyring({
      primaryKeyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      currentKeyVersion: 1,
      crypto,
    });
    const surface = createPreviewSurface({
      core,
      cipher,
      ids: { next: () => previewId as never },
      hostSuffix: "preview.dev.omh.st",
      runtime: {
        fence: async () => {
          events.push("fence");
        },
      },
    });
    const first = await surface.open(scope);
    if (!first) throw new Error("initial preview missing");
    expect(first?.url).toMatch(/^https:\/\/[a-z2-7]{51}[aq]\.preview\.dev\.omh\.st$/u);
    expect((await surface.get(scope))?.url).toBe(first?.url);
    const rotated = await surface.rotate(scope, "request-1");
    if (!rotated) throw new Error("rotated preview missing");
    expect(rotated?.url).not.toBe(first?.url);
    expect(events).toEqual(["fence", "confirm"]);
    expect(serialized.join(" ")).not.toContain(new URL(first.url).hostname.split(".")[0]);
    expect(serialized.join(" ")).not.toContain(new URL(rotated.url).hostname.split(".")[0]);
  });

  it("returns no capability when Core denies the concrete project", async () => {
    const core = { get: async () => null } as unknown as ProductApiPreviewRuntime;
    const cipher = createEnvironmentSecretCipherKeyring({
      primaryKeyBase64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      currentKeyVersion: 1,
      crypto,
    });
    const surface = createPreviewSurface({
      core,
      cipher,
      ids: { next: () => previewId as never },
      hostSuffix: "preview.dev.omh.st",
      runtime: { fence: async () => {} },
    });
    expect(await surface.get({ ...scope, projectId: "01J00000000000000000000005" })).toBeNull();
  });

  it("requires explicit environment and rejects a foreign project before calling the preview port", async () => {
    const get = vi.fn(async () => null);
    const previews = { get } as unknown as import("../src/preview-surface.js").PreviewSurface;
    const url = `${API}/v1/projects/${PROJECT_ID}/preview`;
    const app = createControlApi(routeDependencies({ previews }));
    expect((await app.request(url, { headers: BEARER })).status).toBe(400);
    const denied = createControlApi(
      routeDependencies({ previews, authorization: { check: async () => "deny" } }),
    );
    expect((await denied.request(`${url}?environment=prod`, { headers: BEARER })).status).toBe(404);
    expect(get).not.toHaveBeenCalled();
    const readerOnly = createControlApi(
      routeDependencies({
        previews,
        authorization: {
          check: async (input) => (input.action === "projects:read" ? "allow" : "deny"),
        },
      }),
    );
    for (const method of ["GET", "POST"])
      expect(
        (await readerOnly.request(`${url}?environment=prod`, { method, headers: BEARER })).status,
      ).toBe(404);
    expect(get).not.toHaveBeenCalled();
    const conflict = createControlApi(
      routeDependencies({
        previews: {
          ...previews,
          rotate: async () => {
            throw new Error("preview_version_conflict");
          },
        },
      }),
    );
    const response = await conflict.request(`${url}/token?environment=prod`, {
      method: "POST",
      headers: { ...BEARER, "Idempotency-Key": "same-rotation" },
    });
    expect(response.status, await response.clone().text()).toBe(409);
    expect((await response.json()).code).toBe("preview_version_conflict");
  });
});
