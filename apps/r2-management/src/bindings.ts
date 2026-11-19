export interface R2ManagementBindings {
  readonly RUNTIME_CONFIGURATION_STATE: "configured";
  readonly R2_MANAGEMENT_RUNTIME: unknown;
  readonly CLOUDFLARE_ACCOUNT_ID: string;
  readonly CLOUDFLARE_R2_API_TOKEN: string;
  readonly CLOUDFLARE_R2_ANALYTICS_TOKEN: string;
}

export class R2ManagementReadinessError extends TypeError {
  public readonly code = "r2_management_provider_not_ready";
  public constructor(public readonly binding: string) {
    super(`R2 management is not ready: ${binding} is missing or invalid`);
    this.name = "R2ManagementReadinessError";
  }
}

export function requireR2ManagementBindings(value: unknown): R2ManagementBindings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new R2ManagementReadinessError("binding inventory");
  }
  const bindings = value as Record<string, unknown>;
  const names = Object.getOwnPropertyNames(bindings);
  if (names.some((key) => /^CONTROL_(?:CORE|GLOBAL|DIRECTORY|SHARD_.*)$/u.test(key)))
    throw new R2ManagementReadinessError("mixed Control authority");
  const allowed = new Set([
    "RUNTIME_CONFIGURATION_STATE",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_R2_API_TOKEN",
    "CLOUDFLARE_R2_ANALYTICS_TOKEN",
    "R2_MANAGEMENT_RUNTIME",
  ]);
  if (names.some((key) => !allowed.has(key)))
    throw new R2ManagementReadinessError("binding inventory");
  if (bindings["RUNTIME_CONFIGURATION_STATE"] !== "configured") {
    throw new R2ManagementReadinessError("RUNTIME_CONFIGURATION_STATE");
  }
  if (!names.includes("R2_MANAGEMENT_RUNTIME")) {
    throw new R2ManagementReadinessError("R2_MANAGEMENT_RUNTIME");
  }
  if (
    typeof bindings["CLOUDFLARE_ACCOUNT_ID"] !== "string" ||
    !/^[0-9a-f]{32}$/u.test(bindings["CLOUDFLARE_ACCOUNT_ID"])
  ) {
    throw new R2ManagementReadinessError("CLOUDFLARE_ACCOUNT_ID");
  }
  if (
    typeof bindings["CLOUDFLARE_R2_API_TOKEN"] !== "string" ||
    bindings["CLOUDFLARE_R2_API_TOKEN"].length < 20 ||
    /(?:\s|\p{Cc})/u.test(bindings["CLOUDFLARE_R2_API_TOKEN"])
  ) {
    throw new R2ManagementReadinessError("CLOUDFLARE_R2_API_TOKEN");
  }
  if (
    typeof bindings["CLOUDFLARE_R2_ANALYTICS_TOKEN"] !== "string" ||
    bindings["CLOUDFLARE_R2_ANALYTICS_TOKEN"].length < 20 ||
    /(?:\s|\p{Cc})/u.test(bindings["CLOUDFLARE_R2_ANALYTICS_TOKEN"])
  ) {
    throw new R2ManagementReadinessError("CLOUDFLARE_R2_ANALYTICS_TOKEN");
  }
  return bindings as unknown as R2ManagementBindings;
}
