import { DurableObject } from "cloudflare:workers";
import {
  normalizeBrowserDuration,
  type BrowserBillingScope,
  type BrowserGatewayRuntime,
} from "@ohmyhost/platform";

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const RETRY_MS = 30_000;
const SETTLE_TIMEOUT_MS = 10_000;
export interface BrowserMeasurement {
  readonly scope: BrowserBillingScope;
  readonly reservationId: string;
  readonly browserMs: string | null;
}
interface JournalEnvironment {
  readonly BROWSER_RUNTIME: BrowserGatewayRuntime;
}
function measurement(raw: unknown): BrowserMeasurement {
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(",") !== "browserMs,reservationId,scope"
  )
    throw new TypeError("invalid browser measurement");
  const value = raw as Record<string, unknown>,
    scope = value["scope"];
  if (
    typeof scope !== "object" ||
    scope === null ||
    Array.isArray(scope) ||
    Object.keys(scope).sort().join(",") !== "environmentId,organizationId,projectId"
  )
    throw new TypeError("invalid browser measurement");
  const ids = scope as Record<string, unknown>;
  if (
    [ids["organizationId"], ids["projectId"], ids["environmentId"], value["reservationId"]].some(
      (id) => typeof id !== "string" || !ULID.test(id),
    )
  )
    throw new TypeError("invalid browser measurement");
  const ms = value["browserMs"];
  if (ms !== null && (typeof ms !== "string" || normalizeBrowserDuration(ms) !== ms))
    throw new TypeError("invalid browser measurement");
  return {
    scope: {
      organizationId: ids["organizationId"] as string,
      projectId: ids["projectId"] as string,
      environmentId: ids["environmentId"] as string,
    },
    reservationId: value["reservationId"] as string,
    browserMs: ms as string | null,
  };
}
/** A content-free receipt and its alarm are one durable transaction; no HTML, PDF or key is stored. */
export class BrowserSettlementJournal extends DurableObject<JournalEnvironment> {
  async record(raw: unknown): Promise<void> {
    const job = measurement(raw);
    if (this.ctx.id.name !== job.reservationId)
      throw new TypeError("invalid browser journal identity");
    await this.ctx.storage.transaction(async (tx) => {
      const existing = await tx.get<BrowserMeasurement>("measurement");
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(job))
        throw new Error("browser measurement conflict");
      await tx.put("measurement", job);
      await tx.setAlarm(Date.now() + 1_000);
    });
  }
  async alarm(): Promise<void> {
    const raw = await this.ctx.storage.get<BrowserMeasurement>("measurement");
    if (raw === undefined) return;
    // Persist the next attempt before touching Core, so a hung RPC or process termination cannot consume the only alarm.
    await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.env.BROWSER_RUNTIME.settle(measurement(raw)),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            // Resetting the object cancels its pending RPC; the separately persisted next alarm survives.
            this.ctx.abort("browser settlement timeout", { retryAlarm: false });
            reject(new Error("browser settlement timeout"));
          }, SETTLE_TIMEOUT_MS);
        }),
      ]);
      if (result.settled || result.reason === "already_resolved")
        await this.ctx.storage.deleteAll();
    } catch {
      /* The next alarm was already persisted; no customer data is logged. */
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
