import { describe, expect, it } from "vitest";

import {
  AI_GATEWAY_ORIGIN_DEVELOPMENT,
  AI_GATEWAY_ORIGIN_PRODUCTION,
  AI_HOLD_NANO_USD,
  AI_JSON_BODY_LIMIT,
  AI_MAX_OPEN_CALLS,
  AI_MULTIPART_BODY_LIMIT,
  aiBaseUrl,
  createAiKey,
} from "./ai-gateway.js";

const ulid = "01J5Z3K8M2Q7R9T4V6W8X0Y1Z2";
const secret = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

describe("AI gateway key", () => {
  it("joins the prefix, the project ULID and the 43 base64url characters", () => {
    expect(secret).toHaveLength(43);
    expect(createAiKey(ulid, secret)).toBe(`omh_ai_${ulid}_${secret}`);
  });

  it("refuses a lowercase project id", () => {
    expect(() => createAiKey(ulid.toLowerCase(), secret)).toThrow("Invalid AI gateway key");
  });

  it("refuses a secret that is not 43 characters", () => {
    expect(() => createAiKey(ulid, secret.slice(0, 42))).toThrow("Invalid AI gateway key");
    expect(() => createAiKey(ulid, `${secret}A`)).toThrow("Invalid AI gateway key");
  });
});

describe("AI gateway origins", () => {
  it.each([AI_GATEWAY_ORIGIN_PRODUCTION, AI_GATEWAY_ORIGIN_DEVELOPMENT])(
    "is an https origin without a path: %s",
    (origin) => {
      expect(new URL(origin).protocol).toBe("https:");
      expect(origin).toBe(new URL(origin).origin);
    },
  );

  it("appends the /v1 base path to an origin", () => {
    expect(aiBaseUrl(AI_GATEWAY_ORIGIN_PRODUCTION)).toBe("https://ai.ohmyho.st/v1");
    expect(aiBaseUrl(AI_GATEWAY_ORIGIN_DEVELOPMENT)).toBe("https://ai.dev.ohmyho.st/v1");
  });
});

describe("AI gateway constants", () => {
  it("holds USD 0.50 of orq cost per call", () => {
    expect(AI_HOLD_NANO_USD).toBe(500_000_000n);
  });

  it("allows eight unresolved AI calls at once per organization", () => {
    expect(AI_MAX_OPEN_CALLS).toBe(8);
  });

  it("limits JSON bodies to 16 MiB and multipart bodies to 26 MiB, above OpenAI's 25 MiB upload", () => {
    expect(AI_JSON_BODY_LIMIT).toBe(16 * 1024 * 1024);
    expect(AI_MULTIPART_BODY_LIMIT).toBe(26 * 1024 * 1024);
    expect(AI_MULTIPART_BODY_LIMIT).toBeGreaterThan(25 * 1024 * 1024);
  });
});
