/**
 * The hosting region of a project (owner decision 2026-09-17): chosen once at project creation,
 * immutable afterwards, US by default. It places the project's database, its files, its
 * build sandbox and its build objects; runtime placement follows the database host.
 */
export const HOSTING_REGIONS = Object.freeze(["us", "eu"] as const);

export type HostingRegion = (typeof HOSTING_REGIONS)[number];

export const DEFAULT_HOSTING_REGION: HostingRegion = "us";

export interface HostingRegionPlacement {
  readonly region: HostingRegion;
  readonly r2Jurisdiction: HostingRegion;
  readonly r2LocationHint: "enam" | "weur";
  readonly buildObjectsBucket: Readonly<Record<"development" | "production", string>>;
  readonly buildSandboxClass: "BuildSandbox" | "BuildSandboxEu";
  readonly buildSandboxLocationHint: "enam" | "weur";
}

const PLACEMENTS: Readonly<Record<HostingRegion, HostingRegionPlacement>> = Object.freeze({
  us: Object.freeze({
    region: "us",
    r2Jurisdiction: "us",
    r2LocationHint: "enam",
    buildObjectsBucket: Object.freeze({
      development: "ohmyho-builds-development",
      production: "ohmyho-builds-production",
    }),
    buildSandboxClass: "BuildSandbox",
    buildSandboxLocationHint: "enam",
  }),
  eu: Object.freeze({
    region: "eu",
    r2Jurisdiction: "eu",
    r2LocationHint: "weur",
    buildObjectsBucket: Object.freeze({
      development: "ohmyho-builds-development-eu",
      production: "ohmyho-builds-production-eu",
    }),
    buildSandboxClass: "BuildSandboxEu",
    buildSandboxLocationHint: "weur",
  }),
});

export function hostingRegionPlacement(region: HostingRegion): HostingRegionPlacement {
  return PLACEMENTS[parseHostingRegion(region)];
}

export function parseHostingRegion(value: unknown): HostingRegion {
  if (value !== "us" && value !== "eu") throw new TypeError("Hosting region must be us or eu");
  return value;
}
