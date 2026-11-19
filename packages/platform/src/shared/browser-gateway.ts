/** The private Browser gateway / Core contract. HTML and PDF bytes never cross the Core boundary. */
export const BROWSER_HTML_MAX_BYTES = 1024 * 1024;
export const BROWSER_PDF_MAX_BYTES = 10 * 1024 * 1024;
export const BROWSER_MAX_PAGES = 50;
export const BROWSER_MAX_MS = 30_000;
export const BROWSER_MAX_OPEN_CALLS = 8;
export const BROWSER_METER = "browser.duration";
export const BROWSER_METER_UNIT = "millisecond";
export const BROWSER_KEY_NAME = "OHMYHOST_BROWSER_KEY";
export const BROWSER_BASE_URL_NAME = "OHMYHOST_BROWSER_BASE_URL";
export const BROWSER_KEY_PATTERN = /^omh_browser_([0-7][0-9A-HJKMNP-TV-Z]{25})_[A-Za-z0-9_-]{43}$/u;
export const BROWSER_GATEWAY_ORIGIN_PRODUCTION = "https://browser.ohmyho.st";
export const BROWSER_GATEWAY_ORIGIN_DEVELOPMENT = "https://browser.dev.ohmyho.st";

export function browserBaseUrl(origin: string): string {
  return `${origin}/v1`;
}
export function createBrowserKey(projectId: string, secret: string): string {
  const key = `omh_browser_${projectId}_${secret}`;
  if (!BROWSER_KEY_PATTERN.test(key)) throw new TypeError("Invalid browser gateway key");
  return key;
}
export interface BrowserBillingScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}
export interface BrowserKeyScope extends BrowserBillingScope {
  /** Digest-only authorization snapshot; no plaintext key crosses Core. */
  readonly keySha256: string;
  readonly keyRevision: number;
  readonly deploymentId: string;
  readonly revisionId: string;
  readonly ownershipVersion: number;
  readonly billingEpochId: string;
}
export type BrowserDenial =
  | "paid_plan_required"
  | "insufficient_organization_credits"
  | "project_budget_exceeded"
  | "too_many_open_calls"
  | "unavailable";
export type BrowserAdmitResult =
  | { readonly admitted: true; readonly reservedMicros: number }
  | { readonly admitted: false; readonly denial: BrowserDenial };
export type BrowserSettleResult =
  | { readonly settled: true; readonly chargedMicros: number }
  | { readonly settled: false; readonly reason: "unknown_reservation" | "already_resolved" };
export interface BrowserGatewayRuntime {
  authorizeKey(input: {
    readonly projectId: string;
    readonly keySha256: string;
  }): Promise<BrowserKeyScope | null>;
  admit(input: {
    readonly scope: BrowserKeyScope;
    readonly reservationId: string;
  }): Promise<BrowserAdmitResult>;
  /** A null duration marks missing measurement and is charged zero, never a time estimate. */
  settle(input: {
    readonly scope: BrowserBillingScope;
    readonly reservationId: string;
    readonly browserMs: string | null;
  }): Promise<BrowserSettleResult>;
  release(input: {
    readonly scope: BrowserBillingScope;
    readonly reservationId: string;
    readonly reason: "provider_error" | "client_aborted";
  }): Promise<{ readonly released: boolean }>;
  sweep(input: {
    readonly olderThanMs: number;
    readonly limit: number;
  }): Promise<{ readonly released: number }>;
}
/** A published duration rate: credit micros per unitsPerCharge milliseconds. */
export interface BrowserCardRate {
  readonly unitsPerCharge: bigint;
  readonly creditMicros: bigint;
}
/** Normalize a bounded provider decimal, including exponent notation, without floating-point rounding. */
export function normalizeBrowserDuration(value: string): string | null {
  if (value.length > 64) return null;
  const match = /^(0|[1-9]\d{0,14})(?:\.(\d{1,20}))?(?:[eE]([+-]?\d{1,2}))?$/u.exec(value);
  if (match === null) return null;
  const whole = match[1] as string,
    fraction = match[2] ?? "",
    exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 40) return null;
  const digits = whole + fraction,
    position = whole.length + exponent;
  const expanded =
    position <= 0
      ? `0.${"0".repeat(-position)}${digits}`
      : position >= digits.length
        ? digits + "0".repeat(position - digits.length)
        : `${digits.slice(0, position)}.${digits.slice(position)}`;
  let [integer = "0", decimals = ""] = expanded.split(".");
  integer = integer.replace(/^0+(?=\d)/u, "");
  decimals = decimals.replace(/0+$/u, "");
  if (integer.length > 15 || decimals.length > 20) return null;
  return decimals.length === 0 ? integer : `${integer}.${decimals}`;
}
/** Round the exact rational charge up only at the final micro-credit boundary. */
export function browserCreditMicros(browserMs: number | string, rate: BrowserCardRate): number {
  if (typeof browserMs === "number" && (!Number.isSafeInteger(browserMs) || browserMs < 0))
    throw new RangeError("Invalid browser duration or rate");
  const normalized = normalizeBrowserDuration(String(browserMs));
  if (normalized === null || rate.unitsPerCharge <= 0n || rate.creditMicros < 0n)
    throw new RangeError("Invalid browser duration or rate");
  const [integer = "0", fraction = ""] = normalized.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(integer) * scale + BigInt(fraction || "0"),
    divisor = rate.unitsPerCharge * scale;
  const charge = (numerator * rate.creditMicros + divisor - 1n) / divisor;
  if (charge > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError("Browser charge exceeds safe integers");
  return Number(charge);
}
