import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { MailInfrastructureRuntime } from "../../control-store/src/worker-main.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { createD1InfrastructurePersistence } from "../src/d1-infrastructure-persistence.js";
import { createInfrastructureAlertReceiver } from "../src/infrastructure-alerts.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

const secret = "a".repeat(43),
  recipient = "owner@example.net";
let control: TestControl,
  persistence: Awaited<ReturnType<typeof createD1InfrastructurePersistence>>;
beforeAll(async () => {
  control = await createTestControl();
  persistence = await createD1InfrastructurePersistence(
    new MailInfrastructureRuntime({} as never, control.bindings as never),
  );
}, 60_000);
afterAll(async () => control?.dispose());
function event(
  kind: "regional_ram_warning" | "regional_node_cap_reached" = "regional_ram_warning",
) {
  return {
    version: 1,
    event_id: crypto.randomUUID(),
    kind,
    region_id: "eu-1",
    occurred_at: "2026-10-08T00:00:00.000Z",
    regional_ram_utilization_ppm: kind === "regional_ram_warning" ? 750_000 : null,
    allocated_nodes: 3,
    max_nodes: 3,
  };
}
function request(
  alert: ReturnType<typeof event>,
  options: {
    token?: string;
    key?: string;
    body?: string;
    method?: string;
    contentType?: string;
  } = {},
) {
  return new Request("https://infrastructure-alert.invalid/", {
    method: options.method ?? "POST",
    headers: {
      authorization: `Bearer ${options.token ?? secret}`,
      "content-type": options.contentType ?? "application/json",
      "idempotency-key": options.key ?? alert.event_id,
    },
    body: options.body ?? JSON.stringify(alert),
  });
}
it("authenticates strict events and durably deduplicates concurrent sends and later delivery retries", async () => {
  const sends: Request[] = [],
    alert = event();
  const configuration = {
    persistence,
    secret,
    recipient,
    apiKey: "re_operator_alerts",
    platform: "development" as const,
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      sends.push(new Request(url, init));
      await new Promise((resolve) => setTimeout(resolve, 30));
      return Response.json({ id: "provider-alert-1" });
    },
  };
  const receiver = createInfrastructureAlertReceiver(configuration);
  expect(() => createInfrastructureAlertReceiver({ ...configuration, secret: "short" })).toThrow(
    "invalid_alert_configuration",
  );
  expect((await receiver.fetch(request(alert, { token: "wrong" }))).status).toBe(401);
  expect((await receiver.fetch(new Request("https://infrastructure-alert.invalid/"))).status).toBe(
    401,
  );
  expect((await receiver.fetch(request(alert, { method: "PUT" }))).status).toBe(400);
  expect((await receiver.fetch(request(alert, { contentType: "text/plain" }))).status).toBe(400);
  expect((await receiver.fetch(request(alert, { body: "x".repeat(8193) }))).status).toBe(413);
  expect((await receiver.fetch(request(alert, { body: "null" }))).status).toBe(400);
  expect(
    (
      await receiver.fetch(
        request(alert, { body: JSON.stringify({ ...alert, kind: ["regional_ram_warning"] }) }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await receiver.fetch(
        request(alert, { body: JSON.stringify({ ...alert, recipient: "attacker@example.net" }) }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await receiver.fetch(
        request(alert, {
          body: JSON.stringify({ ...alert, occurred_at: "2099-01-01T00:00:00.000Z" }),
        }),
      )
    ).status,
  ).toBe(400);
  expect((await receiver.fetch(request(alert, { key: crypto.randomUUID() }))).status).toBe(400);
  const concurrent = await Promise.all([
    receiver.fetch(request(alert)),
    receiver.fetch(request(alert)),
  ]);
  expect(concurrent.map((result) => result.status).sort()).toEqual([200, 503]);
  expect(sends).toHaveLength(1);
  const firstSend = sends[0];
  if (!firstSend) throw new Error("send missing");
  expect(await firstSend.json()).toMatchObject({
    from: "no-reply@dev.ohmyho.st",
    to: [recipient],
    subject: "[Development] PGCF regional RAM warning: eu-1",
  });
  expect(firstSend.headers.get("idempotency-key")).toBe(`pgcf:development:${alert.event_id}`);
  expect(
    (await createInfrastructureAlertReceiver(configuration).fetch(request(alert))).status,
  ).toBe(200);
  expect((await receiver.fetch(request({ ...alert, region_id: "us-1" }))).status).toBe(409);
  expect(sends).toHaveLength(1);
});
it("reuses the original provider identity for uncertain sends and fails closed after the provider replay window", async () => {
  const alert = event("regional_node_cap_reached"),
    sends: Request[] = [];
  let at = new Date("2026-10-08T09:00:00.000Z"),
    refuse = true;
  const receiver = createInfrastructureAlertReceiver({
    persistence,
    secret,
    recipient,
    apiKey: "re_operator_alerts",
    platform: "production",
    now: () => at,
    fetch: async (url, init) => {
      sends.push(new Request(url, init));
      if (refuse) throw new Error("uncertain transport");
      return Response.json({ id: "provider-alert-2" });
    },
  });
  expect((await receiver.fetch(request(alert))).status).toBe(503);
  expect((await receiver.fetch(request(alert))).status).toBe(503);
  expect(sends).toHaveLength(1);
  at = new Date(at.getTime() + 31_000);
  const otherAccount = createInfrastructureAlertReceiver({
    persistence,
    secret,
    recipient,
    apiKey: "re_other_account",
    platform: "production",
    now: () => at,
    fetch: async () => Response.json({ id: "different-provider-namespace" }),
  });
  expect((await otherAccount.fetch(request(alert))).status).toBe(409);
  refuse = false;
  expect((await receiver.fetch(request(alert))).status).toBe(200);
  expect(sends.map((send) => send.headers.get("idempotency-key"))).toEqual([
    `pgcf:production:${alert.event_id}`,
    `pgcf:production:${alert.event_id}`,
  ]);
  const secondSend = sends[1];
  if (!secondSend) throw new Error("retry missing");
  expect(await secondSend.json()).toMatchObject({
    from: "no-reply@ohmyho.st",
    to: [recipient],
    subject: "PGCF regional VPS limit reached: eu-1",
  });
  expect((await receiver.fetch(request(alert))).status).toBe(200);
  const unresolved = event();
  refuse = true;
  expect((await receiver.fetch(request(unresolved))).status).toBe(503);
  const count = sends.length;
  at = new Date(at.getTime() + 23 * 3_600_000);
  refuse = false;
  expect((await receiver.fetch(request(unresolved))).status).toBe(503);
  expect(sends).toHaveLength(count);
});
it("refuses a missing Core binding and a probe that already holds a receipt", async () => {
  await expect(createD1InfrastructurePersistence({})).rejects.toThrow(
    "infrastructure_core_binding_required",
  );
  const at = new Date().toISOString(),
    binding = {
      claim: async () => "send",
      complete: async () => true,
    };
  await expect(
    createD1InfrastructurePersistence({
      ...binding,
      readReceipt: async () => ({
        eventId: crypto.randomUUID(),
        requestSha256: "a".repeat(64),
        firstAttemptAt: at,
        leaseUntil: at,
        providerMessageId: null,
        acceptedAt: null,
      }),
    }),
  ).rejects.toThrow("infrastructure_core_response_invalid");
  await expect(
    createD1InfrastructurePersistence({ ...binding, readReceipt: async () => ({ ready: true }) }),
  ).rejects.toThrow("infrastructure_core_response_invalid");
});
