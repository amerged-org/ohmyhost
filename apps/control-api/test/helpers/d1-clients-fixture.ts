import { newUlid } from "../../../control-store/src/catalog/common.js";
import type { TestControl } from "../../../control-store/test/support/control-d1.js";
import { readUsage as readCreditLog } from "../../../credit-service/src/report.js";
import type { Dependencies } from "../../../credit-service/src/port.js";
import { connect, remoteMcpFixture } from "./d1-remote-mcp-fixture.js";

type Entrypoint = new (context: unknown, environment: unknown) => object;
const NOW = "2026-10-29T10:00:00.000Z";

/**
 * The real Control API Worker over the real local Core D1 for the released clients. Only the three external provider
 * boundaries are doubles: the WorkOS key service behind AUTH_STATUS, the billing Worker (Stripe) and the PGCF database
 * management Worker. The caller mocks `cloudflare:workers`, so the Core's private entrypoints run in process.
 */
export async function clientsFixture(control: TestControl) {
  const f = await remoteMcpFixture(control),
    entry = await import("../../../control-store/src/worker-main.js"),
    construct = (runtime: unknown) => new (runtime as Entrypoint)({}, control.bindings),
    organizationId = f.project.organizationId,
    keys = new Map<string, Record<string, unknown>>(),
    issued = { count: 0 },
    json = (value: unknown) => Response.json(value),
    unused = {},
    // WorkOS user API keys: the provider owns the key value and its metadata.
    authStatus = {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (!path.startsWith("/user-api-keys/")) return f.bindings.AUTH_STATUS.fetch(request);
        const action = path.slice("/user-api-keys/".length);
        const body = (await request.json()) as { name?: string; keyId?: string };
        if (action === "create") {
          const key = {
            id: `api_key_${String((issued.count += 1))}`,
            organization_id: organizationId,
            name: body.name,
            obfuscated_value: "sk_...abcd",
            permissions: ["projects:read"],
            expires_at: null,
            created_at: NOW,
            last_used_at: null,
          };
          keys.set(String(key.id), key);
          return json({
            request_id: newUlid(),
            replayed: false,
            key,
            value: `sk_${"a".repeat(40)}`,
          });
        }
        if (action === "revoke") return json({ revoked: keys.delete(String(body.keyId)) });
        return json({ data: [...keys.values()], next_cursor: null });
      },
    },
    checkout = (offer: "topup" | "paid", packs: number, state: "open" | "complete") => ({
      organization_id: organizationId,
      checkout_id: newUlid(),
      offer,
      state,
      payment_confirmed: state === "complete",
      url: state === "open" ? "https://checkout.stripe.com/c/pay/session" : null,
      expires_at: "2026-10-30T10:00:00.000Z",
      packs,
      credited_micros: state === "complete" ? String(packs * 1_000_000_000) : "0",
      revoked_micros: "0",
      paid_until: null,
      required_action: state === "open" ? "complete_checkout" : "none",
      billing_issue: null,
    }),
    recharge = {
      organization_id: organizationId,
      portal_available: true,
      enabled: false,
      revision: 0,
      status: "off",
      monthly_limit_minor: 1000,
      spent_minor: 0,
      currency: "usd",
      amount_minor: 900,
      credits: 1000,
      threshold_credits: 100,
      setup_url: null,
      invoice_url: null,
      billing_issue: null,
    },
    checkouts = new Map<string, ReturnType<typeof checkout>>(),
    // Stripe checkout, recharge and portal sessions, behind the billing Worker's private protocol.
    billing = {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname,
          body = (await request.json()) as Record<string, unknown>;
        if (path === "/checkouts") {
          const created = checkout(
            body["offer"] as "topup" | "paid",
            Number(body["packs"]),
            "open",
          );
          checkouts.set(created.checkout_id, created);
          return json(created);
        }
        if (path === "/checkout-status")
          return json({
            ...checkouts.get(String(body["checkoutId"])),
            state: "complete",
            payment_confirmed: true,
            url: null,
            credited_micros: "1000000000",
            required_action: "none",
          });
        if (path === "/recharge-configure")
          return json({
            ...recharge,
            enabled: body["enabled"],
            revision: Number(body["revision"]) + 1,
            status: body["enabled"] ? "on" : "off",
            monthly_limit_minor: body["monthlyLimitMinor"],
          });
        if (path === "/portal")
          return json({
            organization_id: organizationId,
            url: "https://billing.stripe.com/p/session",
            created_at: NOW,
          });
        return json(recharge);
      },
    },
    databaseWrites: unknown[] = [],
    // The PGCF database management Worker: compute observation and bounded SQL writes.
    databaseManagement = {
      readCompute: async (input: { projectId: string; environment: string }) => ({
        project_id: input.projectId,
        environment: input.environment,
        data_mode: "shared",
        observed_at: NOW,
        database: null,
      }),
      changeCompute: async () => ({ status: "absent" }),
      runComputeChange: async () => ({ status: "running" }),
      queryProject: async () => ({}),
      writeProject: async (input: { environment: string; statement: string }) => {
        databaseWrites.push(input);
        return {
          operation_id: newUlid(),
          environment: input.environment,
          state: "succeeded",
          command: input.statement.trim().split(/\s+/u)[0]?.toUpperCase(),
          affected_rows: 1,
          error: null,
        };
      },
      issueDatabaseAccess: async () => ({}),
      revokeDatabaseAccess: async () => ({}),
      databaseEvents: async () => ({ status: "absent" }),
      createDatabaseTable: async () => ({ status: "absent" }),
    },
    bindings = {
      ...f.bindings,
      AUTH_STATUS: authStatus,
      BILLING: billing,
      NEON_MANAGEMENT: databaseManagement,
      PUBLIC_ENTRY_RUNTIME: construct(entry.PublicEntryRuntime),
      PUBLIC_ENTRY_RETENTION_RUNTIME: construct(entry.PublicEntryRetentionRuntime),
      PUBLIC_ENTRY_RATE_LIMITER: { limit: async () => ({ success: true }) },
      CUSTOMER_FEEDBACK_RUNTIME: construct(entry.CustomerFeedbackRuntime),
      // The credit service's usage report over the real Core entrypoint; no day was rotated to the archive bucket.
      CREDIT_SERVICE: {
        readUsage: (input: unknown) =>
          readCreditLog(
            {
              core: construct(entry.CreditRuntime),
              creditLog: { get: async () => null },
              now: () => Date.parse(NOW),
            } as unknown as Dependencies,
            input,
          ),
      },
      PUBLIC_CREDIT_RUNTIME: construct(entry.PublicCreditRuntime),
      PRODUCT_API_RUNTIME: construct(entry.ProductApiRuntime),
      MAIL_MANAGEMENT_RUNTIME: construct(entry.MailManagementRuntime),
      ENVIRONMENT_SECRET_KEY_BASE64: Buffer.alloc(32, 0x43).toString("base64"),
      ENVIRONMENT_SECRET_KEY_VERSION: "1",
      // The GitHub source inspector and Cloudflare domain Workers are external; these flows never reach them.
      SOURCE_INSPECTOR: unused,
      CLOUDFLARE_DOMAIN_MANAGEMENT: Object.fromEntries(
        [
          "beginAuthorization",
          "getStatus",
          "configureDomains",
          "completeAuthorization",
          "planPaidDomain",
          "applyPaidDomain",
          "getPaidDomain",
          "deletePaidDomain",
        ].map((method) => [method, async () => Promise.reject(new Error("not used by this flow"))]),
      ),
    },
    /** The released clients' `fetch`: every request is answered by the Dev Control API Worker with these bindings. */
    fetchApi = async (input: RequestInfo | URL, init?: RequestInit) =>
      f.worker.fetch(new Request(input, init), bindings as never, { waitUntil: () => undefined });
  return {
    ...f,
    origin: connect.origin,
    bindings,
    fetchApi,
    databaseWrites,
    token: () => f.sessionToken(),
  };
}
