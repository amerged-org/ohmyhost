import type { D1Database, D1PreparedStatement } from "../../src/d1-types.js";
import type { createControlStore } from "../../src/store.js";
import { newUlid } from "../../src/catalog/common.js";
import type { TestControl } from "./control-d1.js";
import { admitConsentingUser, STORED_NOW, type SeededProject } from "./platform-fixtures.js";
export { admitConsentingUser };

export const time = (minute: number) => `2026-10-29T10:${String(minute).padStart(2, "0")}:00.000Z`;
export const sha = (byte: number) => "sha256:" + byte.toString(16).padStart(2, "0").repeat(32);
export const scope = (p: SeededProject) => ({
  organizationId: p.organizationId,
  projectId: p.projectId,
});
/** Sealed OAuth material as the private rotation commands take it. */
export const secret = (fill: number) => ({
  accessCiphertext: new Uint8Array(32).fill(fill),
  accessNonce: new Uint8Array(12).fill(fill),
  refreshCiphertext: new Uint8Array(32).fill(fill + 1),
  refreshNonce: new Uint8Array(12).fill(fill + 1),
  keyVersion: 1,
});
/** The same material as the base64 envelope `putGrant` takes. */
export const sealed = (fill: number) =>
  Object.fromEntries(
    Object.entries(secret(fill)).map(([key, value]) => [
      key,
      value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value,
    ]),
  );

let stateByte = 0;
/** A paid domain of the project declares the zone that an authorization may then name. */
export async function declareZone(
  control: TestControl,
  p: SeededProject,
  zoneName = "example.test",
) {
  await control.core
    .prepare(
      "INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,created_at,updated_at,provisioning_started_at) VALUES(?1,?2,?3,NULL,'awaiting_deployment','user:owner',unhex(?4),unhex(?4),?5,?5,NULL)",
    )
    .bind(p.organizationId, p.projectId, `${p.handle}.${zoneName}`, "31".repeat(32), STORED_NOW)
    .run();
  stateByte += 1;
  return {
    ...scope(p),
    authorizationId: newUlid(),
    principalId: "user:user_consent",
    zoneName,
    idempotencyKeySha256: sha(0x41),
    requestSha256: sha(0x42),
    stateSha256: new Uint8Array(32).fill(stateByte),
    issuedAt: time(0),
    expiresAt: time(59),
  };
}

/** Claim, consume and put leave one active sealed grant of the project. */
export async function connectGrant(
  control: TestControl,
  store: ReturnType<typeof createControlStore>,
  p: SeededProject,
) {
  const auth = await declareZone(control, p);
  await store.cloudflareDomain.claimAuthorization(auth);
  await store.cloudflareDomain.consumeAuthorization({
    authorizationId: auth.authorizationId,
    stateSha256: auth.stateSha256,
    principalId: auth.principalId,
    consumedAt: time(1),
  });
  await store.cloudflareDomain.putGrant({
    ...scope(p),
    authorizationId: auth.authorizationId,
    principalId: auth.principalId,
    zoneName: auth.zoneName,
    zoneId: "a".repeat(32),
    accountId: "b".repeat(32),
    scopes: ["dns.write", "zone.read"],
    ...sealed(1),
    accessExpiresAt: time(58),
    connectedAt: time(2),
  });
  return auth;
}

/**
 * Failure injection at the D1 boundary for commands whose reads are not plain SELECTs (the fence treats those as
 * writes): the first batch holding a statement that matches `pattern` commits, then its reply is lost.
 */
export function losingBatchWith(db: D1Database, pattern: RegExp): D1Database {
  let pending = true;
  type Wrapped = D1PreparedStatement & { inner: D1PreparedStatement; sql: string };
  const wrap = (inner: D1PreparedStatement, sql: string): Wrapped => ({
    inner,
    sql,
    bind: (...values) => wrap(inner.bind(...values), sql),
    first: (...args: []) => inner.first(...args),
    all: () => inner.all(),
    run: () => inner.run(),
  });
  return {
    prepare: (sql) => wrap(db.prepare(sql), sql),
    batch: async (statements) => {
      const wrapped = statements as unknown as Wrapped[];
      const results = await db.batch(wrapped.map((statement) => statement.inner));
      if (pending && wrapped.some((statement) => pattern.test(statement.sql))) {
        pending = false;
        throw new Error("Network connection lost");
      }
      return results;
    },
  };
}
