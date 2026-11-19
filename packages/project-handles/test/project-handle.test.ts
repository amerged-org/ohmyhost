import { describe, expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";

import {
  PROJECT_HANDLE_MAX_COLLISION_ATTEMPT,
  PROJECT_HANDLE_PROHIBITED_WORDS,
  PROJECT_HANDLE_PROHIBITED_WORD_POLICY_VERSION,
  PROJECT_HANDLE_VERSION,
  createProjectHandleGenerator,
  isGeneratedProjectHandle,
  parseProjectHandle,
  parseProjectHandleGenerationInput,
  parseProjectHandleReceipt,
  projectEnvironmentAddress,
  projectHandleProblem,
  suggestProjectHandles,
} from "../src/index.js";

const PROJECT_ID = parseUlid("01M0G4WP010GZ77JSDCJEPYJDM");

describe("project environment addresses", () => {
  it("separates public platform origins and account-wide gateway names", () => {
    for (const platform of ["development", "production"] as const) {
      for (const environmentName of ["dev", "prod"] as const) {
        const input = {
          projectId: PROJECT_ID,
          handle: "calm-otter-builds",
          environmentName,
          platform,
        };
        const label = environmentName === "dev" ? "dev-calm-otter-builds" : "calm-otter-builds";
        const hostname = `${label}.${platform === "development" ? "dev.check.omh.st" : "check.omh.st"}`;
        expect(projectEnvironmentAddress(input)).toEqual({
          hostname,
          origin: `https://${hostname}`,
          gatewayScriptName:
            platform === "development"
              ? label
              : `g-p-${PROJECT_ID.toLowerCase()}-${environmentName}`,
        });
        const other = projectEnvironmentAddress({
          ...input,
          projectId: "01M0G4WP010GZ77JSDCJEPYJDN",
        });
        if (platform === "production")
          expect(other.gatewayScriptName).not.toBe(
            projectEnvironmentAddress(input).gatewayScriptName,
          );
      }
    }
    const input = {
      projectId: PROJECT_ID,
      handle: "calm-otter-builds",
      environmentName: "dev" as const,
      platform: "development" as const,
    };
    for (const changed of [
      { platform: "stage" },
      { projectId: "foreign" },
      { environmentName: "other" },
      { handle: "calm-otter-builds.example.com" },
    ]) {
      expect(() => projectEnvironmentAddress({ ...input, ...changed } as never)).toThrow();
    }
  });
});

describe("project handle generation", () => {
  it("returns an immutable deterministic receipt for exactly three DNS-safe words", async () => {
    const generator = createProjectHandleGenerator(globalThis.crypto);
    const first = await generator.generate({ projectId: PROJECT_ID, collisionAttempt: 0 });
    const replay = await generator.generate({ projectId: PROJECT_ID, collisionAttempt: 0 });

    expect(first).toEqual(replay);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toMatchObject({
      projectId: PROJECT_ID,
      version: PROJECT_HANDLE_VERSION,
      prohibitedWordPolicyVersion: PROJECT_HANDLE_PROHIBITED_WORD_POLICY_VERSION,
      collisionAttempt: 0,
    });
    expect(first.handle.split("-")).toHaveLength(3);
    expect(first.handle).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/u);
    expect(first.handle.length).toBeLessThanOrEqual(63);
    expect(parseProjectHandle(first.handle)).toBe(first.handle);
  });

  it("rotates the deterministic candidate when persistence reports a collision", async () => {
    const generator = createProjectHandleGenerator(globalThis.crypto);
    const first = await generator.generate({ projectId: PROJECT_ID, collisionAttempt: 0 });
    const rotated = await generator.generate({ projectId: PROJECT_ID, collisionAttempt: 1 });

    expect(rotated.handle).not.toBe(first.handle);
    expect(rotated.collisionAttempt).toBe(1);
  });

  it("accepts collision attempts zero through thirty-one and rejects thirty-two", () => {
    expect(
      parseProjectHandleGenerationInput({ projectId: PROJECT_ID, collisionAttempt: 0 }),
    ).toMatchObject({ collisionAttempt: 0 });
    expect(
      parseProjectHandleGenerationInput({
        projectId: PROJECT_ID,
        collisionAttempt: PROJECT_HANDLE_MAX_COLLISION_ATTEMPT,
      }),
    ).toMatchObject({ collisionAttempt: 31 });
    expect(() =>
      parseProjectHandleGenerationInput({ projectId: PROJECT_ID, collisionAttempt: 32 }),
    ).toThrow("generation input is invalid");
  });

  it("never emits a word prohibited by the versioned policy", async () => {
    const generator = createProjectHandleGenerator(globalThis.crypto);
    const generated = await Promise.all(
      Array.from({ length: 32 }, (_, collisionAttempt) =>
        generator.generate({ projectId: PROJECT_ID, collisionAttempt }),
      ),
    );
    const prohibited = new Set<string>(PROJECT_HANDLE_PROHIBITED_WORDS);

    for (const receipt of generated) {
      expect(receipt.handle.split("-").some((word) => prohibited.has(word))).toBe(false);
    }
  });

  it.each(PROJECT_HANDLE_PROHIBITED_WORDS)(
    "rejects handles containing prohibited word %s",
    (word) => {
      expect(() => parseProjectHandle(`calm-${word}-waves`)).toThrow("Project handle is invalid");
    },
  );

  it.each([
    [null],
    [{}],
    [{ projectId: PROJECT_ID, collisionAttempt: -1 }],
    [{ projectId: PROJECT_ID, collisionAttempt: 1.5 }],
    [{ projectId: PROJECT_ID, collisionAttempt: Number.NaN }],
    [{ projectId: PROJECT_ID, collisionAttempt: 0, extra: true }],
    [{ projectId: "invalid", collisionAttempt: 0 }],
  ])("rejects invalid generation input %#", async (input) => {
    const generator = createProjectHandleGenerator(globalThis.crypto);
    await expect(generator.generate(input)).rejects.toThrow("generation input is invalid");
  });

  it.each([
    [null],
    ["Calm-otter-waves"],
    ["calm_otter_waves"],
    ["ab"],
    ["one-two-three-four-five-six"],
    [`${"a".repeat(20)}-${"b".repeat(20)}-${"c".repeat(18)}`],
    [`${"a".repeat(60)}-otter-waves`],
  ])("rejects malformed handle %#", (handle) => {
    expect(() => parseProjectHandle(handle)).toThrow("Project handle is invalid");
  });

  it("accepts a handle a customer chose, and still knows which handles it generated itself", () => {
    // A customer may choose one to five words; the platform only ever generates three.
    for (const handle of ["acme-shop", "acme", "acme-shop-2", "one-two-three-four-five"]) {
      expect(parseProjectHandle(handle)).toBe(handle);
      expect(isGeneratedProjectHandle(handle)).toBe(false);
    }
    expect(isGeneratedProjectHandle("calm-otter-waves")).toBe(true);
    expect(isGeneratedProjectHandle("my-api-gateway")).toBe(false);
    expect(isGeneratedProjectHandle(null)).toBe(false);
    expect(() => parseProjectHandle("my-api-gateway")).toThrow("Project handle is invalid");
  });

  it("rejects widened, mismatched, legacy-policy, and prohibited receipts", () => {
    const expected = { projectId: PROJECT_ID, collisionAttempt: 0 };
    const valid = {
      handle: "calm-otter-waves",
      projectId: PROJECT_ID,
      version: PROJECT_HANDLE_VERSION,
      prohibitedWordPolicyVersion: PROJECT_HANDLE_PROHIBITED_WORD_POLICY_VERSION,
      collisionAttempt: 0,
    };
    expect(parseProjectHandleReceipt(valid, expected)).toEqual(valid);
    expect(Object.isFrozen(parseProjectHandleReceipt(valid, expected))).toBe(true);

    for (const receipt of [
      { ...valid, extra: true },
      { ...valid, collisionAttempt: 1 },
      { ...valid, projectId: "01M0G4WP010GZ77JSDCJEPYJDN" },
      { ...valid, version: "legacy" },
      { ...valid, prohibitedWordPolicyVersion: "legacy" },
      { ...valid, handle: "calm-admin-waves" },
    ]) {
      expect(() => parseProjectHandleReceipt(receipt, expected)).toThrow(
        "Project handle receipt is invalid",
      );
    }
  });

  it("rejects an invalid crypto provider", () => {
    expect(() => createProjectHandleGenerator({} as Pick<Crypto, "subtle">)).toThrow(
      "crypto provider is invalid",
    );
  });
});

describe("customer-chosen project handles", () => {
  it("accepts a slug a customer would pick and names why it refuses the rest", () => {
    for (const handle of ["acme-shop", "lovable-hoster-alternative", "shop2", "a-b-c-d-e"])
      expect(projectHandleProblem(handle), handle).toBeNull();
    for (const [handle, problem] of [
      ["ab", "too_short"],
      ["a".repeat(60), "too_long"],
      ["Acme-Shop", "invalid_shape"],
      ["acme--shop", "invalid_shape"],
      ["-acme", "invalid_shape"],
      ["acme-", "invalid_shape"],
      ["acme_shop", "invalid_shape"],
      ["one-two-three-four-five-six", "invalid_shape"],
      ["dev-tools-here", "prohibited_word"],
      ["my-api-gateway", "prohibited_word"],
    ] as const)
      expect(projectHandleProblem(handle), handle).toBe(problem);
    // Every generated handle stays valid under the wider customer rule.
    expect(projectHandleProblem("humble-kiwis-find")).toBeNull();
  });

  it("suggests free alternatives that are themselves valid and never the taken name", () => {
    const taken = new Set(["acme-shop", "acme-shop-2", "acme-shop-3"]);
    const suggestions = suggestProjectHandles("acme-shop", (handle) => !taken.has(handle), 3);
    expect(suggestions).toHaveLength(3);
    expect(suggestions).not.toContain("acme-shop");
    for (const suggestion of suggestions) {
      expect(projectHandleProblem(suggestion), suggestion).toBeNull();
      expect(taken.has(suggestion)).toBe(false);
    }
    expect(new Set(suggestions).size).toBe(3);
    // A name that is already free suggests nothing, and an unusable name still suggests something.
    expect(suggestProjectHandles("acme-shop", () => true, 3)).toEqual([]);
    expect(suggestProjectHandles("Acme Shop!", () => true, 2)).toHaveLength(2);
    // A reserved word is dropped rather than carried into every alternative.
    const withoutReserved = suggestProjectHandles("my-api-gateway", () => true, 2);
    expect(withoutReserved.length).toBe(2);
    for (const suggestion of withoutReserved) {
      expect(projectHandleProblem(suggestion), suggestion).toBeNull();
      expect(suggestion).not.toContain("api");
    }
    expect(suggestProjectHandles("api-dev-www", () => true, 1)).toEqual(["project"]);
    // The caller that batches its own availability check marks only the candidate as unusable;
    // a valid but taken name must still produce alternatives.
    const batched = suggestProjectHandles(
      "humble-kiwis-find",
      (handle) => handle !== "humble-kiwis-find",
      4,
    );
    expect(batched).toHaveLength(4);
    expect(batched).not.toContain("humble-kiwis-find");
    // Suggestions stay inside the length limit even when the base is at the maximum.
    for (const suggestion of suggestProjectHandles("a".repeat(59), () => false, 2))
      expect(projectHandleProblem(suggestion), suggestion).toBeNull();
  });
});
