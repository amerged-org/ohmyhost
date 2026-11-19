import { describe, expect, it } from "vitest";

import { normalizeBrowserPolicy, parseBrowserPolicy } from "../src/browser-capabilities.js";
import { parseOhmyhostConfig } from "../src/index.js";

describe("browser capability policy", () => {
  it("normalizes explicit resource permissions separately from secure defaults", () => {
    const defaults = normalizeBrowserPolicy(undefined);
    expect(defaults).toEqual({
      connect: [],
      scripts: [],
      styles: [],
      images: [],
      fonts: [],
      frames: [],
      frameAncestors: [],
      workers: { self: false, blob: false },
      cors: { origins: [], credentials: false },
    });
    const input = {
      connect: ["wss://events.example.com", "https://api.example.com:8443"],
      scripts: ["https://scripts.example.com"],
      styles: ["https://styles.example.com"],
      images: ["https://images.example.com"],
      fonts: ["https://fonts.example.com"],
      frames: ["https://frames.example.com"],
      frameAncestors: ["https://portal.example.com"],
      workers: { self: true, blob: true },
      cors: { origins: ["https://frontend.example.com"], credentials: true },
    };
    const policy = normalizeBrowserPolicy(input);
    expect(policy).toEqual({
      ...input,
      connect: ["https://api.example.com:8443", "wss://events.example.com"],
    });
    expect(
      parseOhmyhostConfig({
        version: 1,
        project: "browser-app",
        build: { install: "pnpm install", command: "pnpm build", output: "dist" },
        runtime: { mode: "edge", browser: input },
      }),
    ).toMatchObject({ runtime: { browser: policy } });
    input.connect[0] = "https://changed.example.com";
    expect(policy.connect).not.toContain("https://changed.example.com");
    for (const value of [policy, policy.connect, policy.workers, policy.cors, policy.cors.origins])
      expect(Object.isFrozen(value)).toBe(true);
  });

  it("rejects wildcards, insecure or non-origin URLs and malformed grants", () => {
    for (const value of [
      null,
      [],
      { unknown: [] },
      { scripts: ["https://*.example.com"] },
      { connect: ["http://api.example.com"] },
      { connect: ["ws://events.example.com"] },
      { images: ["wss://images.example.com"] },
      { fonts: ["https://user:password@fonts.example.com"] },
      { scripts: ["https://scripts.example.com/path"] },
      { styles: ["https://styles.example.com?key=value"] },
      { frames: ["https://frames.example.com#fragment"] },
      { frameAncestors: ["https://localhost"] },
      { connect: ["https://127.0.0.1"] },
      { scripts: ["'unsafe-inline'"] },
      { connect: ["https://api.example.com", "https://api.example.com"] },
      { images: Array.from({ length: 17 }, (_, i) => `https://image${i}.example.com`) },
      { workers: { self: "yes" } },
      { workers: { self: true, external: true } },
      { cors: { origins: ["*"] } },
      { cors: { origins: ["wss://frontend.example.com"] } },
      { cors: { credentials: "true" } },
    ]) {
      expect(() => normalizeBrowserPolicy(value)).toThrow("Invalid browser capability policy");
    }
  });

  it("refuses an explicit port 0 that the browser-policy triggers reject on insert", () => {
    for (const value of [
      { connect: ["https://a.example:0"] },
      { connect: ["wss://a.example:0"] },
      { cors: { origins: ["https://a.example:0"] } },
    ]) {
      expect(() => normalizeBrowserPolicy(value)).toThrow("Invalid browser capability policy");
    }
    expect(
      normalizeBrowserPolicy({
        connect: ["https://a.example:1"],
        cors: { origins: ["https://a.example:65535"] },
      }),
    ).toMatchObject({
      connect: ["https://a.example:1"],
      cors: { origins: ["https://a.example:65535"] },
    });
  });

  it("requires the complete canonical wire policy while ignoring JSON object key order", () => {
    const canonical = normalizeBrowserPolicy({
      connect: ["https://b.example.com", "https://a.example.com"],
    });
    expect(parseBrowserPolicy({ ...canonical, workers: { blob: false, self: false } })).toEqual(
      canonical,
    );
    for (const value of [
      undefined,
      {},
      { ...canonical, connect: [...canonical.connect].reverse() },
      { ...canonical, workers: { self: false } },
      { ...canonical, workers: { self: undefined, blob: false } },
      { ...canonical, cors: { origins: [] } },
      { ...canonical, extra: true },
    ]) {
      expect(() => parseBrowserPolicy(value)).toThrow("Invalid browser capability policy");
    }
  });
});
