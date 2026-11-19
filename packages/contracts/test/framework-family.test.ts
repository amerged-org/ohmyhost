import { describe, expect, it } from "vitest";

import { classifyFrameworkFamily } from "../src/framework-family.js";

describe("framework family classification", () => {
  it.each([
    [[], "unknown"],
    [["next"], "nextjs"],
    [["vite"], "vite"],
    [["@tanstack/react-start"], "tanstack-start"],
    [["@tanstack/react-start", "vite"], "tanstack-start"],
    [["next", "vite"], "ambiguous"],
    [["next", "@tanstack/react-start"], "ambiguous"],
    [["next", "@tanstack/react-start", "vite"], "ambiguous"],
  ] as const)("classifies %j as %s", (dependencies, expected) => {
    expect(classifyFrameworkFamily(new Set(dependencies))).toBe(expected);
  });

  it("ignores unrelated dependency names without mutating the caller set", () => {
    const dependencies = new Set(["react", "vitest"]);
    expect(classifyFrameworkFamily(dependencies)).toBe("unknown");
    expect([...dependencies]).toEqual(["react", "vitest"]);
  });
});
