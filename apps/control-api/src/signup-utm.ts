/** Campaign metadata is optional context, never a login or referral authorization condition. */
export function signupUtm(parameters: URLSearchParams): Record<string, string> {
  const latest = new Map<string, string>();
  for (const [rawKey, value] of parameters) {
    const key = rawKey.toLowerCase();
    if (/^utm_[a-z0-9_]{1,60}$/u.test(key)) latest.set(key, value);
  }
  const result: Record<string, string> = {};
  for (const [key, value] of latest) {
    if (Object.keys(result).length >= 20) break;
    if ([...value].length > 256) continue;
    const candidate = { ...result, [key]: value };
    if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength <= 1024) result[key] = value;
  }
  return result;
}
