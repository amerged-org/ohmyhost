import { describe, expect, it } from "vitest";

import { isUserSecretName } from "@ohmyhost/contracts/secret-names";

import { AI_BASE_URL_NAME, AI_KEY_NAME } from "./ai-gateway.js";

// The contracts package cannot import this module without a cycle, so it repeats the two names as
// literals. This test pins both sides to the same bytes.
describe("AI gateway platform names", () => {
  it("are the names the contracts package reserves", () => {
    expect(AI_KEY_NAME).toBe("OHMYHOST_AI_KEY");
    expect(AI_BASE_URL_NAME).toBe("OHMYHOST_AI_BASE_URL");
    expect(isUserSecretName(AI_KEY_NAME)).toBe(false);
    expect(isUserSecretName(AI_KEY_NAME, "delete")).toBe(false);
    expect(isUserSecretName(AI_BASE_URL_NAME)).toBe(false);
    expect(isUserSecretName(AI_BASE_URL_NAME, "delete")).toBe(true);
  });
});
