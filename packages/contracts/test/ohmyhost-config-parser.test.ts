import { describe, expect, it } from "vitest";

import {
  APPLICATION_ROOT_CONFORMANCE_CORPUS,
  normalizeApplicationRoot,
  parseOhmyhostConfig,
  parseOhmyhostConfigYaml,
  type OhmyhostConfig,
} from "../src/index.js";

const validConfig = {
  version: 1,
  project: "storefront",
  build: {
    install: "pnpm install --frozen-lockfile",
    command: "pnpm build",
    output: "dist",
  },
  runtime: {
    mode: "edge",
    healthcheck: "/api/health",
  },
} as const;

describe("parseOhmyhostConfig", () => {
  it("returns the canonical runtime and build shape as an immutable value", () => {
    const parsed: OhmyhostConfig = parseOhmyhostConfig(validConfig);

    expect(parsed).toEqual({
      ...validConfig,
      applicationRoot: ".",
      runtime: { ...validConfig.runtime, egress: { allow: [] } },
    });
    expect(parsed).not.toBe(validConfig);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.build)).toBe(true);
    expect(Object.isFrozen(parsed.runtime)).toBe(true);
    expect(Object.isFrozen(parsed.runtime.egress)).toBe(true);
    expect(Object.isFrozen(parsed.runtime.egress.allow)).toBe(true);
    for (const capacity of [1, 32, 64]) {
      expect(
        parseOhmyhostConfig({
          ...validConfig,
          build: { ...validConfig.build, ssg_cache_max_mib: capacity },
        }).build,
      ).toEqual({ ...validConfig.build, ssg_cache_max_mib: capacity });
    }
    for (const capacity of [0, 65, -1, 1.5, "32", null]) {
      expect(() =>
        parseOhmyhostConfig({
          ...validConfig,
          build: { ...validConfig.build, ssg_cache_max_mib: capacity },
        }),
      ).toThrow("ohmyhost.yaml is invalid");
    }
    expect(
      parseOhmyhostConfig({
        ...validConfig,
        build: { ...validConfig.build, next_revalidate_path: true },
      }).build,
    ).toEqual({ ...validConfig.build, next_revalidate_path: true });
    expect(
      parseOhmyhostConfig({
        ...validConfig,
        build: { ...validConfig.build, next_revalidate_path: false },
      }).build,
    ).toEqual(validConfig.build);
    expect(() =>
      parseOhmyhostConfig({
        ...validConfig,
        build: { ...validConfig.build, next_revalidate_path: "true" },
      }),
    ).toThrow("ohmyhost.yaml is invalid");
  });

  it("normalizes a closed source-bound runtime policy", () => {
    const parsed = parseOhmyhostConfig({
      ...validConfig,
      runtime: {
        mode: "edge",
        egress: { allow: ["https://api.resend.com", "https://example.com"] },
      },
    });

    expect(parsed.runtime).toEqual({
      mode: "edge",
      healthcheck: "/",
      egress: { allow: ["https://api.resend.com", "https://example.com"] },
    });
  });

  it.each([
    "http://example.com",
    "https://example.com/path",
    "https://user@example.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://10.0.0.1",
    "https://169.254.169.254",
    "https://service.internal",
    "https://connect.ohmyho.st",
    "https://dev.connect.ohmyho.st",
    "https://ohmyho-mail-gateway-decoy.test.workers.dev",
    "https://ohmyho-storage-gateway-production.your-omh-account.workers.dev",
    "https://ohmyho-storage-gateway-decoy.test.workers.dev.",
    "https://s1-01arz3ndektsv4rrffq69g5fav.01arz3ndektsv4rrffq69g5faw-01arz3ndektsv4rrffq69g5fax.ohmyho-storage-gateway-production.your-omh-account.workers.dev",
    "https://bad.prefix.ohmyho-storage-gateway-production.your-omh-account.workers.dev",
    "https://bad.prefix.ohmyho-mail-gateway-production.your-omh-account.workers.dev",
    // Every egress origin later becomes a route on the default HTTPS port with a DNS name.
    "https://api.example.com:8443",
    "https://203.0.113.10",
    "https://8.8.8.8",
    // The DNS rule every later stage applies: these fail here, not after a candidate is staged.
    "https://my_api.example.com",
    "https://example.com.",
    "https://intranet",
    `https://${"a".repeat(64)}.example.com`,
    "https://a.-b.example",
  ])("rejects unsafe runtime egress origin %s", (origin) => {
    expect(() =>
      parseOhmyhostConfig({
        ...validConfig,
        runtime: { mode: "edge", egress: { allow: [origin] } },
      }),
    ).toThrow();
  });

  it("admits at most 11 egress origins, because the platform adds five origins under the 16-origin cap", () => {
    // Mail, the storage gateway, R2, AI and browser origins can all be added, so 11 + 5 is the most a Worker may hold.
    const origins = Array.from(
      { length: 12 },
      (_, index) => `https://api${String(index).padStart(2, "0")}.example.com`,
    );
    const parse = (allow: readonly string[]) =>
      parseOhmyhostConfig({ ...validConfig, runtime: { mode: "edge", egress: { allow } } });

    expect(parse(origins.slice(0, 11)).runtime.egress.allow).toHaveLength(11);
    expect(() => parse(origins)).toThrow("ohmyhost.yaml is invalid");
  });

  it.each(["//evil.example", "/health?secret=x", "/a/../health", "/health#fragment"])(
    "rejects unsafe healthcheck path %s",
    (healthcheck) => {
      expect(() =>
        parseOhmyhostConfig({ ...validConfig, runtime: { mode: "edge", healthcheck } }),
      ).toThrow();
    },
  );

  it("normalizes an omitted or explicit application root and freezes it with the config", () => {
    expect(parseOhmyhostConfig(validConfig).applicationRoot).toBe(".");
    expect(parseOhmyhostConfig({ ...validConfig, applicationRoot: "." }).applicationRoot).toBe(".");
    expect(parseOhmyhostConfig({ ...validConfig, applicationRoot: "site" }).applicationRoot).toBe(
      "site",
    );
  });

  it("requires the project field", () => {
    const withoutProject: Record<string, unknown> = { ...validConfig };
    Reflect.deleteProperty(withoutProject, "project");

    expect(() => parseOhmyhostConfig(withoutProject)).toThrow(
      "ohmyhost.yaml is invalid: / must have required property 'project'",
    );
  });

  it("rejects unknown root and nested fields using the canonical schema", () => {
    expect(() => parseOhmyhostConfig({ ...validConfig, unknown: true })).toThrow(
      "ohmyhost.yaml is invalid: / must NOT have additional properties",
    );
    expect(() =>
      parseOhmyhostConfig({
        ...validConfig,
        runtime: { ...validConfig.runtime, unknown: true },
      }),
    ).toThrow("ohmyhost.yaml is invalid: /runtime must NOT have additional properties");
  });

  it("rejects the withdrawn mode `container` like any unknown runtime mode", () => {
    expect(() => parseOhmyhostConfig({ ...validConfig, runtime: { mode: "container" } })).toThrow(
      "ohmyhost.yaml is invalid: /runtime/mode must be equal to one of the allowed values",
    );
  });

  it("rejects invalid runtime and build values", () => {
    expect(() => parseOhmyhostConfig({ ...validConfig, runtime: { mode: "serverless" } })).toThrow(
      "ohmyhost.yaml is invalid: /runtime/mode must be equal to one of the allowed values",
    );
    expect(() =>
      parseOhmyhostConfig({ ...validConfig, build: { ...validConfig.build, output: "../dist" } }),
    ).toThrow("ohmyhost.yaml is invalid: /build/output must match pattern");
  });

  it("offers files in the US and EU jurisdictions only", () => {
    expect(
      parseOhmyhostConfig({
        ...validConfig,
        storage: { provider: "r2", jurisdiction: "eu", public: false },
      }).storage,
    ).toEqual({ provider: "r2", jurisdiction: "eu", public: false });
    expect(() =>
      parseOhmyhostConfig({
        ...validConfig,
        storage: { provider: "r2", jurisdiction: "apac", public: false },
      }),
    ).toThrow(
      "ohmyhost.yaml is invalid: /storage/jurisdiction must be equal to one of the allowed values",
    );
  });

  it("copies optional database, auth, mail, and storage without retaining mutable input references", () => {
    const input = {
      ...validConfig,
      database: { enabled: true, migrations: "db/migrations" },
      auth: { provider: "better-auth" as const },
      mail: { enabled: false },
      storage: { provider: "r2" as const, jurisdiction: "us" as const, public: false as const },
    };

    const parsed = parseOhmyhostConfig(input);
    input.database.migrations = "changed";

    expect(parsed.database).toEqual({ enabled: true, migrations: "db/migrations" });
    expect(parsed.auth).toEqual({ provider: "better-auth" });
    expect(parsed.mail).toEqual({ enabled: false });
    expect(parsed.storage).toEqual({ provider: "r2", jurisdiction: "us", public: false });
    expect(Object.isFrozen(parsed.database)).toBe(true);
    expect(Object.isFrozen(parsed.auth)).toBe(true);
    expect(Object.isFrozen(parsed.mail)).toBe(true);
    expect(Object.isFrozen(parsed.storage)).toBe(true);
  });

  it("copies the AI gateway declaration and names the missing jurisdiction", () => {
    const parsed = parseOhmyhostConfig({
      ...validConfig,
      ai: { enabled: true, jurisdiction: "eu" as const },
    });

    expect(parsed.ai).toEqual({ enabled: true, jurisdiction: "eu" });
    expect(Object.isFrozen(parsed.ai)).toBe(true);
    expect(parseOhmyhostConfig({ ...validConfig, ai: { enabled: false } }).ai).toEqual({
      enabled: false,
    });
    expect(() => parseOhmyhostConfig({ ...validConfig, ai: { enabled: true } })).toThrow(
      "ohmyhost.yaml is invalid: /ai must have required property 'jurisdiction'",
    );
    expect(() =>
      parseOhmyhostConfig({ ...validConfig, ai: { enabled: false, jurisdiction: "apac" } }),
    ).toThrow(
      "ohmyhost.yaml is invalid: /ai/jurisdiction must be equal to one of the allowed values",
    );
  });

  it("normalizes function crons into one immutable sorted UTC set", () => {
    const parsed = parseOhmyhostConfig({
      ...validConfig,
      functions: { crons: ["15 * * * *", "*/5 * * * *"] },
    });

    expect(parsed.functions).toEqual({ crons: ["*/5 * * * *", "15 * * * *"] });
    expect(Object.isFrozen(parsed.functions)).toBe(true);
    expect(Object.isFrozen(parsed.functions?.crons)).toBe(true);
  });

  it.each([
    [["* * * * *"]],
    [["*/4 * * * *"]],
    [["0 0 * * * *"]],
    [["0 24 * * *"]],
    [["0 * * *  *"]],
    [[]],
    [["0 * * * *", "0 * * * *"]],
    [Array.from({ length: 9 }, (_, index) => `${index} * * * *`)],
  ])("rejects noncanonical, too-frequent, empty or duplicate crons %#", (crons) => {
    expect(() => parseOhmyhostConfig({ ...validConfig, functions: { crons } })).toThrow();
  });

  it("accepts the functions runtime only with an install-only build", () => {
    const parsed = parseOhmyhostConfig({
      ...validConfig,
      build: { install: "pnpm install --frozen-lockfile --ignore-scripts" },
      runtime: { mode: "functions" },
      functions: { crons: ["0 3 * * *"] },
    });

    expect(parsed.runtime.mode).toBe("functions");
    expect(parsed.build).toEqual({ install: "pnpm install --frozen-lockfile --ignore-scripts" });
    expect(Object.isFrozen(parsed.build)).toBe(true);
    expect(() => parseOhmyhostConfig({ ...validConfig, runtime: { mode: "functions" } })).toThrow(
      "ohmyhost.yaml is invalid",
    );
    expect(() =>
      parseOhmyhostConfig({
        ...validConfig,
        build: { install: "pnpm install --frozen-lockfile --ignore-scripts" },
      }),
    ).toThrow("ohmyhost.yaml is invalid");
  });

  it("accepts only the closed customer-auth provider set", () => {
    expect(parseOhmyhostConfig({ ...validConfig, auth: { provider: "none" } }).auth).toEqual({
      provider: "none",
    });
    expect(parseOhmyhostConfig({ ...validConfig, auth: { provider: "omh-native" } }).auth).toEqual({
      provider: "omh-native",
    });
    expect(() => parseOhmyhostConfig({ ...validConfig, auth: { provider: "supabase" } })).toThrow(
      "ohmyhost.yaml is invalid: /auth/provider must be equal to one of the allowed values",
    );
    expect(() =>
      parseOhmyhostConfig({ ...validConfig, auth: { provider: "better-auth", secret: "value" } }),
    ).toThrow("ohmyhost.yaml is invalid: /auth must NOT have additional properties");
  });
});

describe("parseOhmyhostConfigYaml", () => {
  it("parses valid YAML through the canonical parser and returns the same frozen config", () => {
    const parsed = parseOhmyhostConfigYaml(`
version: 1
project: storefront
build:
  install: pnpm install --frozen-lockfile
  command: pnpm build
  output: dist
runtime:
  mode: edge
  healthcheck: /api/health
`);

    expect(parsed).toEqual({
      ...validConfig,
      applicationRoot: ".",
      runtime: { ...validConfig.runtime, egress: { allow: [] } },
    });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("refuses a credits block, which no surface reads", () => {
    expect(() =>
      parseOhmyhostConfigYaml(`
version: 1
project: storefront
build:
  install: pnpm install --frozen-lockfile
  command: pnpm build
  output: dist
runtime:
  mode: edge
  healthcheck: /api/health
credits:
  monthly_budget: 3000
`),
    ).toThrow("ohmyhost.yaml is invalid: / must NOT have additional properties");
  });

  it("rejects non-string and malformed YAML with a stable content-free error", () => {
    expect(() => parseOhmyhostConfigYaml(null as unknown as string)).toThrow(
      "ohmyhost.yaml must be a string",
    );
    expect(() => parseOhmyhostConfigYaml("secret: [unterminated")).toThrow(
      "ohmyhost.yaml is not valid YAML",
    );
  });

  it("reports schema-invalid YAML through the canonical validation errors", () => {
    expect(() =>
      parseOhmyhostConfigYaml(`
version: 1
build:
  install: pnpm install
  command: pnpm build
  output: dist
runtime:
  mode: static
`),
    ).toThrow("ohmyhost.yaml is invalid: / must have required property 'project'");
  });
});

describe("normalizeApplicationRoot", () => {
  it.each(APPLICATION_ROOT_CONFORMANCE_CORPUS.accepted)("accepts $name", ({ value }) => {
    expect(normalizeApplicationRoot(value)).toBe(value);
  });

  it.each(APPLICATION_ROOT_CONFORMANCE_CORPUS.rejected)("rejects $name", ({ value }) => {
    expect(() => normalizeApplicationRoot(value)).toThrow("Application root is invalid");
  });

  it("defaults only omission to the repository root", () => {
    expect(normalizeApplicationRoot()).toBe(".");
    expect(() => normalizeApplicationRoot(null)).toThrow("Application root is invalid");
  });

  it("exports the bounded GitHub USTAR envelope evidence", () => {
    expect(APPLICATION_ROOT_CONFORMANCE_CORPUS.ustarEnvelope).toEqual([
      {
        name: "maximum accepted application root",
        repositoryNameBytes: 100,
        separatorBytes: 3,
        commitShaBytes: 40,
        applicationRootBytes: 64,
        inspectionLeafBytes: 24,
        archivePathBytes: 231,
        ustarPathEnvelopeBytes: 255,
        fitsWithoutPax: true,
      },
    ]);
    expect(Object.isFrozen(APPLICATION_ROOT_CONFORMANCE_CORPUS)).toBe(true);
    expect(Object.isFrozen(APPLICATION_ROOT_CONFORMANCE_CORPUS.accepted)).toBe(true);
    expect(Object.isFrozen(APPLICATION_ROOT_CONFORMANCE_CORPUS.rejected)).toBe(true);
    expect(Object.isFrozen(APPLICATION_ROOT_CONFORMANCE_CORPUS.ustarEnvelope)).toBe(true);
    expect(Object.isFrozen(APPLICATION_ROOT_CONFORMANCE_CORPUS.ustarEnvelope[0])).toBe(true);
  });
});
