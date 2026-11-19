import { GithubProviderInputError, type GithubProviderErrorCode } from "./errors.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireSafePositiveInteger(value: unknown, code: GithubProviderErrorCode): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new GithubProviderInputError(code);
  }
  return value;
}

export function requireBoundedString(
  value: unknown,
  maximumLength: number,
  code: GithubProviderErrorCode,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new GithubProviderInputError(code);
  }
  return value;
}

export function isLowercaseNonzeroSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value) && value !== "0".repeat(40);
}
