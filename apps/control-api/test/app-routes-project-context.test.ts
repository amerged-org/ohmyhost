import { ProjectNotesConflict } from "@ohmyhost/database";
import { describe, expect, it, vi } from "vitest";

import {
  createControlApi,
  createUnavailableCloudflareDomainManagementPort,
  createUnavailableProductSurfacePort,
  createUnavailableProjectMailDomainsPort,
  type ControlApiDependencies,
} from "../src/index.js";
import type { BillingManagementPort } from "../src/billing.js";
import type { ProjectNotesPort } from "../src/project-context.js";
import { createD1DatabaseComputePort } from "../src/database-compute.js";
import {
  API,
  BEARER,
  FOREIGN_ORGANIZATION_ID,
  JSON_BEARER,
  NOW,
  ORGANIZATION_ID,
  PROJECT_ID,
  creditBalanceBody,
  creditBudgetBody,
  creditUsageBody,
  recordingReporter,
  routeDependencies,
} from "./helpers/app-routes-fixture.js";

const PROJECT = `${API}/v1/projects/${PROJECT_ID}`;
const FOREIGN_PROJECT_ID = "000000000000000000000000FF";
const STATUS = {
  project_id: PROJECT_ID,
  etag: `"sha256-${"a".repeat(64)}"`,
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
};
const NOTES = { version: 2, markdown: "Remember the launch checklist.", updatedAt: NOW };

function computeBody(environment: "dev" | "prod", projectId: string = PROJECT_ID) {
  return {
    project_id: projectId,
    environment,
    data_mode: "shared",
    observed_at: NOW,
    database: {
      provider: "pgcf",
      size_class_id: "r512-s1g",
      memory_mib: 512,
      cpu_millicores: 250,
      storage_mib: 1024,
      max_connections: 40,
      suspend_timeout_seconds: 300,
      state: "cold",
      pending_state: null,
      disabled: false,
      region: "us",
    },
  };
}

/** The real compute port over a plain binding/runtime pair, as the Worker composes it. */
function computePort(
  readCompute: (input: { environment: "dev" | "prod" }) => Promise<unknown> = async (input) =>
    computeBody(input.environment),
  readProjectComputeContext: () => Promise<unknown> = async () => ({
    provider: "pgcf",
    dataMode: "shared",
    dataEnvironmentId: "01J00000000000000000000003",
    effective: { memoryMiB: 512, sizeClassId: "r512-s1g" },
    selected: null,
    pendingChange: null,
  }),
) {
  return createD1DatabaseComputePort(
    {
      readCompute: readCompute as never,
      changeCompute: async () => {
        throw new Error("Unused compute change");
      },
      runComputeChange: async () => {
        throw new Error("Unused compute change");
      },
    },
    {
      readProjectDatabaseOperation: async () => {
        throw new Error("Unused operation read");
      },
      readProjectComputeContext: readProjectComputeContext as never,
    },
  );
}

describe("GET /v1/projects/:project_id/database/compute", () => {
  const read = (app: ReturnType<typeof createControlApi>, query = "") =>
    app.request(`${PROJECT}/database/compute${query}`, { headers: BEARER });

  it("reports the observed compute of the selected environment, Dev by default", async () => {
    const readCompute = vi.fn(async (input: { environment: "dev" | "prod" }) =>
      computeBody(input.environment),
    );
    const check = vi.fn(async () => "allow" as const);
    const app = createControlApi(
      routeDependencies({ databaseCompute: computePort(readCompute), authorization: { check } }),
    );

    const dev = await read(app);
    expect(dev.status, await dev.clone().text()).toBe(200);
    expect(dev.headers.get("Cache-Control")).toBe("no-store");
    expect(await dev.json()).toEqual(computeBody("dev"));
    expect(readCompute).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environment: "dev",
    });
    expect(check).toHaveBeenLastCalledWith(expect.objectContaining({ action: "projects:read" }));

    const prod = await read(app, "?environment=prod");
    expect(await prod.json()).toEqual(computeBody("prod"));
  });

  it("rejects an unknown environment, repeated selection or extra parameter", async () => {
    const readCompute = vi.fn(async () => computeBody("dev"));
    const app = createControlApi(routeDependencies({ databaseCompute: computePort(readCompute) }));
    for (const query of [
      "?environment=staging",
      "?environment=dev&environment=prod",
      "?environment=dev&limit=1",
    ]) {
      const response = await read(app, query);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ detail: "Select dev or prod." });
    }
    expect(readCompute).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown database and fails closed for foreign or unavailable reports", async () => {
    const { reports, reporter } = recordingReporter();
    const missing = createControlApi(
      routeDependencies({ databaseCompute: computePort(async () => null) }),
    );
    expect((await read(missing)).status).toBe(404);

    const foreign = createControlApi(
      routeDependencies({
        reporter,
        databaseCompute: computePort(async () => computeBody("dev", FOREIGN_PROJECT_ID)),
      }),
    );
    const mismatch = await read(foreign);
    expect(mismatch.status).toBe(503);
    expect(await mismatch.json()).toMatchObject({ code: "service_unavailable", retryable: true });

    const notComposed = await read(createControlApi(routeDependencies({ reporter })));
    expect(notComposed.status).toBe(503);
    expect(reports.map((entry) => entry.code)).toEqual([
      "PRODUCT_SURFACE_UNAVAILABLE",
      "PRODUCT_SURFACE_UNAVAILABLE",
    ]);
  });
});

describe("GET /v1/projects/:project_id/context", () => {
  const billingIssue = {
    code: "billing_tax_location_required",
    invoice_id: "in_123",
    required_action: "open_billing_portal",
  };
  const recharge = (overrides: Record<string, unknown> = {}) => ({
    organization_id: ORGANIZATION_ID,
    billing_issue: null,
    ...overrides,
  });

  const notesPort = (overrides: Partial<ProjectNotesPort> = {}): ProjectNotesPort => ({
    get: vi.fn(async () => NOTES),
    set: vi.fn(),
    storageJurisdiction: vi.fn(async () => "us" as const),
    ...overrides,
  });
  const creditsPort = (overrides: Partial<NonNullable<ControlApiDependencies["credits"]>> = {}) =>
    ({
      readOrganization: vi.fn(async () => creditBalanceBody() as never),
      readUsage: vi.fn(async () => creditUsageBody() as never),
      readBudget: vi.fn(async () => ({ status: 200 as const, body: creditBudgetBody() as never })),
      readAccount: vi.fn(),
      setBudget: vi.fn(),
      ...overrides,
    }) as NonNullable<ControlApiDependencies["credits"]>;
  const billingPort = (overrides: Partial<BillingManagementPort> = {}) =>
    ({
      getRecharge: vi.fn(async () => recharge() as never),
      ...overrides,
    }) as unknown as BillingManagementPort;
  const mail = {
    domain: "mail.example.com",
    status: "verification_pending" as const,
    configuredAt: NOW,
    changeId: "C12345678",
    observedAt: NOW,
    nextCheckAfterSeconds: 3600 as const,
    verificationIssue: null,
    nameServers: [
      "ns-1.awsdns-00.com",
      "ns-2.awsdns-01.net",
      "ns-3.awsdns-02.org",
      "ns-4.awsdns-03.co.uk",
    ] as const,
  };
  const domain = {
    status: "active" as const,
    suspensionReason: null,
    hostname: "app.example.com",
    environment: "prod" as const,
    cnameTarget: "customers.omh.st" as const,
    customHostnameStatus: "active",
    sslStatus: "active",
    validationRecords: [],
    url: "https://app.example.com",
  };

  /** A fully composed context; each test replaces only the port whose behavior it exercises. */
  function contextApp(overrides: Partial<ControlApiDependencies> = {}) {
    return createControlApi(
      routeDependencies({
        projectNotes: notesPort(),
        productSurface: {
          ...createUnavailableProductSurfacePort(),
          getProjectStatus: async () => ({ status: 200, body: STATUS }),
        },
        projectMailDomains: { ...createUnavailableProjectMailDomainsPort(), get: async () => mail },
        cloudflareDomains: {
          ...createUnavailableCloudflareDomainManagementPort(),
          getPaidDomain: async () => domain,
        },
        databaseCompute: computePort(),
        credits: creditsPort(),
        ...overrides,
      }),
    );
  }
  const read = async (app: ReturnType<typeof createControlApi>) => {
    const response = await app.request(`${PROJECT}/context`, { headers: BEARER });
    return { response, body: response.status === 200 ? await response.clone().json() : null };
  };
  const only = (action: string, decision: "allow" | "deny" | "unavailable") => ({
    check: async (input: { action: string }) => {
      if (input.action === action) {
        if (decision === "unavailable") throw new Error("authorization offline");
        return decision;
      }
      return "allow" as const;
    },
  });

  it("composes status, compute, domain, mail, credits and notes into one bounded document", async () => {
    const credits = creditsPort();
    const notes = notesPort();
    const billing = billingPort({
      getRecharge: vi.fn(async () => recharge({ billing_issue: billingIssue }) as never),
    });
    const { response, body } = await read(
      contextApp({ credits, projectNotes: notes, billing: billing }),
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toMatchObject({
      project_id: PROJECT_ID,
      generated_at: NOW,
      credit_access: "included",
      notes: { version: 2, markdown: "Remember the launch checklist.", updated_at: NOW },
    });
    const markdown: string = body.markdown;
    expect(markdown).toContain("Storage jurisdiction: us");
    expect(markdown).toContain("Observed database: 512 MiB RAM; 1024 MiB total storage; idle 300s");
    expect(markdown.match(/Selected memory: 512 MiB/gu)).toHaveLength(2);
    // Only the fixed PGCF sizes are rendered: no preset name and no compute-unit wording.
    expect(markdown).not.toContain("Selected preset");
    expect(markdown).not.toMatch(/ CU\b/u);
    expect(markdown).toContain("Custom domain: app.example.com (active)");
    expect(markdown).toContain("Sender: mail.example.com (verification_pending)");
    expect(markdown).toContain("Organization available: 5000000");
    expect(markdown).toContain("Project posted usage (2026-09): 600");
    expect(markdown).toContain("Project reserved: 250");
    expect(markdown).toContain("Project budget: 5000000; mode: stop");
    expect(markdown).toContain("billing\\_tax\\_location\\_required");
    expect(markdown).toContain("> Remember the launch checklist.");
    expect(markdown).toContain("Project daily charges (UTC, last 14 days): 2026-09-10 600");
    expect(credits.readUsage).toHaveBeenCalledWith(ORGANIZATION_ID, PROJECT_ID);
    expect(billing.getRecharge).toHaveBeenCalledWith({ organizationId: ORGANIZATION_ID });
  });

  it("withholds every financial read from a caller without credit access", async () => {
    const credits = creditsPort();
    const billing = billingPort();
    const { response, body } = await read(
      contextApp({
        credits,
        billing,
        authorization: only("credits:read", "deny"),
      }),
    );

    expect(response.status).toBe(200);
    expect(body.credit_access).toBe("not_authorized");
    expect(body.markdown).toContain("Credit and usage reporting is not authorized");
    expect(body.markdown).not.toContain("Organization available:");
    expect(credits.readOrganization).not.toHaveBeenCalled();
    expect(credits.readUsage).not.toHaveBeenCalled();
    expect(credits.readBudget).not.toHaveBeenCalled();
    expect(billing.getRecharge).toHaveBeenCalledOnce();

    const withoutBilling = billingPort();
    const denied = await read(
      contextApp({ billing: withoutBilling, authorization: only("billing:manage", "deny") }),
    );
    expect(denied.response.status).toBe(200);
    expect(withoutBilling.getRecharge).not.toHaveBeenCalled();
    expect(denied.body.markdown).not.toContain("Billing status unavailable");
  });

  it("falls back to explicit unavailable sections instead of failing the whole context", async () => {
    const { response, body } = await read(
      contextApp({
        projectMailDomains: {
          ...createUnavailableProjectMailDomainsPort(),
          get: async () => {
            throw new Error("mail-provider-private-canary");
          },
        },
        cloudflareDomains: {
          ...createUnavailableCloudflareDomainManagementPort(),
          getPaidDomain: async () => {
            throw new Error("provider offline");
          },
        },
        databaseCompute: computePort(
          async () => {
            throw new Error("compute offline");
          },
          async () => {
            throw new Error("configuration offline");
          },
        ),
        projectNotes: notesPort({
          storageJurisdiction: async () => {
            throw new Error("metadata unavailable");
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const markdown: string = body.markdown;
    expect(markdown).toContain("Mail verification unavailable.");
    expect(markdown).toContain("Domain status unavailable.");
    expect(markdown.match(/Compute context unavailable/gu)).toHaveLength(2);
    expect(markdown).toContain("Storage jurisdiction: unavailable");
    expect(markdown).not.toContain("private-canary");
  });

  it("shows that Dev is absent and reads compute only for the existing Prod environment", async () => {
    const reads = vi.fn(async (input: { environment: "dev" | "prod" }) =>
      computeBody(input.environment),
    );
    const prodOnly = {
      ...STATUS,
      default_environment: { id: "01K2F3G4H5J6K7M8N9P0QRSTVW", name: "prod" },
      environments: [{ id: "01K2F3G4H5J6K7M8N9P0QRSTVW", name: "prod" }],
    };
    const { response, body } = await read(
      contextApp({
        productSurface: {
          ...createUnavailableProductSurfacePort(),
          getProjectStatus: async () => ({ status: 200, body: prodOnly }),
        },
        databaseCompute: computePort(reads),
      }),
    );
    expect(response.status).toBe(200);
    expect(body.markdown).toContain("Dev URL: environment not created");
    expect(body.markdown).toContain("Dev environment: not created");
    expect(body.markdown).toContain("ohmyhost project dev add");
    expect(body.markdown).toContain("Dev environment not created; no Dev compute to read.");
    expect(body.markdown).not.toContain(
      "Compute context unavailable. Retry database_compute_get for this environment, or read REST GET /v1/projects/{project_id}/database/compute when that tool is unavailable.",
    );
    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads).toHaveBeenCalledWith(expect.objectContaining({ environment: "prod" }));
  });

  it("marks every optional port that is not composed as unavailable", async () => {
    const bare = createControlApi(
      routeDependencies({
        projectNotes: notesPort({ storageJurisdiction: async () => null }),
        productSurface: {
          ...createUnavailableProductSurfacePort(),
          getProjectStatus: async () => ({ status: 200, body: STATUS }),
        },
        credits: creditsPort(),
      }),
    );
    const { response, body } = await read(bare);
    expect(response.status).toBe(200);
    expect(body.markdown).toContain("Domain status unavailable.");
    expect(body.markdown).toContain("Compute context unavailable");
    expect(body.markdown).toContain("Storage jurisdiction: unavailable");
    expect(body.markdown).toContain("Mail verification unavailable.");
  });

  it("rejects a domain report that violates the paid-domain contract", async () => {
    const { response, body } = await read(
      contextApp({
        cloudflareDomains: {
          ...createUnavailableCloudflareDomainManagementPort(),
          getPaidDomain: async () => ({
            ...domain,
            cnameTarget: "customers.evil.example" as never,
          }),
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(body.markdown).toContain("Domain status unavailable.");
  });

  it("reports each failed financial read and shows no amounts when one of them is unavailable", async () => {
    const { reports, reporter } = recordingReporter();
    const failure = async () => {
      throw new Error("credit-database-private-canary");
    };
    for (const credits of [
      creditsPort({ readOrganization: failure }),
      creditsPort({ readUsage: failure }),
      creditsPort({ readBudget: failure }),
    ]) {
      const { response, body } = await read(contextApp({ credits, reporter }));
      expect(response.status).toBe(200);
      expect(body.credit_access).toBe("included");
      expect(body.markdown).toContain("Credit and usage reporting is temporarily unavailable.");
      expect(body.markdown).not.toContain("Organization available:");
      expect(JSON.stringify(body)).not.toContain("private-canary");
    }
    expect(reports).toEqual([
      {
        requestId: "req_fixture",
        code: "CONTEXT_CREDITS_UNAVAILABLE",
        route: "unmatched",
      },
      {
        requestId: "req_fixture",
        code: "CONTEXT_USAGE_UNAVAILABLE",
        route: "unmatched",
      },
      {
        requestId: "req_fixture",
        code: "CONTEXT_BUDGET_UNAVAILABLE",
        route: "unmatched",
      },
    ]);
  });

  it.each([
    [
      "a balance for another organization",
      { readOrganization: async () => creditBalanceBody(FOREIGN_ORGANIZATION_ID) },
    ],
    [
      "a malformed balance",
      { readOrganization: async () => ({ ...creditBalanceBody(), available_micros: "invalid" }) },
    ],
    [
      "usage for another organization",
      { readUsage: async () => creditUsageBody(FOREIGN_ORGANIZATION_ID) },
    ],
    [
      "usage of another project",
      { readUsage: async () => creditUsageBody(ORGANIZATION_ID, FOREIGN_PROJECT_ID) },
    ],
    [
      "a daily usage line of another project",
      {
        readUsage: async () => {
          const usage = creditUsageBody() as { days: { projects: { project_id: string }[] }[] };
          const [day] = usage.days;
          if (day?.projects[0]) day.projects[0].project_id = FOREIGN_PROJECT_ID;
          return usage;
        },
      },
    ],
    [
      "a malformed usage report",
      { readUsage: async () => ({ ...creditUsageBody(), unit: "credits" }) },
    ],
    [
      "a budget of another project",
      {
        readBudget: async () => ({
          status: 200 as const,
          body: creditBudgetBody(FOREIGN_PROJECT_ID),
        }),
      },
    ],
    [
      "a malformed budget",
      {
        readBudget: async () => ({
          status: 200 as const,
          body: { ...creditBudgetBody(), mode: "pause" },
        }),
      },
    ],
  ])("fails closed on %s even when another financial read is unavailable", async (_name, patch) => {
    const credits = creditsPort(patch as never);
    const response = await read(contextApp({ credits })).then((value) => value.response);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "service_unavailable" });

    const failing = creditsPort({
      ...patch,
      ...("readOrganization" in patch
        ? {
            readUsage: async () => {
              throw new Error("usage offline");
            },
          }
        : {
            readOrganization: async () => {
              throw new Error("balance offline");
            },
          }),
    } as never);
    const mixed = await read(contextApp({ credits: failing })).then((value) => value.response);
    expect(mixed.status).toBe(503);
  });

  it("requires the credit store and a reachable credit decision once access is allowed", async () => {
    const withoutStore = await read(contextApp({ credits: undefined }));
    expect(withoutStore.response.status).toBe(503);
    const outage = await read(contextApp({ authorization: only("credits:read", "unavailable") }));
    expect(outage.response.status).toBe(503);
  });

  it("shows a billing problem as unavailable when the billing read fails or answers for another scope", async () => {
    const rejected = await read(
      contextApp({
        billing: billingPort({
          getRecharge: async () => {
            throw new Error("billing offline");
          },
        }),
      }),
    );
    expect(rejected.body.markdown).toContain("Billing status unavailable.");
    const foreign = await read(
      contextApp({
        billing: billingPort({
          getRecharge: async () => recharge({ organization_id: FOREIGN_ORGANIZATION_ID }) as never,
        }),
      }),
    );
    expect(foreign.body.markdown).toContain("Billing status unavailable.");
    const clean = await read(contextApp({ billing: billingPort() }));
    expect(clean.body.markdown).not.toContain("Billing issue:");
    expect(clean.body.markdown).not.toContain("Billing status unavailable");
  });

  it("hides the context of a project without notes, status or the required ports", async () => {
    expect(
      (await read(contextApp({ projectNotes: notesPort({ get: async () => null }) }))).response
        .status,
    ).toBe(404);
    expect(
      (
        await read(
          contextApp({
            productSurface: {
              ...createUnavailableProductSurfacePort(),
              getProjectStatus: async () => null,
            },
          }),
        )
      ).response.status,
    ).toBe(404);
    expect(
      (
        await read(
          contextApp({
            productSurface: {
              ...createUnavailableProductSurfacePort(),
              getProjectStatus: async () => ({
                status: 200,
                body: { ...STATUS, project_id: FOREIGN_PROJECT_ID },
              }),
            },
          }),
        )
      ).response.status,
    ).toBe(503);
    expect((await read(contextApp({ projectNotes: undefined }))).response.status).toBe(503);
    expect(
      (
        await read(
          contextApp({
            projectNotes: notesPort({
              get: vi.fn().mockResolvedValueOnce(NOTES).mockResolvedValue(null),
            }),
          }),
        )
      ).response.status,
    ).toBe(404);
  });
});

describe("PUT /v1/projects/:project_id/context/notes", () => {
  const put = (
    app: ReturnType<typeof createControlApi>,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(`${PROJECT}/context/notes`, {
      method: "PUT",
      headers: { ...JSON_BEARER, "Idempotency-Key": "notes-1", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const app = (
    notes: Partial<ProjectNotesPort> = {},
    overrides: Partial<ControlApiDependencies> = {},
  ) =>
    createControlApi(
      routeDependencies({
        projectNotes: {
          get: async () => NOTES,
          storageJurisdiction: async () => "us",
          set: async () => ({ version: 3, updatedAt: NOW }),
          ...notes,
        },
        ...overrides,
      }),
    );

  it("stores normalized notes against the version the caller read and returns the receipt", async () => {
    const set = vi.fn(async () => ({ version: 3, updatedAt: NOW }));
    const response = await put(app({ set }), {
      expected_version: 2,
      markdown: "Line one\r\nLine two",
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ version: 3, updated_at: NOW });
    expect(set).toHaveBeenCalledWith({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      principalId: "user:user_1",
      requestId: "req_fixture",
      idempotencyKey: "notes-1",
      canonicalRequestDigest: expect.any(Uint8Array),
      markdown: "Line one\nLine two",
      expectedVersion: 2,
    });
  });

  it.each([
    ["an unknown field", { expected_version: 0, markdown: "x", owner: "me" }],
    ["a missing version", { markdown: "x" }],
    ["a negative version", { expected_version: -1, markdown: "x" }],
    ["a fractional version", { expected_version: 1.5, markdown: "x" }],
    ["a version at the integer limit", { expected_version: 2147483647, markdown: "x" }],
    ["non-text notes", { expected_version: 0, markdown: 7 }],
    [
      "notes with a credential",
      { expected_version: 0, markdown: "API_TOKEN=" + "abcdefgh12345678" },
    ],
    ["notes over the size limit", { expected_version: 0, markdown: "x".repeat(16385) }],
  ])("refuses %s before storing anything", async (_name, body) => {
    const set = vi.fn(async () => ({ version: 1, updatedAt: NOW }));
    const response = await put(app({ set }), body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ detail: "Request fields are invalid." });
    expect(set).not.toHaveBeenCalled();
  });

  it("requires an Idempotency-Key and the notes port", async () => {
    const set = vi.fn(async () => ({ version: 1, updatedAt: NOW }));
    const missing = await put(
      app({ set }),
      { expected_version: 0, markdown: "x" },
      {
        "Idempotency-Key": "",
      },
    );
    expect(missing.status).toBe(400);
    expect(set).not.toHaveBeenCalled();
    const notComposed = await put(createControlApi(routeDependencies()), {
      expected_version: 0,
      markdown: "x",
    });
    expect(notComposed.status).toBe(503);
  });

  it("maps note conflicts and refuses an invalid receipt", async () => {
    const conflict = (kind: "scope" | "idempotency" | "version") =>
      app({
        set: async () => {
          throw new ProjectNotesConflict(kind);
        },
      });
    const request = { expected_version: 2, markdown: "x" };
    expect((await put(conflict("scope"), request)).status).toBe(404);
    const reused = await put(conflict("idempotency"), request);
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ code: "idempotency_key_reused" });
    const stale = await put(conflict("version"), request);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "project_notes_conflict" });
    const zero = await put(app({ set: async () => ({ version: 0, updatedAt: NOW }) }), request);
    expect(zero.status).toBe(503);
  });

  it("does not let a caller without write permission change the notes", async () => {
    const set = vi.fn(async () => ({ version: 3, updatedAt: NOW }));
    const denied = await put(app({ set }, { authorization: { check: async () => "deny" } }), {
      expected_version: 2,
      markdown: "x",
    });
    expect(denied.status).toBe(404);
    expect(set).not.toHaveBeenCalled();
  });
});
