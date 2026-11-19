/** User-authored project context is data, never an authorization or secret store. */
export function normalizeProjectNotes(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Project notes must be text");
  const text = value.replace(/\r\n?|\u2028|\u2029/gu, "\n");
  if (
    new TextEncoder().encode(text).length > 16384 ||
    text.split("\n").length > 250 ||
    /\p{Cc}/u.test(text.replace(/[\n\t]/gu, ""))
  )
    throw new TypeError("Project notes exceed the text limits");
  if (
    /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]{16,}|\bsk_(?:live_|test_)?[A-Za-z0-9_-]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/iu.test(
      text,
    ) ||
    /^\s*[A-Z_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|DATABASE_URL)\s*[:=]\s*["']?\S{8,}/imu.test(text)
  )
    throw new TypeError("Do not store credentials in project notes");
  for (const match of text.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"`]+/giu)) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    if (
      url.username ||
      url.password ||
      [...url.searchParams.keys()].some((key) =>
        /^(?:access_token|token|password|secret|ticket|x-amz-signature|x-amz-credential|x-goog-signature|sig)$/iu.test(
          key,
        ),
      )
    )
      throw new TypeError("Do not store access or signed URLs in project notes");
  }
  return text;
}
