import type { GrowthD1 } from "./event-store.js";

export interface SourceHealthSnapshot {
  schema_version: 1;
  producer: "control_api";
  available: true;
  as_of: string;
  since: string;
  offered: number;
  unconfirmed: number;
}
export function parseSourceHealth(raw: unknown): SourceHealthSnapshot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new TypeError("invalid source health");
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !==
      "as_of,available,offered,producer,schema_version,since,unconfirmed" ||
    value["schema_version"] !== 1 ||
    value["producer"] !== "control_api" ||
    value["available"] !== true ||
    !Number.isSafeInteger(value["offered"]) ||
    (value["offered"] as number) < 0 ||
    !Number.isSafeInteger(value["unconfirmed"]) ||
    (value["unconfirmed"] as number) < 0 ||
    typeof value["as_of"] !== "string" ||
    typeof value["since"] !== "string"
  )
    throw new TypeError("invalid source health");
  for (const key of ["as_of", "since"] as const) {
    const at = Date.parse(value[key] as string);
    if (!Number.isFinite(at) || new Date(at).toISOString() !== value[key])
      throw new TypeError("invalid source health time");
  }
  if (
    Date.parse(value["since"]) > Date.parse(value["as_of"]) ||
    Date.parse(value["as_of"]) > Date.now() + 300000
  )
    throw new TypeError("invalid source health range");
  return value as unknown as SourceHealthSnapshot;
}
export async function writeSourceHealth(db: GrowthD1, input: unknown): Promise<void> {
  const value = parseSourceHealth(input);
  await db
    .prepare(
      "INSERT INTO growth_source_health(producer,as_of,body) VALUES(?,?,?) ON CONFLICT(producer) DO UPDATE SET as_of=excluded.as_of,body=excluded.body WHERE excluded.as_of>growth_source_health.as_of",
    )
    .bind(value.producer, value.as_of, JSON.stringify(value))
    .run();
}
