import { describe, expect, it } from "vitest";
import { isPreviewMutationAllowed, previewTokenFromRequest } from "../src/protocol.js";
import { PreviewConnections } from "../src/connections.js";
import { applySourceDelta, type PreviewSourceDelta } from "../src/source-sync.js";

describe("preview boundaries", () => {
  it("accepts only canonical capability hosts", () => {
    const label = `${"a".repeat(51)}q`;
    expect(
      previewTokenFromRequest(
        new Request(`https://${label}.preview.dev.omh.st/`),
        "preview.dev.omh.st",
      ),
    ).toBe(label);
    for (const host of [
      `${"a".repeat(51)}b`,
      `x.${label}`,
      label.toUpperCase(),
      `${label}.other`,
    ]) {
      const url = `https://${host}.preview.dev.omh.st/`;
      // URL hostname normalization necessarily makes an uppercase DNS host lowercase.
      if (host === label.toUpperCase()) continue;
      expect(previewTokenFromRequest(new Request(url), "preview.dev.omh.st")).toBeNull();
    }
    expect(
      previewTokenFromRequest(
        new Request(`https://${label}.preview.dev.omh.st:444/`),
        "preview.dev.omh.st",
      ),
    ).toBeNull();
  });

  it("checks immutable source bytes and refuses unsafe writes before recording application", async () => {
    const bytes = new TextEncoder().encode("new content");
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (x) =>
      x.toString(16).padStart(2, "0"),
    ).join("");
    const delta: PreviewSourceDelta = {
      from: null,
      to: {
        sourceConnectionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        sourceGeneration: 1,
        sequence: 1,
        commitSha: "a".repeat(40),
      },
      operations: [{ kind: "write", path: "src/index.ts", bytes, sha256: hash, executable: false }],
      dependenciesChanged: false,
    };
    const applied: string[] = [];
    const writer = {
      apply: async () => {
        applied.push("write");
      },
    };
    await expect(applySourceDelta(delta, null, writer, false)).rejects.toThrow(
      "preview_source_boundary_unavailable",
    );
    expect(applied).toEqual([]);
    await expect(
      applySourceDelta(
        {
          ...delta,
          operations: [
            { kind: "write", path: "../outside", bytes, sha256: hash, executable: false },
          ],
        },
        null,
        writer,
        true,
      ),
    ).rejects.toThrow("preview_source_invalid");
    await expect(
      applySourceDelta(
        {
          ...delta,
          operations: [
            {
              kind: "write",
              path: "src/index.ts",
              sha256: hash,
              bytes: new Uint8Array([1]),
              executable: false,
            },
          ],
        },
        null,
        writer,
        true,
      ),
    ).rejects.toThrow("preview_source_invalid");
    expect(applied).toEqual([]);
    await expect(
      applySourceDelta(
        delta,
        null,
        {
          apply: async () => {
            throw new Error("delivery failed");
          },
        },
        true,
      ),
    ).rejects.toThrow("delivery failed");
    await applySourceDelta(delta, null, writer, true);
    expect(applied).toEqual(["write"]);
  });

  it("closes old-generation streams without treating stream chunks as activity", async () => {
    let cancelled = false;
    const connections = new PreviewConnections();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = connections.wrap(new Response(upstream), 4);
    if (!response.body) throw new Error("missing response stream");
    const reader = response.body.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    connections.closeGeneration(3);
    expect(cancelled).toBe(false);
    connections.closeGeneration(4);
    expect((await reader.read()).done).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("uses the current source policy for declared cross-origin mutations", () => {
    const source = {
      sourceConnectionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      sourceGeneration: 1,
      sequence: 1,
      commitSha: "a".repeat(40),
    };
    const policy = {
      connect: [],
      scripts: [],
      styles: [],
      images: [],
      fonts: [],
      frames: [],
      frameAncestors: [],
      workers: { self: false, blob: false },
      cors: { origins: ["https://allowed.example"], credentials: false },
    };
    const request = (origin: string) =>
      new Request("https://preview.example/action", { method: "POST", headers: { origin } });
    expect(
      isPreviewMutationAllowed(request("https://allowed.example"), policy, source, source, source),
    ).toBe(true);
    expect(
      isPreviewMutationAllowed(request("https://foreign.example"), policy, source, source, source),
    ).toBe(false);
    expect(
      isPreviewMutationAllowed(
        request("https://allowed.example"),
        policy,
        source,
        { ...source, sequence: 2 },
        source,
      ),
    ).toBe(false);
  });
});
