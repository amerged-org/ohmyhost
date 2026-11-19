import { type DevAccessMode } from "@ohmyhost/database";

import { type ProductSurfaceContext } from "./contracts.js";
import { DevAccessUnavailableError } from "./dev-access.js";

export interface DevAccessView {
  readonly mode: DevAccessMode;
  readonly shareUrl: string | null;
}

export interface DevAccessManagementPort {
  ensure(context: ProductSurfaceContext): Promise<DevAccessView>;
  setMode(
    context: ProductSurfaceContext,
    mode: DevAccessMode,
    idempotencyKey: string,
  ): Promise<DevAccessView>;
  rotate(context: ProductSurfaceContext, idempotencyKey: string): Promise<DevAccessView>;
  revoke(context: ProductSurfaceContext, idempotencyKey: string): Promise<DevAccessView>;
}

export function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}
export function readAccessView(value: string): DevAccessView {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new DevAccessUnavailableError();
  const view = parsed as Record<string, unknown>;
  if (
    Object.keys(view).sort().join(",") !== "mode,shareUrl" ||
    (view["mode"] !== "protected" && view["mode"] !== "public") ||
    (view["mode"] === "public" && view["shareUrl"] !== null) ||
    (view["shareUrl"] !== null &&
      (typeof view["shareUrl"] !== "string" ||
        !/^https:\/\/[^/?#]+\/\.ohmyhost\/dev-access\/redeem\?stage=dev&ticket=[A-Za-z0-9_-]{43}$/u.test(
          view["shareUrl"],
        )))
  )
    throw new DevAccessUnavailableError();
  return { mode: view["mode"], shareUrl: view["shareUrl"] as string | null };
}
