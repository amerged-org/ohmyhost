import { describe, expect, it } from "vitest";
import { isEuOnlyLocations } from "./ai-jurisdiction.js";

describe("authoritative orq model locations", () => {
  it("allows only a nonempty exclusively EU location list, independently of the model id or provider", () => {
    expect(isEuOnlyLocations(["eu"])).toBe(true);
    expect(isEuOnlyLocations(["eu", "eu"])).toBe(true);
    for (const locations of [
      [],
      ["us"],
      ["global"],
      ["eu", "us"],
      ["global", "eu", "us"],
      ["EU"],
      ["europe"],
    ])
      expect(isEuOnlyLocations(locations)).toBe(false);
  });
});
