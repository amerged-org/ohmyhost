import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newUlid } from "../../src/catalog/common.js";
import { createControlStore } from "../../src/store.js";
import {
  createTestControl,
  organizationIdWithShard,
  type TestControl,
} from "../support/control-d1.js";
import { ensureCreditTables } from "../support/credit-tables.js";

type Row = { check: string; status: string; detail: string };
const script = (name: string) =>
  import(new URL(`../../../../scripts/${name}.mjs`, import.meta.url).href);
const ulid = (tag: string, n: number) => `01${tag}${String(n).padStart(24 - tag.length, "0")}`;
const at = (second: number) => `2026-10-28T10:00:${String(second).padStart(2, "0")}.000000Z`;
const status = (rows: Row[], check: string) => rows.find((entry) => entry.check === check)?.status;

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl(2);
  await ensureCreditTables(control.core);
}, 120_000);
afterAll(async () => control.dispose());

describe("control-core-smoke", () => {
  it("renders one aligned table and judges the Core authority, the credit invariants and an unactivated Core", async () => {
    const { renderTable, coreRows } = await script("control-core-smoke");
    const { bindingQuery } = await script("control-d1-bulk");
    expect(
      renderTable([
        { check: "a", status: "PASS", detail: "ok" },
        { check: "long check", status: "FAIL", detail: "no" },
      ]),
    ).toBe(
      [
        "CHECK       STATUS  DETAIL",
        "a           PASS    ok",
        "long check  FAIL    no",
        "1 pass, 1 fail, 0 warn, 0 skipped",
      ].join("\n"),
    );

    // Two organizations created by the Core's own snapshot command; the second one loses its credit account.
    const store = createControlStore(control.bindings);
    const organization = async (n: number) => {
      const organizationId = await organizationIdWithShard(2, 0, 5097 + n * 997);
      await store.identity.applyOrganizationSnapshot({
        organizationId,
        workosOrganizationId: `org_smoke${n}`,
        state: "active",
        snapshotDigest: String(n).padStart(64, "0"),
        snapshotFetchedAt: "2026-10-28T09:00:00.000Z",
        synchronizedAt: "2026-10-28T09:00:00.000Z",
        triggerEventId: "evt_seed",
        memberships: [],
        auditEventId: newUlid(),
      });
      return organizationId;
    };
    await organization(1);
    const unfunded = await organization(2);
    // Both snapshots opened an account with the organization; the second one is taken away to name the missing account.
    await control.core
      .prepare("DELETE FROM credit_account WHERE organization_id = ?")
      .bind(unfunded)
      .run();

    const query = bindingQuery(control.core);
    // the fixture activation carries no compare receipt, which the import qualification would have written
    const failing = (rows: Row[]) =>
      rows
        .filter(
          (entry) => entry.status === "FAIL" && entry.check !== "core activation = compare receipt",
        )
        .map((entry) => entry.check);
    const rows = await coreRows(query, "development");
    expect(status(rows, "readControlAuthority: provider d1")).toBe("PASS");
    expect(rows[0].detail).toContain("00000000-0000-4000-8000-000000000001");
    expect(status(rows, "credit tables exist")).toBe("PASS");
    // The second organization has no account and no usage source has a cursor yet: both are named, nothing else is.
    expect(failing(rows)).toEqual([
      "credit organizations without exactly one account",
      "credit usage cursors for every source",
    ]);
    expect(rows.at(-1).detail).toBe("1 accounts, 0 open reservations, 0 log rows");

    await control.core.batch([
      control.core
        .prepare(
          "INSERT INTO credit_account(organization_id, monthly_micros, monthly_ends_at, updated_at) VALUES (?, 0, '2026-11-01T00:00:00.000000Z', ?)",
        )
        .bind(unfunded, at(0)),
      ...["wfp", "pgcf", "r2", "resources"].map((source) =>
        control.core
          .prepare(
            "INSERT INTO usage_cursor(source, through) VALUES (?, '2026-10-30T00:00:00.000000Z')",
          )
          .bind(source),
      ),
    ]);
    expect(failing(await coreRows(query, "development"))).toEqual([]);

    // An unactivated Core (the Development Core before its cutover) is a clear verdict, not a crash.
    const bare = await createTestControl(2, { activated: false });
    try {
      const unactivated = await coreRows(bindingQuery(bare.core), "development");
      expect(unactivated[0]).toMatchObject({ status: "FAIL" });
      expect(unactivated[0].detail).toContain("not activated");
      expect(status(unactivated, "core authority activation rows")).toBe("FAIL");
    } finally {
      await bare.dispose();
    }
  }, 120_000);

  it("probes the public API in order, replays the write with its key and reports a refused call", async () => {
    const { apiRows } = await script("control-core-smoke");
    const ids = { org: ulid("ORG", 1), project: ulid("PJ", 1), operation: ulid("OP", 1) };
    const receipts = new Map<string, string>();
    let refuse = false;
    const server = createServer((request, response) => {
      const send = (code: number, body: unknown) =>
        response.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
      const path = request.url ?? "";
      if (request.headers.authorization !== "Bearer smoke-token")
        return send(401, { code: "unauthenticated" });
      if (refuse) return send(503, { code: "service_unavailable" });
      if (request.method === "POST") {
        const key = String(request.headers["idempotency-key"]);
        if (!receipts.has(key)) receipts.set(key, ulid("FB", receipts.size + 1));
        return send(201, { id: receipts.get(key), organization_id: ids.org, submitted_at: at(0) });
      }
      if (path === "/v1/me")
        return send(200, {
          organizations: [{ id: ids.org, name: "o" }],
          organization_ids: [ids.org],
        });
      if (path.startsWith("/v1/projects?"))
        return send(200, { items: [{ id: ids.project, organization_id: ids.org }] });
      if (path === `/v1/projects/${ids.project}`) return send(200, { id: ids.project });
      if (path === `/v1/projects/${ids.project}/status`)
        return send(200, { project_id: ids.project, latest_operation: { id: ids.operation } });
      if (path === `/v1/operations/${ids.operation}`) return send(200, { id: ids.operation });
      if (path === `/v1/organizations/${ids.org}/credits`)
        return send(200, { available_micros: "900" });
      // The report takes no query (the retired `month` parameter is a 404 here) and answers the last 14 days.
      if (path === `/v1/organizations/${ids.org}/credit-usage`)
        return send(200, {
          organization_id: ids.org,
          as_of: at(0),
          unit: "microcredits",
          period: "2026-10",
          from: "2026-10-15T00:00:00.000Z",
          projects: [],
          days: [],
        });
      return send(404, { code: "resource_not_found" });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const rows: Row[] = await apiRows({ origin, token: "smoke-token", write: true });
      expect(rows.map((entry) => entry.status)).toEqual(Array(9).fill("PASS"));
      expect(receipts.size).toBe(1); // one stored receipt: the replay carried the same key and got the same id
      expect(JSON.stringify(rows)).not.toContain("smoke-token");
      expect((await apiRows({ origin, token: "smoke-token", write: false })).at(-1)).toMatchObject({
        status: "SKIP",
      });
      refuse = true;
      const refused: Row[] = await apiRows({ origin, token: "smoke-token", write: true });
      expect(refused.map((entry) => entry.status)).toEqual(["FAIL", "FAIL", "SKIP"]);
      expect(refused[0]?.detail).toBe("HTTP 503 service_unavailable");
    } finally {
      server.close();
    }
  });
});
