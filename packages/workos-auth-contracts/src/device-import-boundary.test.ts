import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("public Device Flow export boundary", () => {
  it("exports a dedicated graph without management, webhook, or token-verifier modules", async () => {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
      exports: Record<string, { source: string }>;
    };
    const deviceExport = manifest.exports["./device-flow"];
    expect(deviceExport?.source).toBe("./src/device-flow.ts");
    if (deviceExport === undefined) throw new Error("Device Flow export is missing");

    const source = await readFile(resolve(packageRoot, deviceExport.source), "utf8");
    expect(source).toMatch(/from "\.\/parsing\.js"/u);
    expect(source).not.toMatch(/from "\.\/(?:index|management-rpc|webhooks|tokens)\.js"/u);
    expect(source).not.toMatch(
      /export class WorkosDeviceFlowSession|private readonly tokenEndpoint/u,
    );
    expect(source).not.toMatch(/WORKOS_(?:API_KEY|WEBHOOK_SECRET)|client_secret/u);
  });
});
