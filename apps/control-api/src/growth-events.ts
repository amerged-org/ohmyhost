import { bounded } from "./growth-deadline.js";
import type { GrowthEventV1 } from "@ohmyhost/contracts/growth-events";
import type { BrowserGrowthHint } from "./browser-login.js";

export interface GrowthCollector {
  collect(event: GrowthEventV1): Promise<{ accepted: boolean }>;
}
export interface GrowthHealthCounter {
  record(input: {
    producer: "control_api";
    event_id: string;
    outcome: "offered" | "gap";
    occurred_at: string;
  }): Promise<void>;
}
export interface GrowthExecutionContext {
  waitUntil(work: Promise<unknown>): void;
}
type EventInput = Pick<GrowthEventV1, "event_name" | "outcome" | "transport"> &
  Partial<Pick<GrowthEventV1, "flow_id" | "account_id" | "organization_id" | "error_class">>;

// Diagnostics are bounded per isolate and event type; product-use hints bypass this cap so the
// first actual authorized call cannot be hidden by a burst of login diagnostics.
const diagnosticWindows = new Map<string, { minute: number; count: number }>();
function allowDiagnostic(name: GrowthEventV1["event_name"], at: number): boolean {
  if (name === "product_call_succeeded" || name === "product_call_failed") return true;
  const minute = Math.floor(at / 60_000);
  const window = diagnosticWindows.get(name);
  if (!window || window.minute !== minute) {
    diagnosticWindows.set(name, { minute, count: 1 });
    return true;
  }
  window.count += 1;
  return window.count <= 60;
}

/** A private, bounded hint. Failure is a measurement gap, never a product failure. */
export function createGrowthReporter(
  collector: GrowthCollector | undefined,
  context: GrowthExecutionContext,
  environment: GrowthEventV1["platform_environment"],
  health?: GrowthHealthCounter,
  platformVersion?: string,
  requestCountry?: unknown,
) {
  return (input: EventInput): void => {
    try {
      const now = new Date().toISOString();
      const event: GrowthEventV1 = {
        schema_version: 1,
        event_id: crypto.randomUUID(),
        event_name: input.event_name,
        outcome: input.outcome,
        occurred_at: now,
        received_at: now,
        platform_environment: environment,
        producer: "control_api",
        evidence_kind: "event",
        flow_id: input.flow_id ?? null,
        account_id: input.account_id ?? null,
        organization_id: input.organization_id ?? null,
        project_id: null,
        operation_id: null,
        deployment_id: null,
        transport: input.transport,
        client_class: input.transport === "portal" ? "browser" : "unknown",
        client_class_trust: input.transport === "portal" ? "verified" : "unknown",
        error_class: input.error_class ?? null,
        campaign_key: null,
        request_country:
          input.transport === "portal" &&
          typeof requestCountry === "string" &&
          /^[A-Z]{2}$/.test(requestCountry) &&
          !["XX", "T1"].includes(requestCountry)
            ? requestCountry
            : null,
        ...(platformVersion === undefined ? {} : { platform_version: platformVersion }),
      };
      const count = async (outcome: "offered" | "gap") => {
        try {
          await bounded(
            Promise.resolve().then(() => {
              if (!health) throw new Error("health unavailable");
              return health.record({
                producer: "control_api",
                event_id: event.event_id,
                outcome,
                occurred_at: now,
              });
            }),
          );
        } catch {
          console.warn("growth health counter unavailable");
        }
      };
      context.waitUntil(count("offered"));
      if (!allowDiagnostic(input.event_name, Date.now())) {
        context.waitUntil(count("gap"));
        return;
      }
      context.waitUntil(
        bounded(
          Promise.resolve()
            .then(() => collector?.collect(event))
            .then((result) => {
              if (!result?.accepted) throw new Error("growth unavailable");
            }),
        ).catch(async () => {
          console.warn("growth measurement gap: collection unavailable");
          await count("gap");
        }),
      );
    } catch {
      console.warn("growth measurement gap: scheduling unavailable");
    }
  };
}
export function reportBrowserGrowth(
  report: ReturnType<typeof createGrowthReporter>,
  hint: BrowserGrowthHint,
): void {
  report({
    event_name: hint.name,
    outcome:
      hint.name === "login_failed"
        ? "failed"
        : hint.name === "portal_login_succeeded"
          ? "succeeded"
          : "attempted",
    transport: "portal",
    flow_id: hint.flowId,
    account_id: hint.accountId ?? null,
    organization_id: hint.organizationId ?? null,
    error_class: hint.errorClass ?? null,
  });
}
