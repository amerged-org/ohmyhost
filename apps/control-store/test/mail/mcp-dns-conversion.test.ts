import { expect, it } from "vitest";
import { Miniflare } from "miniflare";
import type { D1Database } from "../../src/d1-types.js";
import { newUlid } from "../../src/catalog/common.js";
import { activateTestCore, migrationFiles, type TestControl } from "../support/control-d1.js";
import { splitStatements } from "../support/sql.js";
import { cfFixture, seedWorkspaceDomain, stored } from "../support/cf-mail-fixture.js";

it("converts historical mail DNS proof once while retaining its original evidence", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('ok')}}",
    d1Databases: { CONTROL_CORE: "core" },
  });
  try {
    const db = (await mf.getD1Database("CONTROL_CORE")) as unknown as D1Database;
    const files = migrationFiles("core");
    for (const file of files.filter((f) => f.name < "0608"))
      await db.batch(splitStatements(file.sql).map((sql) => db.prepare(sql)));
    await activateTestCore(db);
    const control: TestControl = {
      core: db,
      directory: db,
      bindings: { CONTROL_CORE: db },
      shards: { CONTROL_SHARD_0000: db, CONTROL_SHARD_0001: db },
      dispose: async () => {},
    };
    const f = await cfFixture(control);
    const domain = await seedWorkspaceDomain(f, { domain: "example.com", status: "active" });
    const grantId = crypto.randomUUID(),
      consentHash = "ab".repeat(32),
      authorizationId = newUlid();
    const original = JSON.stringify({
      grantId,
      grantRevision: 1,
      clientId: "client_old",
      consentHash,
    });
    const issued = stored(Date.now(), 0),
      expires = stored(Date.now(), 300_000);
    await db
      .prepare(
        `INSERT INTO mcp_mail_domain_grants(organization_id,grant_id,user_id,client_id,consent_hash,mail_domain_id,permissions,revision,created_at) VALUES(?1,?2,?3,'client_old',?4,?5,'["admin"]',1,?6)`,
      )
      .bind(f.organizationId, grantId, f.userId, consentHash, domain.domainId, issued)
      .run();
    await db
      .prepare(
        `INSERT INTO scoped_customer_dns_authorizations(authorization_id,organization_id,purpose,resource_id,resource_revision,principal_id,delegation,zone_name,state_sha256,idempotency_key_sha256,request_sha256,issued_at,expires_at) VALUES(?1,?2,'workspace_mail',?3,1,?4,?5,'example.com',unhex(?6),unhex(?7),unhex(?8),?9,?10)`,
      )
      .bind(
        authorizationId,
        f.organizationId,
        domain.domainId,
        f.principalId,
        original,
        "01".repeat(32),
        "02".repeat(32),
        "03".repeat(32),
        issued,
        expires,
      )
      .run();
    const orgGrant = crypto.randomUUID(),
      projectAuth = newUlid();
    const originalProject = JSON.stringify({
      grantId: orgGrant,
      grantRevision: 1,
      clientId: "client_old",
      consentHash,
    });
    await db
      .prepare(
        `INSERT INTO mcp_client_grants(organization_id,grant_id,user_id,client_id,consent_hash,project_id,allow_publish,revision,created_at) VALUES(?1,?2,?3,'client_old',?4,NULL,0,1,?5)`,
      )
      .bind(f.organizationId, orgGrant, f.userId, consentHash, issued)
      .run();
    await db
      .prepare(
        `INSERT INTO project_application_domain_identities(organization_id,project_id,hostname,registrable_domain,revision,state,challenge_name,challenge_value,declared_at,expires_at,idempotency_key_sha256,request_sha256,actor_id) VALUES(?1,?2,'www.example.com','example.com',1,'pending','_omh-project.www.example.com',?3,?4,'2099-01-01T00:00:00.000000Z',unhex(?5),unhex(?6),?7)`,
      )
      .bind(
        f.organizationId,
        f.projectId,
        `omh-domain-v1=${"A".repeat(43)}`,
        issued,
        "04".repeat(32),
        "05".repeat(32),
        f.principalId,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO scoped_customer_dns_authorizations(authorization_id,organization_id,purpose,resource_id,resource_revision,principal_id,delegation,zone_name,state_sha256,idempotency_key_sha256,request_sha256,issued_at,expires_at) VALUES(?1,?2,'application_identity',?3,1,?4,?5,'example.com',unhex(?6),unhex(?7),unhex(?8),?9,?10)`,
      )
      .bind(
        projectAuth,
        f.organizationId,
        f.projectId,
        f.principalId,
        originalProject,
        "06".repeat(32),
        "07".repeat(32),
        "08".repeat(32),
        issued,
        expires,
      )
      .run();
    const handoffHash = "dd".repeat(32);
    await db
      .prepare(
        `INSERT INTO mcp_portal_handoffs(organization_id,request_hash,user_id,client_id,consent_hash,kind,project_ids,allow_create,allow_publish,secret_target,github_target,created_at,expires_at) VALUES(?1,?2,?3,'client_old',?4,'github','[]',0,0,NULL,'{"idempotencyKey":"old"}',?5,?6)`,
      )
      .bind(f.organizationId, handoffHash, f.userId, consentHash, issued, expires)
      .run();
    const migration = files.find((f) => f.name.startsWith("0608_"));
    if (!migration) throw new Error("Cutover migration fixture missing");
    await db
      .prepare("UPDATE projects SET ownership_version=2 WHERE project_id=?1")
      .bind(f.projectId)
      .run();
    await expect(
      db.batch(splitStatements(migration.sql).map((sql) => db.prepare(sql))),
    ).rejects.toThrow();
    await db
      .prepare("UPDATE projects SET ownership_version=1 WHERE project_id=?1")
      .bind(f.projectId)
      .run();
    await db.batch(splitStatements(migration.sql).map((sql) => db.prepare(sql)));
    const row = await db
      .prepare(
        `SELECT a.delegation,c.original_delegation FROM scoped_customer_dns_authorizations a JOIN mcp_dns_authority_conversion c USING(authorization_id) WHERE a.authorization_id=?1`,
      )
      .bind(authorizationId)
      .first<{ delegation: string; original_delegation: string }>();
    expect(row?.original_delegation).toBe(original);
    if (!row) throw new Error("Conversion fixture missing");
    const proof = JSON.parse(row.delegation) as { grantId: string; grantRevision: number };
    expect(
      await db
        .prepare(
          "SELECT grant_id FROM mcp_client_grants WHERE organization_id=?1 AND grant_id=?2 AND project_id IS NULL",
        )
        .bind(f.organizationId, proof.grantId)
        .first(),
    ).not.toBeNull();
    expect(proof.grantRevision).toBe(1);
    const projectRow = await db
      .prepare(
        `SELECT a.delegation,c.original_delegation FROM scoped_customer_dns_authorizations a JOIN mcp_dns_authority_conversion c USING(authorization_id) WHERE a.authorization_id=?1`,
      )
      .bind(projectAuth)
      .first<{ delegation: string; original_delegation: string }>();
    expect(projectRow?.original_delegation).toBe(originalProject);
    if (!projectRow) throw new Error("Conversion fixture missing");
    const projectProof = JSON.parse(projectRow.delegation) as { grantId: string };
    expect(
      await db
        .prepare(
          "SELECT 1 FROM mcp_client_grants WHERE grant_id=?1 AND project_id=?2 AND ownership_version=1 AND billing_epoch_id=?3",
        )
        .bind(projectProof.grantId, f.projectId, f.project.billingEpochId)
        .first(),
    ).not.toBeNull();

    const handoff = await db
      .prepare("SELECT authority FROM mcp_portal_handoffs WHERE request_hash=?1")
      .bind(handoffHash)
      .first<{ authority: string }>();
    if (!handoff) throw new Error("Conversion fixture missing");
    expect(JSON.parse(handoff.authority)).toMatchObject({
      clientId: "client_old",
      consentHash,
      action: "sources:link",
    });
  } finally {
    await mf.dispose();
  }
});
