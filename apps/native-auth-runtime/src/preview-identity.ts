import { createHmac } from "node:crypto";

/** A QA Durable Object's persisted Auth generation, independent of source and container generations. */
export interface NativePreviewIdentity {
  readonly previewId: string;
  readonly authGeneration: number;
}

export function readNativePreviewIdentity(value: unknown): NativePreviewIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("auth_unavailable");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2 ||
    typeof input["previewId"] !== "string" ||
    !/^(?:[a-f0-9]{32}|[0-7][0-9A-HJKMNP-TV-Z]{25})$/u.test(input["previewId"]) ||
    typeof input["authGeneration"] !== "number" ||
    !Number.isSafeInteger(input["authGeneration"]) ||
    input["authGeneration"] < 1 ||
    input["authGeneration"] > 2_147_483_647
  )
    throw new Error("auth_unavailable");
  return { previewId: input["previewId"], authGeneration: input["authGeneration"] };
}

/** A preview signature never authenticates a deployed realm or another Auth generation. */
export function nativePreviewSecret(secret: string, identity: NativePreviewIdentity): string {
  const preview = readNativePreviewIdentity(identity);
  if (typeof secret !== "string" || secret.length < 32) throw new Error("auth_unavailable");
  return createHmac("sha256", secret)
    .update(
      JSON.stringify([
        "ohmyhost.native-stable-preview/v1",
        preview.previewId,
        preview.authGeneration,
      ]),
    )
    .digest("hex");
}
