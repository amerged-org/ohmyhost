import { describe, expect, it } from "vitest";

import {
  DEFAULT_HOSTING_REGION,
  HOSTING_REGIONS,
  hostingRegionPlacement,
  parseHostingRegion,
} from "./region.js";

describe("hosting region", () => {
  it("offers the US default and the EU alternative", () => {
    expect(HOSTING_REGIONS).toEqual(["us", "eu"]);
    expect(DEFAULT_HOSTING_REGION).toBe("us");
    expect(Object.isFrozen(HOSTING_REGIONS)).toBe(true);
  });

  it("places a US project in the US on every provider", () => {
    expect(hostingRegionPlacement("us")).toEqual({
      region: "us",
      r2Jurisdiction: "us",
      r2LocationHint: "enam",
      buildObjectsBucket: {
        development: "ohmyho-builds-development",
        production: "ohmyho-builds-production",
      },
      buildSandboxClass: "BuildSandbox",
      buildSandboxLocationHint: "enam",
    });
  });

  it("places an EU project in the EU on every provider", () => {
    expect(hostingRegionPlacement("eu")).toEqual({
      region: "eu",
      r2Jurisdiction: "eu",
      r2LocationHint: "weur",
      buildObjectsBucket: {
        development: "ohmyho-builds-development-eu",
        production: "ohmyho-builds-production-eu",
      },
      buildSandboxClass: "BuildSandboxEu",
      buildSandboxLocationHint: "weur",
    });
  });

  it("returns a frozen placement row", () => {
    const placement = hostingRegionPlacement("eu");
    expect(Object.isFrozen(placement)).toBe(true);
    expect(Object.isFrozen(placement.buildObjectsBucket)).toBe(true);
  });

  it.each(["us", "eu"] as const)("parses %s", (region) => {
    expect(parseHostingRegion(region)).toBe(region);
  });

  it.each(["apac", "US", "eu ", "", null, undefined, 1, {}])("rejects %j", (value) => {
    expect(() => parseHostingRegion(value)).toThrow(TypeError);
    expect(() => parseHostingRegion(value)).toThrow("Hosting region must be us or eu");
  });
});
