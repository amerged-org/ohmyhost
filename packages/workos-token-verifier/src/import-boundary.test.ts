import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

describe("WorkOS verifier import boundary", () => {
  it("loads only pure token contracts and has no provider-management surface", async () => {
    const source = await readFile(resolve(sourceDirectory, "index.ts"), "utf8");

    expect(source).toContain("@ohmyhost/workos-auth-contracts/tokens");
    expect(source).toContain("@ohmyhost/workos-auth-contracts/parsing");
    expect(source).toContain("globalThis.crypto.subtle.verify");
    expect(source).not.toMatch(/process\.env|\bfetch\s*\(|management-rpc|device-flow|webhooks/u);
    expect(source).not.toMatch(/WORKOS_(?:API_KEY|WEBHOOK_SECRET)|client_secret/u);
    expect(source).not.toMatch(/\bBuffer\b|WorkosJwtSignatureVerifier|signature:\s*Workos/u);
  });
});
