import { describe, expect, it } from "vitest";

import { isInstalledPlatformKeyName, isUserSecretName } from "../src/secret-names.js";

describe("isUserSecretName", () => {
  it("lets customers set and delete their own names", () => {
    expect(isUserSecretName("STRIPE_KEY")).toBe(true);
    expect(isUserSecretName("STRIPE_KEY", "delete")).toBe(true);
  });

  it("refuses values that are not names", () => {
    expect(isUserSecretName(42)).toBe(false);
    expect(isUserSecretName("lowercase_key")).toBe(false);
  });

  it("keeps every OHMYHOST_ name, including the AI gateway names, out of customer set", () => {
    for (const name of [
      "OHMYHOST_AI_KEY",
      "OHMYHOST_BROWSER_KEY",
      "OHMYHOST_AI_BASE_URL",
      "OHMYHOST_BROWSER_BASE_URL",
      "OHMYHOST_NEXT_CACHE",
      "OHMYHOST_MAIL_KEY",
      "OHMYHOST_STORAGE_KEY",
    ]) {
      expect(isUserSecretName(name), name).toBe(false);
    }
  });

  it("keeps the platform-installed AI and mail names out of customer delete", () => {
    for (const name of [
      "OHMYHOST_AI_KEY",
      "OHMYHOST_BROWSER_KEY",
      "OHMYHOST_MAIL_KEY",
      "OHMYHOST_STORAGE_KEY",
      "BETTER_AUTH_SECRET",
    ]) {
      expect(isUserSecretName(name, "delete"), name).toBe(false);
    }
  });

  it("lets a legacy customer row named like the plain-text AI base URL be deleted", () => {
    expect(isUserSecretName("OHMYHOST_AI_BASE_URL", "delete")).toBe(true);
    expect(isUserSecretName("OHMYHOST_AI_BASE_URL")).toBe(false);
  });
});

describe("isInstalledPlatformKeyName", () => {
  it("names exactly the five installed keys an owner may rotate", () => {
    for (const name of [
      "OHMYHOST_AI_KEY",
      "OHMYHOST_BROWSER_KEY",
      "OHMYHOST_MAIL_KEY",
      "OHMYHOST_STORAGE_KEY",
      "BETTER_AUTH_SECRET",
    ]) {
      expect(isInstalledPlatformKeyName(name), name).toBe(true);
    }
    for (const name of ["OHMYHOST_AI_BASE_URL", "DATABASE_URL", "STRIPE_KEY", 42]) {
      expect(isInstalledPlatformKeyName(name), String(name)).toBe(false);
    }
  });
});
