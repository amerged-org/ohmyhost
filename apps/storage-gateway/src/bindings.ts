export interface StorageGatewayBindings {
  readonly GATEWAY_RATE_LIMITER?:
    | { limit(input: { key: string }): Promise<{ success: boolean }> }
    | undefined;
  readonly STORAGE_SCOPE_LOG_LIMITER?:
    | { limit(input: { key: string }): Promise<{ success: boolean }> }
    | undefined;
  readonly RUNTIME_CONFIGURATION_STATE: "configured";
  readonly STORAGE_GATEWAY_RUNTIME?: unknown;
  readonly STORAGE_DATA_RUNTIME?: unknown;
  readonly CONTROL_CORE_DATABASE_ID?: string;
  readonly CLOUDFLARE_ACCOUNT_ID: string;
  readonly CLOUDFLARE_R2_API_TOKEN: string;
  readonly CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID: string;
}

export interface StorageGatewayScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly dataEnvironmentId: string;
}
export function readStorageGatewayScope(value: unknown): StorageGatewayScope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "dataEnvironmentId,environmentId,organizationId,projectId" ||
    Object.values(record).some(
      (value) => typeof value !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(value),
    )
  )
    return null;
  return record as unknown as StorageGatewayScope;
}

export class StorageGatewayReadinessError extends TypeError {
  public readonly code = "storage_gateway_provider_not_ready";
  public constructor(public readonly binding: string) {
    super(`Storage gateway is not ready: ${binding} is missing or invalid`);
    this.name = "StorageGatewayReadinessError";
  }
}

export function requireStorageGatewayBindings(value: unknown): StorageGatewayBindings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StorageGatewayReadinessError("binding inventory");
  }
  const bindings = value as Record<string, unknown>;
  const names = Object.getOwnPropertyNames(bindings);
  // The private Core capability is the only Control authority: no direct Core database binding.
  if (names.some((k) => /^CONTROL_(?:CORE|GLOBAL|DIRECTORY|SHARD_.*)$/u.test(k)))
    throw new StorageGatewayReadinessError("mixed Control authority");
  const allowed = new Set([
    "STORAGE_SCOPE_LOG_LIMITER",
    "GATEWAY_RATE_LIMITER",
    "RUNTIME_CONFIGURATION_STATE",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_R2_API_TOKEN",
    "CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID",
    "CONTROL_CORE_DATABASE_ID",
    "STORAGE_GATEWAY_RUNTIME",
    "STORAGE_DATA_RUNTIME",
  ]);
  if (names.some((k) => !allowed.has(k)))
    throw new StorageGatewayReadinessError("binding inventory");
  if (bindings["RUNTIME_CONFIGURATION_STATE"] !== "configured") {
    throw new StorageGatewayReadinessError("RUNTIME_CONFIGURATION_STATE");
  }
  if (
    typeof bindings["CLOUDFLARE_ACCOUNT_ID"] !== "string" ||
    !/^[0-9a-f]{32}$/u.test(bindings["CLOUDFLARE_ACCOUNT_ID"])
  ) {
    throw new StorageGatewayReadinessError("CLOUDFLARE_ACCOUNT_ID");
  }
  if (
    typeof bindings["CLOUDFLARE_R2_API_TOKEN"] !== "string" ||
    bindings["CLOUDFLARE_R2_API_TOKEN"].length < 20 ||
    /(?:\s|\p{Cc})/u.test(bindings["CLOUDFLARE_R2_API_TOKEN"])
  ) {
    throw new StorageGatewayReadinessError("CLOUDFLARE_R2_API_TOKEN");
  }
  if (
    typeof bindings["CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID"] !== "string" ||
    !/^[A-Za-z0-9]{16,128}$/u.test(bindings["CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID"])
  ) {
    throw new StorageGatewayReadinessError("CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID");
  }
  return bindings as unknown as StorageGatewayBindings;
}
