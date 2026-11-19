import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProjectHandleGenerator } from "@ohmyhost/project-handles";
import { createUlidFactory, SystemEntropy, parseUlid } from "@ohmyhost/platform";
import { createControlStore } from "../../control-store/src/store.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  createTestControl,
  losingNthResponse,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import {
  createD1ControlApiPersistence,
  type D1ProjectRuntime,
} from "../src/d1-project-persistence.js";
import { createD1ProjectAuthorization } from "../src/d1-project-application.js";
import type { CreateProjectPersistenceInput } from "../src/contracts.js";
import { digest, projectInput } from "../../control-store/test/support/seed.js";
import type { D1Database } from "../../control-store/src/d1-types.js";

const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error("Fixture value is missing");
  return value;
};

let control: TestControl;
let store: ReturnType<typeof createControlStore>;
const clock = { now: () => new Date("2026-12-01T12:00:00.000Z") };
const ids = () => createUlidFactory({ clock, entropy: new SystemEntropy() });
beforeAll(async () => {
  control = await createTestControl();
  store = createControlStore(control.bindings);
});
afterAll(async () => {
  await control.dispose();
});
let seq = 0;
async function organization() {
  seq += 1;
  const organizationId = newUlid();
  const userId = `user_project${seq}`;
  await store.identity.applyOrganizationSnapshot({
    organizationId,
    workosOrganizationId: `org_project${seq}`,
    state: "active",
    snapshotDigest: digest(seq),
    snapshotFetchedAt: "2026-10-28T12:00:00.000Z",
    synchronizedAt: "2026-10-28T12:00:00.000Z",
    triggerEventId: `evt_${seq}`,
    auditEventId: newUlid(),
    memberships: [
      { workosUserId: userId, role: "admin", status: "active", digest: digest(100 + seq) },
    ],
  });
  await control.core
    .prepare(
      "UPDATE organizations SET beta_admitted_at='2026-10-28T12:00:00.000000Z' WHERE organization_id=?",
    )
    .bind(organizationId)
    .run();
  return { organizationId: parseUlid(organizationId), principalId: `user:${userId}` };
}
function adapter(runtime: D1ProjectRuntime = store.projects) {
  return createD1ControlApiPersistence({ platform: "production", runtime, clock, ids: ids() });
}
function request(
  scope: Awaited<ReturnType<typeof organization>>,
  key: string,
): CreateProjectPersistenceInput {
  return {
    ...scope,
    name: "D1 project",
    dataMode: "shared",
    region: "us",
    idempotencyKey: key,
    canonicalRequestDigest: Buffer.alloc(32, 0x31),
    requestId: `req-${key}`,
    source: { provider: "managed", template: "empty" },
  };
}
const rows = async (table: string, org: string) =>
  (
    await control.core
      .prepare(`SELECT * FROM ${table} WHERE organization_id=?`)
      .bind(org)
      .all<Record<string, unknown>>()
  ).results;

function beforeWrite(db: D1Database, before: () => Promise<unknown>): D1Database {
  let batches = 0;
  return {
    prepare: (sql) => db.prepare(sql),
    batch: async (statements) => {
      batches += 1;
      if (batches === 2) await before();
      return db.batch(statements);
    },
  };
}
function rawAdmission(scope: Awaited<ReturnType<typeof organization>>, key: string) {
  const project = projectInput(scope.organizationId, `scope-${key}`);
  return {
    platform: "production",
    operationCreatedAt: project.createdAt,
    request: { requestId: `req-${key}`, idempotencyKey: key, canonicalRequestDigest: digest(10) },
    project: {
      ...project,
      principalId: scope.principalId,
      projectHandleVersion: "human-id-4.2.0-sha256-project-handle-words-v1",
      developmentDataEnvironmentId: project.developmentEnvironmentId,
      productionDataEnvironmentId: project.developmentEnvironmentId,
      outbox: { ...project.outbox, eventType: "ProjectProvisioningRequested" },
    },
  };
}

describe("actual customer project acceptance on the shared core", () => {
  it("rechecks delegated Dev-add authority in the same batch as the effect", async () => {
    const scope = await organization();
    await adapter().createProject({
      ...request(scope, "dev-authority"),
      includeDevelopmentEnvironment: false,
    });
    const project = required((await rows("projects", scope.organizationId))[0]);
    const projectId = parseUlid(String(project["project_id"]));
    const grantId = crypto.randomUUID();
    const delegation = {
      grantId,
      clientId: "dev-add-client",
      consentHash: digest(99),
      action: "projects:write" as const,
    };
    await control.core
      .prepare(
        `INSERT INTO mcp_client_grants(organization_id,grant_id,user_id,client_id,consent_hash,project_id,ownership_version,billing_epoch_id,allow_publish,revision,created_at)
      VALUES(?,?,?,?,?,?,1,?,0,1,'2026-10-28T12:00:00.000000Z')`,
      )
      .bind(
        scope.organizationId,
        grantId,
        scope.principalId.slice(5),
        delegation.clientId,
        delegation.consentHash,
        projectId,
        project["active_billing_epoch_id"],
      )
      .run();
    const racing = createControlStore({
      CONTROL_CORE: beforeWrite(control.core, () =>
        control.core
          .prepare(
            "UPDATE mcp_client_grants SET revoked_at='2026-12-01T00:00:00.000000Z' WHERE grant_id=?",
          )
          .bind(grantId)
          .run(),
      ),
    });
    const addDev = required(adapter(racing.projects).addDevelopmentEnvironment);
    await expect(
      addDev({
        ...scope,
        projectId,
        delegation,
        idempotencyKey: "race-dev",
        canonicalRequestDigest: Buffer.alloc(32, 0x66),
        requestId: "req-race-dev",
      }),
    ).rejects.toMatchObject({ code: "operation_authorization_changed" });
    expect((await rows("environments", scope.organizationId)).map((row) => row["name"])).toEqual([
      "prod",
    ]);
    expect(await rows("api_idempotency_records", scope.organizationId)).toHaveLength(1);
    const directScope = await organization();
    await adapter().createProject({
      ...request(directScope, "direct-dev-authority"),
      includeDevelopmentEnvironment: false,
    });
    const directProject = required((await rows("projects", directScope.organizationId))[0]);
    const directRuntime = createControlStore({
      CONTROL_CORE: beforeWrite(control.core, () =>
        control.core
          .prepare("UPDATE organization_memberships SET state='revoked' WHERE organization_id=?")
          .bind(directScope.organizationId)
          .run(),
      ),
    });
    const directAdd = required(adapter(directRuntime.projects).addDevelopmentEnvironment);
    await expect(
      directAdd({
        ...directScope,
        projectId: parseUlid(String(directProject["project_id"])),
        idempotencyKey: "direct-race",
        canonicalRequestDigest: Buffer.alloc(32, 0x67),
        requestId: "req-direct-race",
      }),
    ).rejects.toMatchObject({ code: "operation_authorization_changed" });
    expect(
      (await rows("environments", directScope.organizationId)).map((row) => row["name"]),
    ).toEqual(["prod"]);
  });

  it("uses the explicit environment choice and preserves it on idempotent retries", async () => {
    for (const dataMode of ["shared", "isolated"] as const) {
      const scope = await organization();
      const persistence = adapter();
      const delegation = {
        clientId: `create-${dataMode}`,
        consentHash: digest(111),
        action: "projects:create" as const,
      };
      await control.core
        .prepare(
          "INSERT INTO mcp_client_grants(organization_id,grant_id,user_id,client_id,consent_hash,allow_publish,revision,created_at) VALUES(?,?,?,?,?,0,1,'2026-10-28T12:00:00.000000Z')",
        )
        .bind(
          scope.organizationId,
          crypto.randomUUID(),
          scope.principalId.slice(5),
          delegation.clientId,
          delegation.consentHash,
        )
        .run();
      const input = {
        ...request(scope, `only-prod-${dataMode}`),
        dataMode,
        includeDevelopmentEnvironment: false,
        sourceDelegation: delegation,
      };
      const accepted = await persistence.createProject(input);
      const environments = await rows("environments", scope.organizationId);
      expect(environments.map((environment) => environment["name"])).toEqual(["prod"]);
      const prod = required(environments[0]);
      expect(await rows("operation_mcp_delegations", scope.organizationId)).toMatchObject([
        { environment_id: prod["environment_id"], event_type: "ProjectProvisioningRequested" },
      ]);
      const assignments = await rows("environment_data_assignments", scope.organizationId);
      expect(assignments).toHaveLength(1);
      expect(assignments[0]).toMatchObject({
        environment_id: prod["environment_id"],
        data_environment_id: prod["environment_id"],
      });
      expect(await rows("project_data_environments", scope.organizationId)).toHaveLength(1);
      const audit = required(
        (await rows("audit_events", scope.organizationId)).find(
          (row) => row["event_type"] === "ProjectCreated",
        ),
      );
      expect(JSON.parse(String(audit["payload"]))).toMatchObject({
        includeDevelopmentEnvironment: false,
      });
      expect(await persistence.createProject(input)).toEqual(accepted);
      expect(await rows("operations", scope.organizationId)).toHaveLength(1);
      const projectId = parseUlid(
        String(required((await rows("projects", scope.organizationId))[0])["project_id"]),
      );
      expect(accepted.body).toMatchObject({ project_id: projectId });
      const add = {
        ...scope,
        projectId,
        idempotencyKey: `add-dev-${dataMode}`,
        canonicalRequestDigest: Buffer.alloc(32, 0x44),
        requestId: `req-add-dev-${dataMode}`,
      };
      const addDev = required(persistence.addDevelopmentEnvironment);
      const added = await addDev(add);
      expect(added).toMatchObject({ status: 202, body: { state: "queued" } });
      expect(await addDev(add)).toEqual(added);
      const after = await rows("environments", scope.organizationId);
      const dev = required(after.find((environment) => environment["name"] === "dev"));
      const afterAssignments = await rows("environment_data_assignments", scope.organizationId);
      const devAssignment = required(
        afterAssignments.find(
          (assignment) => assignment["environment_id"] === dev["environment_id"],
        ),
      );
      expect(devAssignment["data_environment_id"]).toBe(
        dataMode === "shared" ? prod["environment_id"] : dev["environment_id"],
      );
      await expect(addDev({ ...add, idempotencyKey: "new-key" })).rejects.toMatchObject({
        code: "development_environment_exists",
      });
      await persistence.createProject({
        ...input,
        idempotencyKey: `other-${dataMode}`,
        canonicalRequestDigest: Buffer.alloc(32, 0x55),
      });
      const other = required(
        (await rows("projects", scope.organizationId)).find(
          (row) => row["project_id"] !== projectId,
        ),
      );
      await expect(
        addDev({ ...add, projectId: parseUlid(String(other["project_id"])) }),
      ).rejects.toMatchObject({ name: "IdempotencyKeyReusedError" });
    }
    const defaultScope = await organization();
    await adapter().createProject(request(defaultScope, "default-pair"));
    expect(
      (await rows("environments", defaultScope.organizationId)).map((row) => row["name"]).sort(),
    ).toEqual(["dev", "prod"]);
  });

  it("fails the capabilities it was not given as unported instead of opening another store", () => {
    const persistence = adapter();
    expect(() => persistence.submitFeedback({} as never)).toThrow("control_d1_operation_unported");
    expect(() => persistence.readFeedbackStatus({} as never)).toThrow(
      "control_d1_operation_unported",
    );
  });

  it("refuses to create a project when the id factory keeps repeating one identity", async () => {
    const repeated = parseUlid(newUlid());
    const stuck = createD1ControlApiPersistence({
      platform: "production",
      runtime: store.projects,
      clock,
      ids: { next: () => repeated },
    });
    const scope = { organizationId: parseUlid(newUlid()), principalId: "user:user_stuck" };
    await expect(stuck.createProject(request(scope, "stuck-ids"))).rejects.toMatchObject({
      name: "ProjectIdentityAllocationExhaustedError",
      code: "project_identity_unavailable",
    });
  });

  it("commits the canonical HTTP answer, exact original identities, waiting recipe and domains atomically and observes lost replies", async () => {
    const scope = await organization();
    const persistence = adapter();
    const input = request(scope, "first");
    const created = await persistence.createProject(input);
    expect(created.status).toBe(202);
    expect(created.location).toBe(`/v1/operations/${created.body.id}`);
    const project = (await rows("projects", scope.organizationId))[0];
    expect(project).toMatchObject({ region: "us", owner_state: "active", lifecycle_version: 1 });
    const envs = await rows("environments", scope.organizationId);
    expect(envs).toHaveLength(2);
    const data = await rows("project_data_environments", scope.organizationId);
    expect(new Set(data.map((x) => x["data_environment_id"]))).toEqual(
      new Set(envs.map((x) => x["environment_id"])),
    );
    const assignments = await rows("environment_data_assignments", scope.organizationId);
    expect(new Set(assignments.map((x) => x["data_environment_id"])).size).toBe(1);
    expect(await rows("managed_source_initializations", scope.organizationId)).toMatchObject([
      { state: "waiting", principal_id: scope.principalId, parent_operation_id: created.body.id },
    ]);
    expect(await rows("cloudflare_project_domains", scope.organizationId)).toMatchObject([
      {
        production_domain: `${String(project?.["handle"])}.check.omh.st`,
        development_domain: `dev-${String(project?.["handle"])}.check.omh.st`,
      },
    ]);
    expect(
      (await rows("api_idempotency_records", scope.organizationId))[0]?.["idempotency_key"],
    ).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(
      await persistence.createProject({ ...input, requestId: "different-observation" }),
    ).toEqual(created);
    await expect(
      persistence.createProject({ ...input, canonicalRequestDigest: Buffer.alloc(32, 0x32) }),
    ).rejects.toMatchObject({ name: "IdempotencyKeyReusedError" });
    expect(await rows("projects", scope.organizationId)).toHaveLength(1);
    const lostScope = await organization();
    const lossy = createControlStore({ CONTROL_CORE: losingNthResponse(control.core, 2) });
    const lost = await adapter(lossy.projects).createProject(request(lostScope, "lost"));
    expect((await rows("operations", lostScope.organizationId))[0]?.["operation_id"]).toBe(
      lost.body.id,
    );
    expect(await adapter().createProject(request(lostScope, "lost"))).toEqual(lost);
    await expect(
      control.core
        .prepare(
          "UPDATE managed_source_initializations SET child_operation_id=? WHERE organization_id=?",
        )
        .bind(created.body.id, scope.organizationId)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/u);

    const twins = await organization();
    const same = request(twins, "concurrent");
    const answers = await Promise.all([
      adapter().createProject(same),
      adapter().createProject(same),
    ]);
    expect(answers[0]).toEqual(answers[1]);
    expect(await rows("projects", twins.organizationId)).toHaveLength(1);
    expect(await rows("api_idempotency_records", twins.organizationId)).toHaveLength(1);

    const collision = await organization();
    const generator = createProjectHandleGenerator(globalThis.crypto);
    const heldHandle = String(project?.["handle"]);
    const collisionAdapter = createD1ControlApiPersistence({
      platform: "production",
      runtime: store.projects,
      clock,
      ids: ids(),
      projectHandles: {
        async generate(proposal) {
          const receipt = await generator.generate(proposal);
          return {
            ...receipt,
            handle: receipt.collisionAttempt === 0 ? heldHandle : receipt.handle,
          };
        },
      },
    });
    await collisionAdapter.createProject(request(collision, "handle-retry"));
    expect(await rows("projects", collision.organizationId)).toMatchObject([{ handle_attempt: 1 }]);
    const exhausted = createD1ControlApiPersistence({
      platform: "production",
      runtime: store.projects,
      clock,
      ids: ids(),
      projectHandles: {
        async generate(proposal) {
          return { ...(await generator.generate(proposal)), handle: heldHandle };
        },
      },
    });
    await expect(
      exhausted.createProject(request(collision, "handle-exhausted")),
    ).rejects.toMatchObject({ name: "ProjectHandleAllocationExhaustedError" });
    expect(await rows("projects", collision.organizationId)).toHaveLength(1);
    expect(await rows("api_idempotency_records", collision.organizationId)).toHaveLength(1);

    // A replay of the same request answers the first result in both platform environments.
    for (const platform of ["development", "production"] as const) {
      const replayScope = await organization();
      const allocation = Array.from({ length: 32 }, () => parseUlid(newUlid()));
      let index = 0;
      const target = createD1ControlApiPersistence({
        platform,
        runtime: store.projects,
        clock: { now: () => new Date("2026-12-02T12:00:00.000Z") },
        ids: { next: () => required(allocation[index++]) },
      });
      const sameRequest = {
        ...request(replayScope, `replay-${platform}`),
        dataMode: platform === "development" ? ("shared" as const) : ("isolated" as const),
      };
      const created = await target.createProject(sameRequest);
      expect(await target.createProject(sameRequest)).toEqual(created);
    }
    expect((await control.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("answers a replay of a receipt stored before project_id existed with its operation's project, and refuses any other stored shape", async () => {
    const scope = await organization();
    const persistence = adapter();
    const input = request(scope, "legacy-receipt");
    const created = await persistence.createProject(input);
    const [receipt] = await rows("api_idempotency_records", scope.organizationId);
    if (receipt === undefined) throw new Error("Fixture receipt is missing");
    // Receipts are immutable (UPDATE is refused), so the stored answer is replaced by re-inserting the same receipt row.
    const storeAnswer = async (body: Readonly<Record<string, unknown>>) => {
      await control.core
        .prepare("DELETE FROM api_idempotency_records WHERE organization_id=?")
        .bind(scope.organizationId)
        .run();
      await control.core
        .prepare(
          "INSERT INTO api_idempotency_records(organization_id, principal_id, http_method, route_template, idempotency_key, canonical_request_sha256, canonicalization_version, request_id, operation_id, http_status, response_headers, response_body, created_at, completed_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        )
        .bind(
          receipt["organization_id"],
          receipt["principal_id"],
          receipt["http_method"],
          receipt["route_template"],
          receipt["idempotency_key"],
          receipt["canonical_request_sha256"],
          receipt["canonicalization_version"],
          receipt["request_id"],
          receipt["operation_id"],
          receipt["http_status"],
          receipt["response_headers"],
          JSON.stringify(body),
          receipt["created_at"],
          receipt["completed_at"],
          receipt["expires_at"],
        )
        .run();
    };
    const { id, state, created_at, updated_at, project_id } = created.body;
    // The answer the release before project_id stored: exactly these four keys. Its project is the operation's.
    await storeAnswer({ id, state, created_at, updated_at });
    expect(await persistence.createProject(input)).toEqual(created);
    expect(await rows("projects", scope.organizationId)).toHaveLength(1);
    expect(await rows("operations", scope.organizationId)).toHaveLength(1);
    await storeAnswer({ id, state, created_at, updated_at, project_id: id });
    await expect(persistence.createProject(input)).rejects.toThrow(
      "Stored idempotency response is invalid",
    );
    // Any other stored shape stays refused: a legacy answer with an extra field, or one that already has project_id but is malformed.
    await storeAnswer({ id, state, created_at, updated_at, extra: "field" });
    await expect(persistence.createProject(input)).rejects.toThrow(
      "Stored idempotency response is invalid",
    );
    await storeAnswer({ id, state, created_at, updated_at, project_id, extra: "field" });
    await expect(persistence.createProject(input)).rejects.toThrow(
      "Stored idempotency response is invalid",
    );
  });

  it("rolls back every accepted effect on a late domain failure or denied source-creation consent", async () => {
    const scope = await organization();
    await control.core
      .prepare(
        `CREATE TRIGGER fail_initial_domain BEFORE INSERT ON cloudflare_project_domains BEGIN SELECT RAISE(ABORT,'late domain failure'); END`,
      )
      .run();
    await expect(adapter().createProject(request(scope, "failed"))).rejects.toThrow();
    for (const table of [
      "projects",
      "project_directory",
      "billing_epochs",
      "environments",
      "operations",
      "outbox_events",
      "api_idempotency_records",
      "managed_source_initializations",
      "domain_directory",
    ])
      expect(await rows(table, scope.organizationId), table).toHaveLength(0);
    await control.core.prepare("DROP TRIGGER fail_initial_domain").run();
    await expect(
      adapter().createProject({
        ...request(scope, "consent"),
        sourceDelegation: {
          clientId: "client_unknown",
          consentHash: digest(77),
          action: "projects:create",
        },
      }),
    ).rejects.toMatchObject({ name: "ManagedSourceInitializationError" });
    expect(await rows("projects", scope.organizationId)).toHaveLength(0);
    const malformed = rawAdmission(scope, "malformed");
    await expect(
      store.projects.admitCustomerProject({
        ...malformed,
        request: { ...malformed.request, requestId: malformed.project.operation.operationId },
      }),
    ).rejects.toThrow(/request id must differ/u);

    const grantId = crypto.randomUUID(),
      clientId = "client_scoped",
      consentHash = digest(77);
    await control.core
      .prepare(
        "INSERT INTO mcp_client_grants(organization_id,grant_id,user_id,client_id,consent_hash,allow_publish,revision,created_at) VALUES(?,?,?,?,?,0,1,'2026-10-28T12:00:00.000000Z')",
      )
      .bind(scope.organizationId, grantId, scope.principalId.slice(5), clientId, consentHash)
      .run();
    const delegated = {
      ...request(scope, "delegated"),
      sourceDelegation: { clientId, consentHash, action: "projects:create" as const },
    };
    await adapter().createProject(delegated);
    expect(await rows("managed_source_initializations", scope.organizationId)).toMatchObject([
      {
        delegation_grant_id: grantId,
        delegation_client_id: clientId,
        delegation_consent_sha256: consentHash,
      },
    ]);
    expect(await rows("mcp_client_grants", scope.organizationId)).toMatchObject([
      { project_id: null, allow_publish: 0 },
    ]);
    const racing = createControlStore({
      CONTROL_CORE: beforeWrite(control.core, () =>
        control.core
          .prepare(
            "UPDATE mcp_client_grants SET revoked_at='2026-12-01T00:00:00.000000Z' WHERE grant_id=?",
          )
          .bind(grantId)
          .run(),
      ),
    });
    await expect(
      adapter(racing.projects).createProject({ ...delegated, idempotencyKey: "consent-race" }),
    ).rejects.toMatchObject({ name: "ManagedSourceInitializationError" });
    expect(await rows("projects", scope.organizationId)).toHaveLength(1);
    expect(await rows("api_idempotency_records", scope.organizationId)).toHaveLength(1);

    const disappearing = await organization();
    const disappeared = createControlStore({
      CONTROL_CORE: beforeWrite(control.core, () =>
        control.core
          .prepare("UPDATE organizations SET state='deleted' WHERE organization_id=?")
          .bind(disappearing.organizationId)
          .run(),
      ),
    });
    await expect(
      adapter(disappeared.projects).createProject(request(disappearing, "deleted-before-commit")),
    ).rejects.toMatchObject({ code: "organization_inactive" });
    expect(await rows("projects", disappearing.organizationId)).toHaveLength(0);
    expect(await rows("api_idempotency_records", disappearing.organizationId)).toHaveLength(0);

    // The extracted initial-project builder also preserves its original last-statement fences for legacy callers.
    const abortedScope = await organization();
    const abortedInput = rawAdmission(abortedScope, "late-abort").project;
    const aborting = createControlStore({
      CONTROL_CORE: beforeWrite(control.core, () =>
        control.core
          .prepare(
            "INSERT INTO project_creation_aborts(project_id,organization_id,aborted_at) VALUES(?,?,'2026-12-01T12:00:00.000000Z')",
          )
          .bind(abortedInput.projectId, abortedScope.organizationId)
          .run(),
      ),
    });
    await expect(aborting.projects.createInitialProject(abortedInput)).rejects.toMatchObject({
      code: "project_reservation_expired",
    });
    expect(await rows("projects", abortedScope.organizationId)).toHaveLength(0);
    const removedScope = await organization();
    const removing = createControlStore({
      CONTROL_CORE: beforeWrite(control.core, () =>
        control.core
          .prepare("UPDATE organizations SET state='deleted' WHERE organization_id=?")
          .bind(removedScope.organizationId)
          .run(),
      ),
    });
    await expect(
      removing.projects.createInitialProject(rawAdmission(removedScope, "late-remove").project),
    ).rejects.toMatchObject({ code: "organization_inactive" });
    expect(await rows("projects", removedScope.organizationId)).toHaveLength(0);
  });

  it("uses current grants, beta admission, owner epochs and authorized cursor scope for project reads", async () => {
    const scope = await organization(),
      foreign = await organization();
    const persistence = adapter();
    const accepted = await persistence.createProject({
      ...request(scope, "reads"),
      source: undefined,
    });
    const p = required((await rows("projects", scope.organizationId))[0]);
    const authorization = createD1ProjectAuthorization(store.projects);
    const check = {
      principal: { kind: "user" as const, subjectId: scope.principalId as `user:${string}` },
      resource: { kind: "organization" as const, organizationId: scope.organizationId },
      action: "projects:create" as const,
    };
    expect(await authorization.check(check)).toBe("allow");
    const projectId = parseUlid(p["project_id"] as string);
    const environmentId = parseUlid(
      String((await rows("environments", scope.organizationId))[0]?.["environment_id"]),
    );
    for (const action of ["secrets:read", "secrets:write", "secrets:delete"] as const) {
      expect(
        await authorization.check({
          ...check,
          action,
          resource: {
            kind: "project",
            organizationId: scope.organizationId,
            projectId,
            environmentId,
          },
        }),
      ).toBe("allow");
      expect(
        await authorization.check({
          ...check,
          action,
          resource: { kind: "project", organizationId: scope.organizationId, projectId },
        }),
      ).toBe("deny");
      expect(
        await authorization.check({
          ...check,
          action,
          resource: {
            kind: "project",
            organizationId: foreign.organizationId,
            projectId,
            environmentId,
          },
        }),
      ).toBe("deny");
    }
    for (const action of [
      "sources:read",
      "sources:link",
      "deployments:read",
      "deployments:plan",
      "deployments:create",
      "projects:dev-access",
      "projects:rollback-plan",
      "projects:rollback",
      "projects:promote-plan",
      "projects:promote",
      "projects:delete-plan",
      "projects:delete",
      "operations:reconcile",
      "feedback:create",
    ] as const) {
      expect(
        await authorization.check({
          ...check,
          action,
          resource: { kind: "project", organizationId: scope.organizationId, projectId },
        }),
      ).toBe("allow");
      expect(
        await authorization.check({
          ...check,
          action,
          resource: { kind: "project", organizationId: foreign.organizationId, projectId },
        }),
      ).toBe("deny");
    }
    for (const action of [
      "feedback:create",
      "credits:read",
      "sources:read",
      "sources:link",
      "mail-domains:read",
      "mail-domains:admin",
    ] as const)
      expect(await authorization.check({ ...check, action })).toBe("allow");
    expect(await authorization.check({ ...check, action: "mail-domains:use" })).toBe("deny");
    expect(await authorization.check({ ...check, action: "audit:read" })).toBe("allow");
    const audit = adapter({ ...store.projects, readAuditEvents: store.operations.readAuditEvents });
    expect(
      (await audit.readAuditEvents({ organizationId: scope.organizationId, projectId, limit: 10 }))
        .events,
    ).toMatchObject([{ projectId, organizationId: scope.organizationId }]);
    await expect(
      audit.readAuditEvents({
        organizationId: scope.organizationId,
        projectId,
        limit: 10,
        cursor: "invalid",
      }),
    ).rejects.toThrow("Invalid audit cursor");
    expect(
      await authorization.check({
        ...check,
        resource: { kind: "project", organizationId: scope.organizationId, projectId },
        action: "projects:read",
      }),
    ).toBe("allow");
    expect(
      await authorization.check({
        ...check,
        resource: { kind: "project", organizationId: foreign.organizationId, projectId },
        action: "projects:read",
      }),
    ).toBe("deny");
    expect(
      await persistence.listProjects({ organizationIds: [scope.organizationId], limit: 1 }),
    ).toMatchObject({ projects: [{ projectId }], nextCursor: null });
    expect(await persistence.getProject(scope.organizationId, projectId)).toMatchObject({
      projectId,
    });
    expect(await persistence.getProject(foreign.organizationId, projectId)).toBeNull();
    await expect(
      persistence.listProjects({
        organizationIds: [foreign.organizationId],
        limit: 1,
        cursor: projectId,
      }),
    ).rejects.toMatchObject({ name: "InvalidProjectCursorError" });
    expect(await persistence.takenProjectHandles([p["handle"] as string])).toEqual(
      new Set([p["handle"]]),
    );
    await control.core
      .prepare(
        "INSERT INTO project_directory(project_id,organization_id,handle,state,reserved_until,created_at) VALUES(?,?,?,'reserved','2027-01-01T00:00:00.000000Z','2026-12-01T00:00:00.000000Z')",
      )
      .bind(newUlid(), scope.organizationId, "ghost-reservation")
      .run();
    expect(await persistence.takenProjectHandles(["ghost-reservation"])).toEqual(new Set());
    const mapping = required(
      await control.core
        .prepare("SELECT workos_organization_id FROM organizations WHERE organization_id=?")
        .bind(scope.organizationId)
        .first<{ workos_organization_id: string }>(),
    );
    for (const [role, stamp, number] of [
      ["member", "2026-10-28T12:00:00.001Z", 8001],
      ["admin", "2026-10-28T12:00:00.002Z", 8002],
    ] as const) {
      await store.identity.applyOrganizationSnapshot({
        organizationId: scope.organizationId,
        workosOrganizationId: mapping.workos_organization_id,
        state: "active",
        snapshotDigest: digest(number),
        snapshotFetchedAt: stamp,
        synchronizedAt: stamp,
        triggerEventId: `evt_action_scope_${number}`,
        auditEventId: newUlid(),
        memberships: [
          {
            workosUserId: scope.principalId.slice(5),
            role,
            status: "active",
            digest: digest(number + 10),
          },
        ],
      });
      for (const action of ["sources:read", "deployments:read", "feedback:create"] as const)
        expect(
          await authorization.check({
            ...check,
            action,
            resource: { kind: "project", organizationId: scope.organizationId, projectId },
          }),
        ).toBe("allow");
      for (const action of [
        "sources:link",
        "deployments:plan",
        "deployments:create",
        "projects:dev-access",
        "operations:reconcile",
      ] as const)
        expect(
          await authorization.check({
            ...check,
            action,
            resource: { kind: "project", organizationId: scope.organizationId, projectId },
          }),
        ).toBe(role === "member" ? "deny" : "allow");
      expect(await authorization.check({ ...check, action: "credits:read" })).toBe(
        role === "member" ? "deny" : "allow",
      );
      expect(await authorization.check({ ...check, action: "mail-domains:read" })).toBe("allow");
      expect(await authorization.check({ ...check, action: "mail-domains:admin" })).toBe(
        role === "member" ? "deny" : "allow",
      );
    }
    await control.core
      .prepare(
        "UPDATE projects SET owner_state='security_frozen' WHERE organization_id=? AND project_id=?",
      )
      .bind(scope.organizationId, projectId)
      .run();
    expect(
      await authorization.check({
        ...check,
        resource: { kind: "project", organizationId: scope.organizationId, projectId },
        action: "projects:read",
      }),
    ).toBe("deny");
    await control.core
      .prepare("UPDATE organizations SET beta_admitted_at=NULL WHERE organization_id=?")
      .bind(scope.organizationId)
      .run();
    expect(await authorization.check(check)).toBe("deny");
    expect(accepted.status).toBe(202);
  });
});
