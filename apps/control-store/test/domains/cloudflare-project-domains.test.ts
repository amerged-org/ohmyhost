import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControlStore } from "../../src/store.js";
import { seedDeletionIntent } from "../support/accepted-operation.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  bytes,
  beforeFirstWrite,
  losingWriteResponses,
  seedProject,
  ulidOf,
  STORED_NOW,
  freezeOwnership,
  type SeededProject,
} from "../support/platform-fixtures.js";

let control: TestControl;
let store: ReturnType<typeof createControlStore>;
beforeAll(async () => {
  control = await createTestControl(2);
  store = createControlStore(control.bindings);
}, 120_000);
afterAll(async () => control?.dispose());

let sequence = 0;
const claimInput = (project: SeededProject, overrides: Record<string, unknown> = {}) => {
  sequence += 1;
  return {
    organizationId: project.organizationId,
    projectId: project.projectId,
    platform: "production",
    proposedOperationId: ulidOf("domain-op", sequence),
    principalId: "user:owner",
    idempotencyKeySha256: bytes(32, 0x11),
    requestSha256: bytes(32, 0x22),
    configuredAt: "2026-10-28T10:00:00.000Z",
    ...overrides,
  };
};

const directoryRows = async (domain: string) =>
  (
    await control.directory
      .prepare(
        "SELECT class, state, organization_id, project_id, claim_id, expires_at FROM domain_directory WHERE domain = ? ORDER BY class",
      )
      .bind(domain)
      .all<{ class: string; state: string; organization_id: string; claim_id: string | null }>()
  ).results;

describe("domains.claimCloudflareProjectDomainsOperation (reservation saga)", () => {
  it("reserves, writes the shard row and confirms both names; a replay answers existing without a second row", async () => {
    const project = await seedProject(control);
    const input = claimInput(project);
    const created = await store.domains.claimCloudflareProjectDomainsOperation(input);
    expect(created).toMatchObject({
      outcome: "created",
      domains: {
        productionDomain: `${project.handle}.check.omh.st`,
        developmentDomain: `dev-${project.handle}.check.omh.st`,
        operationId: input.proposedOperationId,
        deletedAt: null,
      },
    });
    const prod = await directoryRows(`${project.handle}.check.omh.st`);
    expect(prod).toEqual([
      expect.objectContaining({
        class: "app_prod",
        state: "active",
        organization_id: project.organizationId,
        claim_id: `${input.proposedOperationId}:${project.handle}`,
        expires_at: null,
      }),
    ]);
    expect((await directoryRows(`dev-${project.handle}.check.omh.st`))[0]?.state).toBe("active");
    const replay = await store.domains.claimCloudflareProjectDomainsOperation(claimInput(project));
    expect(replay).toMatchObject({
      outcome: "existing",
      domains: { operationId: input.proposedOperationId },
    });
    expect(
      (
        await project.shard
          .prepare("SELECT count(*) AS n FROM cloudflare_project_domains WHERE organization_id = ?")
          .bind(project.organizationId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(
      await store.domains.readCloudflareProjectDomains({
        organizationId: project.organizationId,
        projectId: project.projectId,
      }),
    ).toMatchObject({ handle: project.handle, mailDomain: null });
  });

  it("separates the development platform root and keeps each name with its own class", async () => {
    const project = await seedProject(control);
    const created = await store.domains.putCloudflareProjectDomains({
      organizationId: project.organizationId,
      projectId: project.projectId,
      platform: "development",
      operationId: ulidOf("domain-op", 900),
      principalId: "user:owner",
      idempotencyKeySha256: bytes(32, 0x12),
      requestSha256: bytes(32, 0x23),
      configuredAt: "2026-10-28T10:00:00.000Z",
    });
    expect(created?.productionDomain).toBe(`${project.handle}.dev.check.omh.st`);
    expect((await directoryRows(`${project.handle}.dev.check.omh.st`))[0]?.class).toBe("app_prod");
  });

  it("refuses a name held by another owner without writing the shard row or adopting the claim", async () => {
    const project = await seedProject(control);
    const other = await seedProject(control);
    const foreign = `${project.handle}.check.omh.st`;
    await control.directory
      .prepare(
        "INSERT INTO domain_directory(class, domain, organization_id, project_id, updated_at) VALUES ('app_prod', ?, ?, ?, ?)",
      )
      .bind(foreign, other.organizationId, other.projectId, STORED_NOW)
      .run();
    await expect(
      store.domains.claimCloudflareProjectDomainsOperation(claimInput(project)),
    ).rejects.toMatchObject({ code: "domain_taken" });
    expect(await directoryRows(foreign)).toEqual([
      expect.objectContaining({ organization_id: other.organizationId, state: "active" }),
    ]);
    expect(
      await store.domains.readCloudflareProjectDomains({
        organizationId: project.organizationId,
        projectId: project.projectId,
      }),
    ).toBeNull();
  });

  it("answers unavailable for another key, conflicts for the same key with another request, and null for an inactive project", async () => {
    const project = await seedProject(control);
    await store.domains.claimCloudflareProjectDomainsOperation(claimInput(project));
    expect(
      await store.domains.claimCloudflareProjectDomainsOperation(
        claimInput(project, { idempotencyKeySha256: bytes(32, 0x99) }),
      ),
    ).toBeNull();
    await expect(
      store.domains.claimCloudflareProjectDomainsOperation(
        claimInput(project, { requestSha256: bytes(32, 0x98) }),
      ),
    ).rejects.toMatchObject({ code: "cloudflare_project_domain_conflict" });
    await expect(
      store.domains.readCloudflareProjectDomainsByIdempotency({
        organizationId: project.organizationId,
        projectId: project.projectId,
        principalId: "user:someone-else",
        idempotencyKeySha256: bytes(32, 0x11),
        requestSha256: bytes(32, 0x22),
      }),
    ).rejects.toMatchObject({ code: "cloudflare_project_domain_conflict" });
    const frozen = await seedProject(control);
    await freezeOwnership(frozen);
    expect(
      await store.domains.claimCloudflareProjectDomainsOperation(claimInput(frozen)),
    ).toBeNull();
    expect(await directoryRows(`${frozen.handle}.check.omh.st`)).toEqual([]);
  });

  it("never reads another organization's domains or operation", async () => {
    const project = await seedProject(control);
    const other = await seedProject(control, { shard: 1 });
    const created = await store.domains.claimCloudflareProjectDomainsOperation(claimInput(project));
    expect(
      await store.domains.readCloudflareProjectDomains({
        organizationId: other.organizationId,
        projectId: project.projectId,
      }),
    ).toBeNull();
    expect(
      await store.domains.readCloudflareProjectDomainsForOperation({
        organizationId: project.organizationId,
        projectId: project.projectId,
        operationId: ulidOf("domain-op", 777),
      }),
    ).toBeNull();
    expect(
      await store.domains.readCloudflareProjectDomainsForOperation({
        organizationId: project.organizationId,
        projectId: project.projectId,
        operationId: created?.domains.operationId,
      }),
    ).toMatchObject({ handle: project.handle });
  });

  it("applies a committed claim once when the shard response is lost and the command is re-sent", async () => {
    const project = await seedProject(control);
    const flaky = createControlStore({ CONTROL_CORE: losingWriteResponses(control.core, 1) });
    const created = await flaky.domains.claimCloudflareProjectDomainsOperation(claimInput(project));
    expect(created?.domains.handle).toBe(project.handle);
    expect((await directoryRows(`${project.handle}.check.omh.st`))[0]?.state).toBe("active");
  });
});

describe("domain reservation sweep", () => {
  const reserve = async (
    project: SeededProject,
    domain: string,
    domainClass: string,
    claimId: string,
    expiresAt: string,
  ) =>
    control.directory
      .prepare(
        "INSERT INTO domain_directory(class, domain, organization_id, project_id, updated_at, state, claim_id, expires_at) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)",
      )
      .bind(
        domainClass,
        domain,
        project.organizationId,
        project.projectId,
        STORED_NOW,
        claimId,
        expiresAt,
      )
      .run();

  it("releases a reservation whose command died before its shard write, confirms one that died after it, and leaves live ones", async () => {
    const dead = await seedProject(control);
    const written = await seedProject(control);
    const live = await seedProject(control);
    const deadName = `${dead.handle}.check.omh.st`;
    const writtenName = `${written.handle}.check.omh.st`;
    const liveName = `${live.handle}.check.omh.st`;
    const past = "2026-10-28T09:00:00.000000Z";
    await reserve(dead, deadName, "app_prod", "claim-dead", past);
    await reserve(written, writtenName, "app_prod", "claim-written", past);
    await reserve(live, liveName, "app_prod", "claim-live", "2026-10-28T11:00:00.000000Z");
    await written.shard
      .prepare(
        "INSERT INTO cloudflare_project_domains(organization_id, project_id, operation_id, handle, zone_name, production_domain, development_domain, configured_by_principal_id, idempotency_key_sha256, request_sha256, configured_at) VALUES (?1, ?2, ?3, ?4, 'omh.st', ?5, ?6, 'user:owner', ?7, ?8, ?9)",
      )
      .bind(
        written.organizationId,
        written.projectId,
        ulidOf("domain-op", 5000),
        written.handle,
        writtenName,
        `dev-${written.handle}.check.omh.st`,
        bytes(32, 1),
        bytes(32, 2),
        STORED_NOW,
      )
      .run();
    expect(
      await store.maintenance.settleDomainReservations({ now: "2026-10-28T10:00:00.000Z" }),
    ).toEqual({ confirmed: 1, released: 1 });
    expect(await directoryRows(deadName)).toEqual([]);
    expect(await directoryRows(writtenName)).toEqual([
      expect.objectContaining({ state: "active", expires_at: null }),
    ]);
    expect((await directoryRows(liveName))[0]?.state).toBe("reserved");
    // The same project can now claim the freed name again, and a confirmed claim is never swept.
    expect(
      await store.maintenance.settleDomainReservations({ now: "2026-10-29T10:00:00.000Z" }),
    ).toEqual({ confirmed: 0, released: 1 });
  });

  it("releases a paid hostname reservation whose connection was displaced, so the name is not held for the displaced owner", async () => {
    const displaced = await seedProject(control);
    const hostname = "shop.displaced-reservation.example";
    await reserve(
      displaced,
      hostname,
      "paid_hostname",
      "claim-displaced",
      "2026-10-28T09:00:00.000000Z",
    );
    await displaced.shard
      .prepare(
        "INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,created_at,updated_at) VALUES(?1,?2,?3,NULL,'displaced','user:owner',?4,?5,?6,?6)",
      )
      .bind(
        displaced.organizationId,
        displaced.projectId,
        hostname,
        bytes(32, 0x31),
        bytes(32, 0x32),
        STORED_NOW,
      )
      .run();
    await store.maintenance.settleDomainReservations({ now: "2026-10-28T10:00:00.000Z" });
    expect(await directoryRows(hostname)).toEqual([]);
  });

  it("loses the names to another owner that commits while the creator is stalled: domain_taken, nothing of the creator remains", async () => {
    const project = await seedProject(control);
    const other = await seedProject(control);
    const prod = `${project.handle}.check.omh.st`;
    const dev = `dev-${project.handle}.check.omh.st`;
    const racing = createControlStore({
      CONTROL_CORE: beforeFirstWrite(control.core, async () => {
        // The creator read its snapshot (both names free) and now stalls; the other owner claims both names.
        expect(await directoryRows(prod)).toEqual([]);
        for (const [domainClass, domain] of [
          ["app_prod", prod],
          ["app_dev", dev],
        ] as const) {
          await control.directory
            .prepare(
              "INSERT INTO domain_directory(class, domain, organization_id, project_id, updated_at) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(domainClass, domain, other.organizationId, other.projectId, STORED_NOW)
            .run();
        }
      }),
    });
    // The batch's own guard aborts it (no half claim), the command re-reads and refuses.
    await expect(
      racing.domains.claimCloudflareProjectDomainsOperation(claimInput(project)),
    ).rejects.toMatchObject({ code: "domain_taken" });
    expect(
      await project.shard
        .prepare("SELECT count(*) AS n FROM cloudflare_project_domains WHERE organization_id = ?")
        .bind(project.organizationId)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
    for (const domain of [prod, dev]) {
      expect(await directoryRows(domain)).toEqual([
        expect.objectContaining({ organization_id: other.organizationId, state: "active" }),
      ]);
    }
  });

  it("claims the names again, with a fresh claim, when the sweep closes the older reservation while the creator is stalled", async () => {
    const project = await seedProject(control);
    const prod = `${project.handle}.check.omh.st`;
    const dev = `dev-${project.handle}.check.omh.st`;
    // A reservation an older (pre-atomic) command left on both names, past its expiry.
    for (const [domainClass, domain] of [
      ["app_prod", prod],
      ["app_dev", dev],
    ] as const) {
      await reserve(project, domain, domainClass, "claim-legacy", "2026-10-28T09:00:00.000000Z");
    }
    const racing = createControlStore({
      CONTROL_CORE: beforeFirstWrite(control.core, async () => {
        expect(
          await store.maintenance.settleDomainReservations({ now: "2026-10-28T10:30:00.000Z" }),
        ).toMatchObject({ released: 2 });
      }),
    });
    // The tombstone of the closed legacy claim fences the first batch; the re-read finds the names free.
    const claimed = await racing.domains.claimCloudflareProjectDomainsOperation(
      claimInput(project),
    );
    expect(claimed?.outcome).toBe("created");
    for (const domain of [prod, dev]) {
      expect(await directoryRows(domain)).toEqual([
        expect.objectContaining({ organization_id: project.organizationId, state: "active" }),
      ]);
    }
  });

  it("refuses to confirm a name whose reservation was closed by the sweep for the claim that still holds it", async () => {
    const project = await seedProject(control);
    const input = claimInput(project);
    const prod = `${project.handle}.check.omh.st`;
    // The sweep closed the reservation's claim but its row was re-created by the same owner with that claim id.
    await reserve(project, prod, "app_prod", "claim-closed", "2026-10-28T11:00:00.000000Z");
    await control.core
      .prepare(
        "INSERT INTO domain_claim_aborts(class, domain, organization_id, claim_id, aborted_at) VALUES ('app_prod', ?, ?, 'claim-closed', ?)",
      )
      .bind(prod, project.organizationId, STORED_NOW)
      .run();
    await expect(store.domains.claimCloudflareProjectDomainsOperation(input)).rejects.toMatchObject(
      { code: "domain_reservation_expired" },
    );
    expect(
      await project.shard
        .prepare("SELECT count(*) AS n FROM cloudflare_project_domains WHERE organization_id = ?")
        .bind(project.organizationId)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it("leaves no Directory claim of either name when the domains row, the last statement, fails", async () => {
    const project = await seedProject(control);
    const prod = `${project.handle}.check.omh.st`;
    const dev = `dev-${project.handle}.check.omh.st`;
    await control.core
      .prepare(
        "CREATE TRIGGER late_domains_row BEFORE INSERT ON cloudflare_project_domains BEGIN SELECT RAISE(ABORT, 'late failure'); END",
      )
      .run();
    await expect(
      store.domains.claimCloudflareProjectDomainsOperation(claimInput(project)),
    ).rejects.toThrow();
    // the former saga reserved both names first and confirmed them after: now neither is ever visible
    expect(await directoryRows(prod)).toEqual([]);
    expect(await directoryRows(dev)).toEqual([]);
    await control.core.prepare("DROP TRIGGER late_domains_row").run();
    expect(
      (await store.domains.claimCloudflareProjectDomainsOperation(claimInput(project)))?.outcome,
    ).toBe("created");
    expect((await directoryRows(prod))[0]).toMatchObject({ state: "active" });
  });

  it("closes a claim for good: the same operation cannot reserve again, a new operation can", async () => {
    const project = await seedProject(control);
    const input = claimInput(project);
    const claimId = `${input.proposedOperationId}:${project.handle}`;
    for (const [domainClass, domain] of [
      ["app_prod", `${project.handle}.check.omh.st`],
      ["app_dev", `dev-${project.handle}.check.omh.st`],
    ] as const) {
      await control.directory
        .prepare(
          "INSERT INTO domain_directory(class, domain, organization_id, project_id, updated_at, state, claim_id, expires_at) VALUES (?, ?, ?, ?, ?, 'reserved', ?, '2026-10-28T09:00:00.000000Z')",
        )
        .bind(domainClass, domain, project.organizationId, project.projectId, STORED_NOW, claimId)
        .run();
    }
    expect(
      await store.maintenance.settleDomainReservations({ now: "2026-10-28T10:00:00.000Z" }),
    ).toMatchObject({ released: 2 });
    await expect(store.domains.claimCloudflareProjectDomainsOperation(input)).rejects.toMatchObject(
      { code: "domain_reservation_expired" },
    );
    expect(await directoryRows(`${project.handle}.check.omh.st`)).toEqual([]);
    expect(
      await store.domains.claimCloudflareProjectDomainsOperation(claimInput(project)),
    ).toMatchObject({ outcome: "created" });
  });

  it("refuses a second operation of the same owner while the held reservation is already closed", async () => {
    const project = await seedProject(control);
    const closedClaim = "closed-operation:" + project.handle;
    const prod = `${project.handle}.check.omh.st`;
    await control.directory
      .prepare(
        "INSERT INTO domain_directory(class, domain, organization_id, project_id, updated_at, state, claim_id, expires_at) VALUES ('app_prod', ?, ?, ?, ?, 'reserved', ?, '2026-10-28T09:00:00.000000Z')",
      )
      .bind(prod, project.organizationId, project.projectId, STORED_NOW, closedClaim)
      .run();
    // The sweep wrote the tombstone but has not removed the directory row yet.
    await project.shard
      .prepare(
        "INSERT INTO domain_claim_aborts(class, domain, organization_id, claim_id, aborted_at) VALUES ('app_prod', ?, ?, ?, ?)",
      )
      .bind(prod, project.organizationId, closedClaim, STORED_NOW)
      .run();
    await expect(
      store.domains.claimCloudflareProjectDomainsOperation(claimInput(project)),
    ).rejects.toMatchObject({ code: "domain_reservation_expired" });
    expect(
      await project.shard
        .prepare("SELECT count(*) AS n FROM cloudflare_project_domains WHERE organization_id = ?")
        .bind(project.organizationId)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it("lets a crashed claim resume: the retry extends its own reservation and ends confirmed", async () => {
    const project = await seedProject(control);
    const name = `${project.handle}.check.omh.st`;
    await reserve(project, name, "app_prod", "claim-crashed", "2026-10-28T09:00:00.000000Z");
    await reserve(
      project,
      `dev-${project.handle}.check.omh.st`,
      "app_dev",
      "claim-crashed",
      "2026-10-28T09:00:00.000000Z",
    );
    const resumed = await store.domains.claimCloudflareProjectDomainsOperation(claimInput(project));
    expect(resumed?.outcome).toBe("created");
    expect(await directoryRows(name)).toEqual([
      expect.objectContaining({ state: "active", claim_id: "claim-crashed", expires_at: null }),
    ]);
  });
});

const hex32 = (digit: string) => digit.repeat(32);
let receiptNumber = 0;
const receipt = (project: SeededProject, extra: Record<string, unknown>) => {
  receiptNumber += 1;
  return {
    organizationId: project.organizationId,
    projectId: project.projectId,
    receiptId: ulidOf("receipt", receiptNumber),
    observedAt: `2026-10-28T10:00:0${receiptNumber % 10}.000Z`,
    ...extra,
  };
};
const customHostname = (project: SeededProject, environmentName: "dev" | "prod", id: string) =>
  receipt(project, {
    kind: "custom_hostname",
    providerResourceId: hex32(id),
    environmentName,
    hostname:
      environmentName === "prod"
        ? `${project.handle}.check.omh.st`
        : `dev-${project.handle}.check.omh.st`,
    status: "pending",
    providerCreatedAt: "2026-10-28T09:59:00.000Z",
    ownershipVerification: null,
    ownershipVerificationHttp: null,
    verificationErrors: [],
  });

describe("domains receipts and project deletion", () => {
  const configure = async (project: SeededProject) => {
    await store.domains.claimCloudflareProjectDomainsOperation(claimInput(project));
  };
  const scope = (project: SeededProject) => ({
    organizationId: project.organizationId,
    projectId: project.projectId,
  });

  /** The accepted deletion of the project: it is `deleting` and a running operation holds the deletion intent. */
  const startDeletion = async (project: SeededProject, operationId: string) => {
    await project.shard.batch([
      project.shard
        .prepare(
          "UPDATE projects SET lifecycle_state = 'deleting' WHERE organization_id = ? AND project_id = ?",
        )
        .bind(project.organizationId, project.projectId),
      project.shard
        .prepare(
          "INSERT INTO operations(organization_id, operation_id, project_id, state, billing_epoch_id, created_at, updated_at) VALUES (?1, ?2, ?3, 'running', ?4, ?5, ?5)",
        )
        .bind(
          project.organizationId,
          operationId,
          project.projectId,
          project.billingEpochId,
          STORED_NOW,
        ),
    ]);
    await seedDeletionIntent(project, project.prodEnvironmentId, operationId);
  };

  it("appends provider observations, replays an identical receipt and rejects a changed one or a foreign name", async () => {
    const project = await seedProject(control);
    // No domain configuration yet: the receipt must not attach.
    const other = await seedProject(control);
    await expect(
      store.domains.putCloudflareProjectDomainReceipt(customHostname(other, "prod", "b")),
    ).rejects.toMatchObject({ code: "cloudflare_project_domain_conflict" });
    await configure(project);
    const first = customHostname(project, "prod", "a");
    expect(await store.domains.putCloudflareProjectDomainReceipt(first)).toBe("created");
    expect(await store.domains.putCloudflareProjectDomainReceipt(first)).toBe("existing");
    for (const change of [
      { providerResourceId: hex32("f") },
      { observedAt: "2026-10-28T12:00:01.000Z" },
      { ...scope(other) },
    ])
      await expect(
        store.domains.putCloudflareProjectDomainReceipt({ ...first, ...change }),
      ).rejects.toMatchObject({ code: "cloudflare_project_domain_conflict" });
    await expect(
      store.domains.putCloudflareProjectDomainReceipt({ ...first, status: "active" }),
    ).rejects.toMatchObject({ code: "cloudflare_project_domain_conflict" });
    await expect(
      store.domains.putCloudflareProjectDomainReceipt({
        ...customHostname(project, "prod", "c"),
        hostname: "stolen.check.omh.st",
      }),
    ).rejects.toMatchObject({ code: "cloudflare_project_domain_conflict" });
    await expect(
      store.domains.putCloudflareProjectDomainReceipt(
        receipt(project, {
          kind: "worker_route",
          providerResourceId: hex32("d"),
          environmentName: "prod",
          zoneId: hex32("e"),
          pattern: `${project.handle}.check.omh.st/*`,
          script: "some-other-script",
        }),
      ),
    ).rejects.toMatchObject({ code: "cloudflare_project_domain_conflict" });
    expect(
      await store.domains.putCloudflareProjectDomainReceipt(
        receipt(project, {
          kind: "worker_route",
          providerResourceId: hex32("d"),
          environmentName: "prod",
          zoneId: hex32("e"),
          pattern: `${project.handle}.check.omh.st/*`,
          script: "ohmyho-gateway-production",
        }),
      ),
    ).toBe("created");
    const listed = await store.domains.readCloudflareProjectDomainReceipts(scope(project));
    expect(listed.map((item) => item.kind).sort()).toEqual(["custom_hostname", "worker_route"]);
    expect(listed.find((item) => item.kind === "custom_hostname")).toMatchObject({
      providerCreatedAt: "2026-10-28T09:59:00.000Z",
      verificationErrors: [],
    });
    expect(await store.domains.readCloudflareProjectDomainReceipts(scope(other))).toEqual([]);
  });

  it("requires the custom hostname receipt before an SSL receipt and refuses an NS record without a declared mail domain", async () => {
    const project = await seedProject(control);
    await configure(project);
    const ssl = (customHostnameId: string) =>
      receipt(project, {
        kind: "ssl",
        providerResourceId: "12345678-1234-1234-1234-123456789abc",
        customHostnameId,
        environmentName: "prod",
        hostname: `${project.handle}.check.omh.st`,
        status: "pending_validation",
        type: "dv",
        method: "http",
        bundleMethod: "ubiquitous",
        certificateAuthority: "lets_encrypt",
        validationRecords: [{ txt_name: "x" }],
      });
    await expect(
      store.domains.putCloudflareProjectDomainReceipt(ssl(hex32("a"))),
    ).rejects.toMatchObject({
      code: "cloudflare_project_domain_conflict",
    });
    await store.domains.putCloudflareProjectDomainReceipt(customHostname(project, "prod", "a"));
    expect(await store.domains.putCloudflareProjectDomainReceipt(ssl(hex32("a")))).toBe("created");
    await expect(
      store.domains.putCloudflareProjectDomainReceipt(
        receipt(project, {
          kind: "dns_record",
          providerResourceId: hex32("f"),
          zoneId: hex32("1"),
          zoneName: "omh.st",
          type: "NS",
          name: "mail.example.com",
          content: "ns1.example.net",
          ttl: 300,
          proxied: false,
          comment: "ohmyhost:test",
        }),
      ),
    ).rejects.toMatchObject({ code: "cloudflare_project_domain_conflict" });
  });

  it("finalizes the platform names of the project's current deletion once, and for no other operation", async () => {
    const project = await seedProject(control);
    await configure(project);
    const operationId = ulidOf("deletion-op", 3),
      finalize = { ...scope(project), operationId, finalizedAt: "2026-10-28T11:00:00.000Z" };
    // Not deleting yet: nothing is authorized, nothing is marked.
    expect(await store.cloudflareDomain.finalizePlatformDeletion(finalize)).toBe(false);
    await startDeletion(project, operationId);
    expect(
      await store.cloudflareDomain.finalizePlatformDeletion({
        ...finalize,
        operationId: ulidOf("deletion-op", 4),
      }),
    ).toBe(false);
    expect(await store.cloudflareDomain.finalizePlatformDeletion(finalize)).toBe(true);
    expect(await store.cloudflareDomain.finalizePlatformDeletion(finalize)).toBe(true);
    expect(await store.domains.readCloudflareProjectDomains(scope(project))).toMatchObject({
      deletedAt: expect.stringMatching(/^2026-10-28T11:00:00/u) as string,
    });
  });

  it("serves deletion state and soft-deletes only for the project's current deletion operation", async () => {
    const project = await seedProject(control);
    await configure(project);
    await store.domains.putCloudflareProjectDomainReceipt(customHostname(project, "prod", "a"));
    await store.domains.putCloudflareProjectDomainReceipt(customHostname(project, "dev", "b"));
    const dns = (name: string, id: string) =>
      receipt(project, {
        kind: "dns_record",
        providerResourceId: hex32(id),
        zoneId: hex32("1"),
        zoneName: "omh.st",
        type: "CNAME",
        name,
        content: "gateway.omh.st",
        ttl: 1,
        proxied: true,
        comment: `ohmyhost:${project.projectId}:app:v1`,
      });
    await store.domains.putCloudflareProjectDomainReceipt(
      dns(`www.${project.handle}.check.omh.st`, "3"),
    );
    await store.domains.putCloudflareProjectDomainReceipt(dns("unrelated.omh.st", "4"));
    await store.domains.putCloudflareProjectDomainReceipt(
      receipt(project, {
        kind: "worker_route",
        providerResourceId: hex32("5"),
        environmentName: "prod",
        zoneId: hex32("1"),
        pattern: `${project.handle}.check.omh.st/*`,
        script: "ohmyho-gateway-production",
      }),
    );
    const operationId = ulidOf("deletion-op", 1);
    const deletion = {
      ...scope(project),
      operationId,
    };
    // Not deleting yet: no authorization.
    expect(await store.domains.readCloudflareProjectDomainDeletionState(deletion)).toBeNull();
    expect(
      await store.domains.markCloudflareProjectDomainsDeletedForDeletion({
        ...deletion,
        deletedAt: "2026-10-28T11:00:00.000Z",
      }),
    ).toBe(false);
    await startDeletion(project, operationId);
    const state = await store.domains.readCloudflareProjectDomainDeletionState(deletion);
    expect(state?.domains?.handle).toBe(project.handle);
    expect(state?.customHostnameDeleteTargets.map((target) => target.environmentName)).toEqual(
      expect.arrayContaining(["dev", "prod"]),
    );
    // Receipts of names that no longer belong to the configuration stay out of the cleanup set.
    expect(
      state?.receipts.map((item) => item["name"] ?? item["pattern"] ?? item["hostname"]),
    ).not.toContain("unrelated.omh.st");
    expect(state?.receipts.map((item) => item.kind).sort()).toEqual([
      "custom_hostname",
      "custom_hostname",
      "dns_record",
      "worker_route",
    ]);
    expect(
      await store.domains.readCloudflareProjectDomainDeletionState({
        ...deletion,
        operationId: ulidOf("deletion-op", 2),
      }),
    ).toBeNull();
    const marked = { ...deletion, deletedAt: "2026-10-28T11:00:00.000Z" };
    expect(await store.domains.markCloudflareProjectDomainsDeletedForDeletion(marked)).toBe(true);
    expect(await store.domains.markCloudflareProjectDomainsDeletedForDeletion(marked)).toBe(true);
    expect(
      await store.domains.markCloudflareProjectDomainsDeletedForDeletion({
        ...marked,
        deletedAt: "2026-10-28T10:30:00.000Z",
      }),
    ).toBe(false);
    // New provider observations of a deleted configuration are refused.
    await expect(
      store.domains.putCloudflareProjectDomainReceipt(customHostname(project, "prod", "c")),
    ).rejects.toMatchObject({ code: "cloudflare_project_domain_conflict" });
  });
});

describe("the retained proof-of-concept zone (original migration 065)", () => {
  it("stores the first Development domains of the aixyte.com zone as history and refuses any other zone", async () => {
    const insert = async (project: SeededProject, zone: string, n: number) =>
      project.shard
        .prepare(
          "INSERT INTO cloudflare_project_domains(organization_id, project_id, operation_id, handle, zone_name, production_domain, development_domain, configured_by_principal_id, idempotency_key_sha256, request_sha256, configured_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'user:owner', ?8, ?9, ?10)",
        )
        .bind(
          project.organizationId,
          project.projectId,
          ulidOf("zone-op", n),
          project.handle,
          zone,
          `${project.handle}.poc.${zone}`,
          `dev-${project.handle}.poc.${zone}`,
          bytes(32, 1),
          bytes(32, 2),
          STORED_NOW,
        )
        .run();
    const retained = await seedProject(control);
    await insert(retained, "aixyte.com", 1);
    const stored = await retained.shard
      .prepare("SELECT zone_name FROM cloudflare_project_domains WHERE project_id = ?1")
      .bind(retained.projectId)
      .first<{ zone_name: string }>();
    expect(stored?.zone_name).toBe("aixyte.com");
    const refused = await seedProject(control);
    await expect(insert(refused, "example.com", 2)).rejects.toThrow(/CHECK constraint failed/u);
  });
});
