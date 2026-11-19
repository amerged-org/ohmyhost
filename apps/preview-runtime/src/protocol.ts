const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
// 256 bits occupy 52 unpadded base32 characters; the final four bits must be zero.
const TOKEN = /^[a-z2-7]{51}[aq]$/u;
const SUFFIXES = new Set(["preview.dev.omh.st", "preview.omh.st"]);

export function previewId(value: unknown): string {
  if (typeof value !== "string" || !ULID.test(value)) throw new Error("preview_identity_invalid");
  return value;
}

export function previewTokenFromRequest(request: Request, suffix: string): string | null {
  if (!SUFFIXES.has(suffix)) throw new Error("preview_host_configuration_invalid");
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  const ending = `.${suffix}`;
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !url.hostname.endsWith(ending)
  )
    return null;
  const token = url.hostname.slice(0, -ending.length);
  return TOKEN.test(token) ? token : null;
}

export async function hashPreviewToken(token: string): Promise<string> {
  if (!TOKEN.test(token)) throw new Error("preview_token_invalid");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function unavailable(status = 503): Response {
  return new Response(status === 404 ? "Not found" : "Preview unavailable", {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
import type { BrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import type { SourceVersion } from "@ohmyhost/contracts/previews";
import { isBrowserMutationAllowed } from "@ohmyhost/wfp-dispatch/browser-security";
import { sameSourceVersion } from "./source-sync.js";

export function isPreviewMutationAllowed(
  request: Request,
  policy: BrowserPolicy | undefined,
  applied: SourceVersion,
  target: SourceVersion | null,
  recorded: SourceVersion | null,
): boolean {
  return (
    sameSourceVersion(target, applied) &&
    sameSourceVersion(recorded, applied) &&
    isBrowserMutationAllowed(request, policy)
  );
}
