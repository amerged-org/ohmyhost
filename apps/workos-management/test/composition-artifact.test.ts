import { describe, expect, it } from "vitest";

import { composeWorkosManagementCandidate, createCandidateArtifactProof } from "../src/index.js";
import {
  FixedIds,
  FixtureAuthenticator,
  FixtureDatabase,
  FixtureResolver,
  FixtureTransport,
  FixedOrganizationIds,
  SequenceClock,
} from "./fixtures.js";

const dependencies = () => ({
  authenticator: new FixtureAuthenticator(),
  clock: new SequenceClock([new Date("2026-08-18T12:00:00.000Z")]),
  ids: new FixedIds(),
  organizationIds: new FixedOrganizationIds(),
  database: new FixtureDatabase(),
  resolver: new FixtureResolver(),
  transport: new FixtureTransport(),
});

describe("private WorkOS composition and artifact proof", () => {
  it("excludes experimental FGA from development, staging and production", () => {
    for (const deployment of ["development", "staging", "production"] as const) {
      expect(() =>
        composeWorkosManagementCandidate({
          ...dependencies(),
          deployment,
          candidateFgaEnabled: true,
        }),
      ).toThrow("Experimental WorkOS FGA");
    }
  });

  it("composes real management in each declared environment without enabling experimental FGA", () => {
    for (const deployment of [
      "local",
      "test",
      "sandbox",
      "development",
      "staging",
      "production",
    ] as const) {
      const graph = composeWorkosManagementCandidate({
        ...dependencies(),
        deployment,
        candidateFgaEnabled: deployment === "sandbox",
      });
      expect(graph).toMatchObject({
        deployment,
        candidateFgaEnabled: deployment === "sandbox",
      });
      expect(graph.rpc).toBeDefined();
      expect(graph.poller).toBeDefined();
    }
  });

  it("produces a deterministic path-framed digest independent of input order", () => {
    const files = [
      { path: "dist/index.js", content: new TextEncoder().encode("index") },
      { path: "dist/sandbox-main.js", content: new TextEncoder().encode("sandbox") },
      { path: "dist/worker-bundle/worker-main.js", content: new TextEncoder().encode("worker") },
      { path: "dist/worker-bundle/metafile.json", content: new TextEncoder().encode("meta") },
      { path: "dist/runtime/runtime-contract.json", content: new TextEncoder().encode("runtime") },
      { path: "dist/runtime/wrangler.jsonc", content: new TextEncoder().encode("wrangler") },
    ];
    const first = createCandidateArtifactProof(files);
    const second = createCandidateArtifactProof([...files].reverse());
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 2,
      artifact: "workos-management",
      deploymentPolicy: "service-binding-only",
      entrypoint: "dist/sandbox-main.js",
      runtimeEntrypoint: "dist/worker-bundle/worker-main.js",
      runtimeContract: "dist/runtime/runtime-contract.json",
      files: [
        { path: "dist/index.js", bytes: 5 },
        { path: "dist/runtime/runtime-contract.json", bytes: 7 },
        { path: "dist/runtime/wrangler.jsonc", bytes: 8 },
        { path: "dist/sandbox-main.js", bytes: 7 },
        { path: "dist/worker-bundle/metafile.json", bytes: 4 },
        { path: "dist/worker-bundle/worker-main.js", bytes: 6 },
      ],
    });
    expect(first.artifactSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects empty, unsafe, and duplicate artifact inventories", () => {
    expect(() => createCandidateArtifactProof([])).toThrow("empty");
    expect(() =>
      createCandidateArtifactProof([{ path: "source.ts", content: new Uint8Array() }]),
    ).toThrow("invalid or duplicated");
    expect(() =>
      createCandidateArtifactProof([
        { path: "dist/a.js", content: new Uint8Array() },
        { path: "dist/a.js", content: new Uint8Array() },
      ]),
    ).toThrow("invalid or duplicated");
  });
});
