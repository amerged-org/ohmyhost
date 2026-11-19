import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export interface GrowthHealthRecord {
  producer: "control_api";
  event_id: string;
  outcome: "offered" | "gap";
  occurred_at: string;
}
export interface GrowthHealthSnapshot {
  available: true;
  as_of: string;
  since: string;
  offered: number;
  unconfirmed: number;
}
interface Sql {
  exec<T = Record<string, unknown>>(sql: string, ...values: unknown[]): { toArray(): T[] };
}
interface Context {
  storage: {
    sql: Sql;
    transactionSync<T>(run: () => T): T;
    getAlarm?(): Promise<number | null>;
    setAlarm?(at: number): Promise<void>;
  };
}
interface HealthEnvironment {
  GROWTH_ANALYTICS?: {
    collectSourceHealth(
      input: GrowthHealthSnapshot & { schema_version: 1; producer: "control_api" },
    ): Promise<{ accepted: boolean }>;
  };
}
interface HealthStub {
  record(input: GrowthHealthRecord): Promise<void>;
  read(input: { hours: number }): Promise<GrowthHealthSnapshot>;
}
interface Bindings {
  GROWTH_HEALTH: { idFromName(name: string): unknown; get(id: unknown): HealthStub };
}

/** Independent of the Growth queue/D1: counts acknowledgements, not proven event loss. */
export class GrowthTelemetryHealth extends DurableObject {
  private readonly state: Context;
  private readonly healthEnvironment: HealthEnvironment;
  constructor(ctx: Context, env: HealthEnvironment) {
    super(ctx, env);
    this.state = ctx;
    this.healthEnvironment = env;
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS health_seen(event_id TEXT NOT NULL,outcome TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(event_id,outcome)); CREATE TABLE IF NOT EXISTS health_minutes(minute INTEGER PRIMARY KEY,offered INTEGER NOT NULL DEFAULT 0,unconfirmed INTEGER NOT NULL DEFAULT 0)",
    );
  }
  async record(input: GrowthHealthRecord): Promise<void> {
    const raw = input as unknown as Record<string, unknown>;
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).sort().join(",") !== "event_id,occurred_at,outcome,producer" ||
      raw["producer"] !== "control_api" ||
      typeof raw["event_id"] !== "string" ||
      !/^[0-9a-f-]{36}$/u.test(raw["event_id"]) ||
      !["offered", "gap"].includes(String(raw["outcome"])) ||
      typeof raw["occurred_at"] !== "string"
    )
      throw new TypeError("growth_health_invalid");
    const at = Date.parse(input.occurred_at),
      now = Date.now(),
      horizon = now - 30 * 86400000;
    if (
      !Number.isFinite(at) ||
      new Date(at).toISOString() !== input.occurred_at ||
      at > now + 60000 ||
      at < horizon
    )
      throw new TypeError("growth_health_time_invalid");
    this.state.storage.transactionSync(() => {
      const sql = this.state.storage.sql;
      sql.exec(
        "INSERT OR IGNORE INTO health_seen(event_id,outcome,at) VALUES(?,?,?)",
        input.event_id,
        input.outcome,
        at,
      );
      const changed = sql.exec<{ n: number }>("SELECT changes() n").toArray()[0]?.n ?? 0;
      if (changed) {
        sql.exec(
          "INSERT INTO health_minutes(minute,offered,unconfirmed) VALUES(?,?,?) ON CONFLICT(minute) DO UPDATE SET offered=offered+excluded.offered,unconfirmed=unconfirmed+excluded.unconfirmed",
          Math.floor(at / 60000) * 60000,
          input.outcome === "offered" ? 1 : 0,
          input.outcome === "gap" ? 1 : 0,
        );
      }
      sql.exec("DELETE FROM health_seen WHERE at<?", horizon);
      sql.exec("DELETE FROM health_minutes WHERE minute<?", horizon);
    });
    if (this.state.storage.setAlarm && (await this.state.storage.getAlarm?.()) == null)
      await this.state.storage.setAlarm(Date.now() + 5000);
  }
  async alarm(): Promise<void> {
    try {
      const snapshot = await this.read({ hours: 24 });
      const result = await this.healthEnvironment.GROWTH_ANALYTICS?.collectSourceHealth({
        ...snapshot,
        schema_version: 1,
        producer: "control_api",
      });
      if (!result?.accepted) console.warn("growth source health publication unavailable");
    } catch {
      console.warn("growth source health publication unavailable");
    } finally {
      await this.state.storage.setAlarm?.(Date.now() + 300000);
    }
  }
  async read(input: { hours: number }): Promise<GrowthHealthSnapshot> {
    if (
      !input ||
      Object.keys(input).join(",") !== "hours" ||
      !Number.isInteger(input.hours) ||
      input.hours < 1 ||
      input.hours > 720
    )
      throw new TypeError("growth_health_window_invalid");
    const now = new Date(),
      since = new Date(now.getTime() - input.hours * 3600000);
    this.state.storage.sql.exec(
      "DELETE FROM health_seen WHERE at<?",
      now.getTime() - 30 * 86400000,
    );
    this.state.storage.sql.exec(
      "DELETE FROM health_minutes WHERE minute<?",
      now.getTime() - 30 * 86400000,
    );
    const row = this.state.storage.sql
      .exec<{
        offered: number;
        unconfirmed: number;
      }>(
        "SELECT coalesce(sum(offered),0) offered,coalesce(sum(unconfirmed),0) unconfirmed FROM health_minutes WHERE minute>=?",
        since.getTime(),
      )
      .toArray()[0];
    return {
      available: true,
      as_of: now.toISOString(),
      since: since.toISOString(),
      offered: row?.offered ?? 0,
      unconfirmed: row?.unconfirmed ?? 0,
    };
  }
}

/** Fixed private read only; no customer route exposes source counters. */
export class GrowthHealthReadService extends WorkerEntrypoint<Bindings> {
  read(input: { hours: number }): Promise<GrowthHealthSnapshot> {
    const id = this.env.GROWTH_HEALTH.idFromName("control-api");
    return this.env.GROWTH_HEALTH.get(id).read(input);
  }
}
