/** Worker-private verifier policy. Neither keys nor this parsed policy cross a service binding. */
export interface AdditionalWebhookSecret {
  readonly secret: string;
  readonly expiresAtMs: number;
}

const invalid = () => new TypeError("Additional webhook verification policy is invalid");

/** Exact-purpose optional JSON: [] or one {secret, expiresAt} with a canonical UTC deadline. */
export function parseAdditionalWebhookSecrets(
  value: unknown,
  current: string,
): readonly AdditionalWebhookSecret[] {
  if (value === undefined) return [];
  if (typeof value !== "string" || value.length > 4096) throw invalid();
  let entries: unknown;
  try {
    entries = JSON.parse(value) as unknown;
  } catch {
    throw invalid();
  }
  if (!Array.isArray(entries) || entries.length > 1) throw invalid();
  if (entries.length === 0) return [];
  const entry: unknown = entries[0];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw invalid();
  if (Object.keys(entry).sort().join(",") !== "expiresAt,secret") throw invalid();
  const secret: unknown = Reflect.get(entry, "secret");
  const expiry: unknown = Reflect.get(entry, "expiresAt");
  if (
    typeof secret !== "string" ||
    !/^[\x21-\x7e]{1,512}$/u.test(secret) ||
    secret === current ||
    typeof expiry !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(expiry)
  )
    throw invalid();
  const at = Date.parse(expiry);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== expiry) throw invalid();
  return Object.freeze([Object.freeze({ secret, expiresAtMs: at })]);
}

/** Evaluate expiry at signature verification time, using the same injected clock snapshot. */
export function activeAdditionalWebhookSecrets(
  policy: readonly AdditionalWebhookSecret[],
  now: Date,
): readonly string[] {
  const entry = policy[0];
  if (entry === undefined) return [];
  const at = now.getTime();
  if (!Number.isFinite(at)) throw invalid();
  return entry.expiresAtMs > at ? [entry.secret] : [];
}
