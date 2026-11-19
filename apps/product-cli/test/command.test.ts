import { describe, expect, it } from "vitest";

import {
  InvalidCommandError,
  parseProductCliCommand,
  recognizedCommandLabel,
} from "../src/command.js";
import { cliMetadataResult, helpTopicKnown, invalidCommandAction } from "../src/cli.js";

describe("product CLI argument parser", () => {
  it("answers help for an unlisted subcommand with its longest listed group first", () => {
    const { commands } = JSON.parse(
      cliMetadataResult("help", "source publish complete now").stdout,
    );
    expect(commands[0].command).toBe("source publish complete");
  });

  it("answers --help for an auth subcommand with its group, and an unknown topic without the outdated-CLI hint", () => {
    expect(helpTopicKnown("auth users list")).toBe(true);
    expect(helpTopicKnown("auth config get")).toBe(true);
    expect(helpTopicKnown("nonsense")).toBe(false);
    expect(invalidCommandAction(["nonsense", "--help", "--json"], "ohmyhost")).not.toContain(
      "client-release.json",
    );
  });

  it("refuses a budget above the Control API's safe integer and accepts that maximum", () => {
    const argv = (credits: string) => [
      "budget",
      "set",
      "--project",
      "01K2F3G4H5J6K7M8N9P0QRSTVW",
      "--credits",
      credits,
      "--idempotency-key",
      "budget-1",
    ];
    expect(() => parseProductCliCommand(argv("9007199254.740992"))).toThrow(InvalidCommandError);
    expect(parseProductCliCommand(argv("9007199254.740991"))).toMatchObject({
      kind: "budget-set",
      amountMicros: "9007199254740991",
    });
  });

  it("refuses an idempotency key outside the documented charset as invalid_command", () => {
    for (const key of ["деплой-1", "deploy\n1"]) {
      expect(() =>
        parseProductCliCommand([
          "deploy",
          "--project",
          "01K2F3G4H5J6K7M8N9P0QRSTVW",
          "--plan-id",
          "01K2F3G4H5J6K7M8N9P0QRSTVX",
          "--idempotency-key",
          key,
          "--yes",
        ]),
      ).toThrow(InvalidCommandError);
    }
  });

  it("lists a project's deployments and reads one by id, and refuses a get without its deployment", () => {
    expect(
      parseProductCliCommand([
        "deployment",
        "list",
        "--project",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--cursor",
        "C1",
        "--limit",
        "20",
      ]),
    ).toMatchObject({
      kind: "deployment-list",
      projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      cursor: "C1",
      limit: 20,
    });
    expect(
      parseProductCliCommand([
        "deployment",
        "get",
        "--project",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--deployment",
        "01K2F3G4H5J6K7M8N9P0QRSTVX",
      ]),
    ).toMatchObject({
      kind: "deployment-get",
      projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      deploymentId: "01K2F3G4H5J6K7M8N9P0QRSTVX",
    });
    expect(() =>
      parseProductCliCommand(["deployment", "get", "--project", "01K2F3G4H5J6K7M8N9P0QRSTVW"]),
    ).toThrow(InvalidCommandError);
    // A --limit is a decimal integer from 1 to 100: no hexadecimal, exponent, sign or leading zero.
    for (const limit of ["0x10", "1e1", "+5", "010", "0", "101"]) {
      expect(() =>
        parseProductCliCommand([
          "deployment",
          "list",
          "--project",
          "01K2F3G4H5J6K7M8N9P0QRSTVW",
          "--limit",
          limit,
        ]),
      ).toThrow(InvalidCommandError);
    }
  });

  it("parses Native origin and application paths with strict redirect validation", () => {
    const args = [
      "auth",
      "config",
      "set",
      "--project",
      "p",
      "--environment",
      "e",
      "--revision",
      "1",
      "--enabled",
      "true",
      "--signup-policy",
      "open",
      "--application-name",
      "App",
      "--idempotency-key",
      "key",
      "--canonical-origin",
      "primary",
      "--allowed-redirect-paths",
      '["/","/reset","/invite"]',
      "--reset-password-path",
      "/reset",
      "--invitation-path",
      "/invite",
      "--json",
    ];
    expect(parseProductCliCommand(args)).toMatchObject({
      request: {
        canonicalOrigin: null,
        allowedRedirectPaths: ["/", "/reset", "/invite"],
        resetPasswordPath: "/reset",
        invitationPath: "/invite",
      },
    });
    expect(() =>
      parseProductCliCommand(args.map((value) => (value === "/reset" ? "/../x" : value))),
    ).toThrow();
    expect(() =>
      parseProductCliCommand(args.map((value) => (value === "/invite" ? "/other" : value))),
    ).toThrow();
  });
  it("accepts Native provider secrets only from stdin and rejects unrelated options", () => {
    const args = [
      "auth",
      "provider",
      "set",
      "--project",
      "p",
      "--environment",
      "e",
      "--provider",
      "google",
      "--revision",
      "3",
      "--enabled",
      "true",
      "--idempotency-key",
      "k",
    ];
    expect(parseProductCliCommand([...args, "--stdin", "--json"])).toMatchObject({
      kind: "native-auth",
      stdin: true,
      request: { action: "provider_set", configurationRevision: 3, provider: "google" },
    });
    expect(() =>
      parseProductCliCommand([...args, "--client-secret", "secret", "--json"]),
    ).toThrow();
    expect(() =>
      parseProductCliCommand([
        "auth",
        "config",
        "get",
        "--project",
        "p",
        "--environment",
        "e",
        "--provider",
        "google",
        "--json",
      ]),
    ).toThrow();
    expect(() =>
      parseProductCliCommand([
        "auth",
        "provider",
        "set",
        "--project",
        "p",
        "--environment",
        "e",
        "--provider",
        "google",
        "--enabled",
        "true",
        "--idempotency-key",
        "k",
        "--json",
      ]),
    ).toThrow();
  });
  it("requires explicit Dev or Prod for database queries and writes", () => {
    for (const environment of ["dev", "prod"]) {
      expect(
        parseProductCliCommand([
          "database",
          "query",
          "--project",
          "00000000000000000000000002",
          "--environment",
          environment,
          "--statement",
          "SELECT 1",
          "--json",
        ]),
      ).toMatchObject({ kind: "database-query", environment });
      expect(
        parseProductCliCommand([
          "database",
          "write",
          "--project",
          "00000000000000000000000002",
          "--environment",
          environment,
          "--statement-file",
          "write.sql",
          "--idempotency-key",
          "write-a",
          "--yes",
          "--json",
        ]),
      ).toMatchObject({ kind: "database-write", environment });
    }
    expect(() =>
      parseProductCliCommand([
        "database",
        "write",
        "--project",
        "00000000000000000000000002",
        "--statement-file",
        "write.sql",
        "--idempotency-key",
        "write-a",
        "--yes",
        "--json",
      ]),
    ).toThrow();
  });
  it("parses database access commands, lifetimes and labels and rejects the rest", () => {
    expect(
      parseProductCliCommand([
        "database",
        "access",
        "create",
        "--project",
        "00000000000000000000000002",
        "--environment",
        "prod",
        "--mode",
        "write",
        "--ttl",
        "2h",
        "--label",
        "migration check",
        "--yes",
        "--json",
      ]),
    ).toMatchObject({
      kind: "database-access-create",
      environment: "prod",
      mode: "write",
      ttlSeconds: 7_200,
      label: "migration check",
      yes: true,
    });
    expect(
      parseProductCliCommand([
        "database",
        "access",
        "create",
        "--project",
        "00000000000000000000000002",
        "--environment",
        "dev",
        "--yes",
        "--json",
      ]),
    ).toMatchObject({
      kind: "database-access-create",
      mode: "read",
      ttlSeconds: 3_600,
      label: null,
    });
    for (const [ttl, seconds] of [
      ["300", 300],
      ["5m", 300],
      ["24h", 86_400],
      ["86400", 86_400],
    ] as const) {
      expect(
        parseProductCliCommand([
          "database",
          "psql",
          "--project",
          "00000000000000000000000002",
          "--environment",
          "dev",
          "--ttl",
          ttl,
        ]),
      ).toMatchObject({
        kind: "database-psql",
        environment: "dev",
        mode: "read",
        ttlSeconds: seconds,
      });
    }
    expect(
      parseProductCliCommand([
        "database",
        "access",
        "list",
        "--project",
        "00000000000000000000000002",
        "--json",
      ]),
    ).toEqual({
      kind: "database-access-list",
      projectId: "00000000000000000000000002",
      credentialStore: "native",
    });
    expect(
      parseProductCliCommand([
        "database",
        "access",
        "revoke",
        "--project",
        "00000000000000000000000002",
        "--access",
        "01M2K0000000000000000000A1",
        "--yes",
        "--json",
      ]),
    ).toMatchObject({ kind: "database-access-revoke", accessId: "01M2K0000000000000000000A1" });
    for (const argv of [
      ["database", "access", "create", "--project", "p", "--environment", "dev", "--json"],
      ["database", "access", "create", "--project", "p", "--environment", "stage", "--yes"],
      [
        "database",
        "access",
        "create",
        "--project",
        "p",
        "--environment",
        "dev",
        "--ttl",
        "60",
        "--yes",
      ],
      [
        "database",
        "access",
        "create",
        "--project",
        "p",
        "--environment",
        "dev",
        "--ttl",
        "25h",
        "--yes",
      ],
      [
        "database",
        "access",
        "create",
        "--project",
        "p",
        "--environment",
        "dev",
        "--mode",
        "owner",
        "--yes",
      ],
      [
        "database",
        "access",
        "create",
        "--project",
        "p",
        "--environment",
        "dev",
        "--label",
        " pad ",
        "--yes",
      ],
      ["database", "access", "revoke", "--project", "p", "--access", "a"],
      ["database", "access", "purge", "--project", "p", "--yes"],
      ["database", "psql", "--project", "p"],
      ["database", "psql", "--project", "p", "--environment", "dev", "--yes"],
    ])
      expect(() => parseProductCliCommand(argv)).toThrow(InvalidCommandError);
    for (const label of [
      "database access create",
      "database access list",
      "database access revoke",
      "database psql",
    ])
      expect(recognizedCommandLabel(label.split(" "))).toBe(label);
  });
  it("answers help for a command group, given before or after --help", () => {
    expect(parseProductCliCommand(["help", "database", "--json"])).toEqual({
      kind: "help",
      topic: "database",
    });
    expect(parseProductCliCommand(["database", "--help", "--json"])).toEqual({
      kind: "help",
      topic: "database",
    });
    expect(parseProductCliCommand(["database", "access", "create", "--help"])).toEqual({
      kind: "help",
      topic: "database access create",
    });
    expect(() => parseProductCliCommand(["version", "--help"])).toThrow(InvalidCommandError);
    expect(() => parseProductCliCommand(["database;rm", "--help"])).toThrow(InvalidCommandError);
  });
  it("parses database webhook commands; reads default to Dev and changes need --yes", () => {
    const project = "00000000000000000000000002";
    const webhook = "whk_abcdefghijklmnopqrst";
    const delivery = "dlv_0123456789abcdef0123";
    expect(
      parseProductCliCommand([
        "database",
        "webhook",
        "create",
        "--project",
        project,
        "--environment",
        "prod",
        "--url",
        "https://hooks.example.com/pg",
        "--event-types",
        "database.ready,database.slept",
        "--headers-file",
        "headers.json",
        "--idempotency-key",
        "hook-a",
        "--yes",
        "--json",
      ]),
    ).toEqual({
      kind: "database-webhook-create",
      projectId: project,
      environment: "prod",
      url: "https://hooks.example.com/pg",
      eventTypes: ["database.ready", "database.slept"],
      headersFile: "headers.json",
      idempotencyKey: "hook-a",
      yes: true,
      credentialStore: "native",
    });
    expect(
      parseProductCliCommand([
        "database",
        "webhook",
        "create",
        "--project",
        project,
        "--environment",
        "dev",
        "--url",
        "https://hooks.example.com/pg",
        "--event-types",
        "database.woke",
        "--idempotency-key",
        "hook-b",
        "--yes",
        "--json",
      ]),
    ).toMatchObject({ kind: "database-webhook-create", headersFile: null });
    expect(
      parseProductCliCommand(["database", "webhook", "list", "--project", project, "--json"]),
    ).toEqual({
      kind: "database-webhook-list",
      projectId: project,
      environment: "dev",
      credentialStore: "native",
    });
    expect(
      parseProductCliCommand([
        "database",
        "webhook",
        "get",
        "--project",
        project,
        "--webhook",
        webhook,
        "--json",
      ]),
    ).toMatchObject({ kind: "database-webhook-get", environment: "dev", webhookId: webhook });
    for (const kind of ["delete", "test"] as const) {
      expect(
        parseProductCliCommand([
          "database",
          "webhook",
          kind,
          "--project",
          project,
          "--environment",
          "prod",
          "--webhook",
          webhook,
          "--yes",
          "--json",
        ]),
      ).toMatchObject({
        kind: `database-webhook-${kind}`,
        environment: "prod",
        webhookId: webhook,
      });
    }
    expect(
      parseProductCliCommand([
        "database",
        "webhook",
        "deliveries",
        "--project",
        project,
        "--webhook",
        webhook,
        "--limit",
        "25",
        "--cursor",
        "cursor-a",
        "--json",
      ]),
    ).toMatchObject({
      kind: "database-webhook-deliveries",
      environment: "dev",
      webhookId: webhook,
      limit: 25,
      cursor: "cursor-a",
    });
    expect(
      parseProductCliCommand([
        "database",
        "webhook",
        "replay",
        "--project",
        project,
        "--environment",
        "dev",
        "--delivery",
        delivery,
        "--yes",
        "--json",
      ]),
    ).toMatchObject({ kind: "database-webhook-replay", deliveryId: delivery });
    for (const argv of [
      [
        "database",
        "webhook",
        "create",
        "--project",
        project,
        "--environment",
        "dev",
        "--url",
        "https://hooks.example.com/pg",
        "--event-types",
        "database.ready",
        "--idempotency-key",
        "hook-c",
        "--json",
      ],
      [
        "database",
        "webhook",
        "create",
        "--project",
        project,
        "--environment",
        "dev",
        "--url",
        "http://hooks.example.com/pg",
        "--event-types",
        "database.ready",
        "--idempotency-key",
        "hook-c",
        "--yes",
        "--json",
      ],
      [
        "database",
        "webhook",
        "create",
        "--project",
        project,
        "--environment",
        "dev",
        "--url",
        "https://hooks.example.com/pg",
        "--event-types",
        "*",
        "--idempotency-key",
        "hook-c",
        "--yes",
        "--json",
      ],
      [
        "database",
        "webhook",
        "create",
        "--project",
        project,
        "--environment",
        "stage",
        "--url",
        "https://hooks.example.com/pg",
        "--event-types",
        "database.ready",
        "--idempotency-key",
        "hook-c",
        "--yes",
        "--json",
      ],
      ["database", "webhook", "list", "--project", project, "--yes", "--json"],
      ["database", "webhook", "get", "--project", project, "--json"],
      [
        "database",
        "webhook",
        "delete",
        "--project",
        project,
        "--environment",
        "dev",
        "--webhook",
        webhook,
        "--json",
      ],
      [
        "database",
        "webhook",
        "test",
        "--project",
        project,
        "--environment",
        "dev",
        "--webhook",
        "bad id",
        "--yes",
        "--json",
      ],
      ["database", "webhook", "deliveries", "--project", project, "--limit", "0", "--json"],
      ["database", "webhook", "deliveries", "--project", project, "--limit", "101", "--json"],
      [
        "database",
        "webhook",
        "create",
        "--project",
        project,
        "--url",
        "https://hooks.example.com/pg",
        "--event-types",
        "database.ready",
        "--idempotency-key",
        "hook-c",
        "--yes",
        "--json",
      ],
      [
        "database",
        "webhook",
        "delete",
        "--project",
        project,
        "--webhook",
        webhook,
        "--yes",
        "--json",
      ],
      [
        "database",
        "webhook",
        "test",
        "--project",
        project,
        "--webhook",
        webhook,
        "--yes",
        "--json",
      ],
      [
        "database",
        "webhook",
        "replay",
        "--project",
        project,
        "--delivery",
        delivery,
        "--yes",
        "--json",
      ],
      [
        "database",
        "webhook",
        "replay",
        "--project",
        project,
        "--environment",
        "dev",
        "--delivery",
        delivery,
        "--json",
      ],
    ])
      expect(() => parseProductCliCommand(argv)).toThrow(InvalidCommandError);
    for (const label of [
      "database webhook create",
      "database webhook list",
      "database webhook get",
      "database webhook delete",
      "database webhook test",
      "database webhook deliveries",
      "database webhook replay",
    ])
      expect(recognizedCommandLabel(label.split(" "))).toBe(label);
  });

  it("takes an optional --idempotency-key on webhook delete, test and replay and on schedule run, and keeps none by default", () => {
    const project = "00000000000000000000000002";
    const webhook = "whk_abcdefghij0123456789";
    const delivery = "dlv_0123456789abcdef0123";
    expect(
      parseProductCliCommand([
        "database",
        "webhook",
        "delete",
        "--project",
        project,
        "--environment",
        "dev",
        "--webhook",
        webhook,
        "--idempotency-key",
        "delete-key-0001",
        "--yes",
        "--json",
      ]),
    ).toMatchObject({ kind: "database-webhook-delete", idempotencyKey: "delete-key-0001" });
    expect(
      parseProductCliCommand([
        "database",
        "webhook",
        "test",
        "--project",
        project,
        "--environment",
        "dev",
        "--webhook",
        webhook,
        "--yes",
        "--json",
      ]),
    ).toMatchObject({ kind: "database-webhook-test", idempotencyKey: null });
    expect(
      parseProductCliCommand([
        "database",
        "webhook",
        "test",
        "--project",
        project,
        "--environment",
        "dev",
        "--webhook",
        webhook,
        "--idempotency-key",
        "test-key-0001",
        "--yes",
        "--json",
      ]),
    ).toMatchObject({ kind: "database-webhook-test", idempotencyKey: "test-key-0001" });
    expect(
      parseProductCliCommand([
        "database",
        "webhook",
        "replay",
        "--project",
        project,
        "--environment",
        "dev",
        "--delivery",
        delivery,
        "--idempotency-key",
        "replay-key-0001",
        "--yes",
        "--json",
      ]),
    ).toMatchObject({ kind: "database-webhook-replay", idempotencyKey: "replay-key-0001" });
    expect(
      parseProductCliCommand([
        "database",
        "schedule",
        "run",
        "--project",
        project,
        "--environment",
        "dev",
        "--name",
        "tick",
        "--idempotency-key",
        "run-key-0001",
        "--yes",
        "--json",
      ]),
    ).toMatchObject({ kind: "database-schedule-run", idempotencyKey: "run-key-0001" });
  });

  it("parses database watch commands; create needs the columns, the key and --yes, and lists default to Dev", () => {
    const project = "00000000000000000000000002";
    const watch = "pgcf_watch_0a1b2c3d";
    const watchCreate = (
      options: Record<string, string | undefined>,
      flags: readonly string[] = ["--yes", "--json"],
    ) => [
      "database",
      "watch",
      "create",
      ...Object.entries({
        "--project": project,
        "--environment": "prod",
        "--table": "orders",
        "--columns": "id,total",
        "--idempotency-key": "watch-a",
        ...options,
      }).flatMap(([name, value]) => (value === undefined ? [] : [name, value])),
      ...flags,
    ];
    expect(parseProductCliCommand(watchCreate({}))).toEqual({
      kind: "database-watch-create",
      projectId: project,
      environment: "prod",
      request: {
        schema: "public",
        table: "orders",
        columns: ["id", "total"],
        operations: ["insert", "update", "delete"],
      },
      idempotencyKey: "watch-a",
      yes: true,
      credentialStore: "native",
    });
    expect(
      parseProductCliCommand(watchCreate({ "--schema": "sales", "--operations": "delete,insert" })),
    ).toMatchObject({
      kind: "database-watch-create",
      request: { schema: "sales", operations: ["insert", "delete"] },
    });
    for (const argv of [
      watchCreate({}, ["--json"]),
      watchCreate({ "--idempotency-key": undefined }),
      watchCreate({ "--columns": undefined }),
      watchCreate({ "--table": undefined }),
      watchCreate({ "--environment": undefined }),
      watchCreate({ "--environment": "staging" }),
      watchCreate({ "--columns": "a b" }),
      watchCreate({ "--columns": "id,id" }),
      watchCreate({ "--columns": Array.from({ length: 33 }, (_, index) => `c${index}`).join(",") }),
      watchCreate({ "--schema": "pgcf" }),
      watchCreate({ "--operations": "truncate" }),
      watchCreate({}, ["--yes", "--wait", "--json"]),
      watchCreate({}, ["--yes", "--follow", "--json"]),
      ["database", "watch", "list", "--project", project, "--yes", "--json"],
      [
        "database",
        "watch",
        "delete",
        "--project",
        project,
        "--environment",
        "dev",
        "--watch",
        watch,
        "--idempotency-key",
        "watch-b",
        "--json",
      ],
      [
        "database",
        "watch",
        "delete",
        "--project",
        project,
        "--environment",
        "dev",
        "--watch",
        "whk_abcdefghijklmnopqrst",
        "--idempotency-key",
        "watch-b",
        "--yes",
        "--json",
      ],
      [
        "database",
        "watch",
        "delete",
        "--project",
        project,
        "--watch",
        watch,
        "--idempotency-key",
        "watch-b",
        "--yes",
        "--json",
      ],
      [
        "database",
        "watch",
        "delete",
        "--project",
        project,
        "--environment",
        "dev",
        "--watch",
        watch,
        "--yes",
        "--json",
      ],
    ])
      expect(() => parseProductCliCommand(argv)).toThrow(InvalidCommandError);
    expect(
      parseProductCliCommand(["database", "watch", "list", "--project", project, "--json"]),
    ).toEqual({
      kind: "database-watch-list",
      projectId: project,
      environment: "dev",
      credentialStore: "native",
    });
    expect(
      parseProductCliCommand([
        "database",
        "watch",
        "delete",
        "--project",
        project,
        "--environment",
        "dev",
        "--watch",
        watch,
        "--idempotency-key",
        "watch-b",
        "--yes",
        "--json",
      ]),
    ).toEqual({
      kind: "database-watch-delete",
      projectId: project,
      environment: "dev",
      watchId: watch,
      idempotencyKey: "watch-b",
      yes: true,
      credentialStore: "native",
    });
    for (const label of ["database watch create", "database watch list", "database watch delete"])
      expect(recognizedCommandLabel(label.split(" "))).toBe(label);
  });

  it("parses database table create; the table name and primary key names are checked here, the columns file later", () => {
    const project = "00000000000000000000000002";
    const tableCreate = (
      options: Record<string, string | undefined>,
      flags: readonly string[] = ["--yes", "--json"],
    ) => [
      "database",
      "table",
      "create",
      ...Object.entries({
        "--project": project,
        "--environment": "dev",
        "--table": "orders",
        "--columns-file": "columns.json",
        "--idempotency-key": "table-a",
        ...options,
      }).flatMap(([name, value]) => (value === undefined ? [] : [name, value])),
      ...flags,
    ];
    expect(parseProductCliCommand(tableCreate({}))).toEqual({
      kind: "database-table-create",
      projectId: project,
      environment: "dev",
      table: "orders",
      columnsFile: "columns.json",
      primaryKey: [],
      idempotencyKey: "table-a",
      yes: true,
      credentialStore: "native",
    });
    expect(
      parseProductCliCommand(tableCreate({ "--environment": "prod", "--primary-key": "id,day" })),
    ).toMatchObject({
      kind: "database-table-create",
      environment: "prod",
      primaryKey: ["id", "day"],
    });
    for (const argv of [
      tableCreate({}, ["--json"]),
      tableCreate({ "--idempotency-key": undefined }),
      tableCreate({ "--columns-file": undefined }),
      tableCreate({ "--table": undefined }),
      tableCreate({ "--table": "Orders" }),
      tableCreate({ "--table": "pg_orders" }),
      tableCreate({ "--table": "select" }),
      tableCreate({ "--environment": undefined }),
      tableCreate({ "--environment": "staging" }),
      tableCreate({ "--primary-key": "id,,day" }),
      tableCreate({ "--primary-key": "Id" }),
      tableCreate({}, ["--yes", "--wait", "--json"]),
    ])
      expect(() => parseProductCliCommand(argv), argv.join(" ")).toThrow(InvalidCommandError);
    expect(recognizedCommandLabel(["database", "table", "create"])).toBe("database table create");
  });

  it("accepts data event types for a webhook and refuses a bare * as a subscription", () => {
    const project = "00000000000000000000000002";
    expect(
      parseProductCliCommand([
        "database",
        "webhook",
        "create",
        "--project",
        project,
        "--environment",
        "dev",
        "--url",
        "https://hooks.example.com/pg",
        "--event-types",
        "data.orders,data.*",
        "--idempotency-key",
        "hook-d",
        "--yes",
        "--json",
      ]),
    ).toMatchObject({ kind: "database-webhook-create", eventTypes: ["data.orders", "data.*"] });
    expect(() =>
      parseProductCliCommand([
        "database",
        "webhook",
        "create",
        "--project",
        project,
        "--environment",
        "dev",
        "--url",
        "https://hooks.example.com/pg",
        "--event-types",
        "*",
        "--idempotency-key",
        "hook-e",
        "--yes",
        "--json",
      ]),
    ).toThrow(InvalidCommandError);
  });

  it("parses database schedule and execution commands; reads default to Dev and changes need --yes", () => {
    const project = "00000000000000000000000002";
    const schedule = ["database", "schedule"];
    expect(
      parseProductCliCommand([
        ...schedule,
        "set",
        "--project",
        project,
        "--environment",
        "prod",
        "--name",
        "nightly_cleanup",
        "--every-seconds",
        "60",
        "--statements-file",
        "statements.json",
        "--timeout-ms",
        "5000",
        "--enabled",
        "false",
        "--yes",
        "--json",
      ]),
    ).toEqual({
      kind: "database-schedule-set",
      projectId: project,
      environment: "prod",
      name: "nightly_cleanup",
      cron: null,
      everySeconds: 60,
      statementsFile: "statements.json",
      timeoutMs: 5000,
      enabled: false,
      yes: true,
      credentialStore: "native",
    });
    expect(
      parseProductCliCommand([
        ...schedule,
        "set",
        "--project",
        project,
        "--environment",
        "dev",
        "--name",
        "tick",
        "--cron",
        "*/5 * * * *",
        "--statements-file",
        "statements.json",
        "--yes",
        "--json",
      ]),
    ).toEqual({
      kind: "database-schedule-set",
      projectId: project,
      environment: "dev",
      name: "tick",
      cron: "*/5 * * * *",
      everySeconds: null,
      statementsFile: "statements.json",
      timeoutMs: null,
      enabled: null,
      yes: true,
      credentialStore: "native",
    });
    expect(parseProductCliCommand([...schedule, "list", "--project", project, "--json"])).toEqual({
      kind: "database-schedule-list",
      projectId: project,
      environment: "dev",
      credentialStore: "native",
    });
    expect(
      parseProductCliCommand([
        ...schedule,
        "get",
        "--project",
        project,
        "--name",
        "tick",
        "--json",
      ]),
    ).toEqual({
      kind: "database-schedule-get",
      projectId: project,
      environment: "dev",
      name: "tick",
      credentialStore: "native",
    });
    expect(
      parseProductCliCommand([
        ...schedule,
        "runs",
        "--project",
        project,
        "--name",
        "tick",
        "--limit",
        "50",
        "--json",
      ]),
    ).toEqual({
      kind: "database-schedule-runs",
      projectId: project,
      environment: "dev",
      name: "tick",
      limit: 50,
      credentialStore: "native",
    });
    expect(
      parseProductCliCommand([
        ...schedule,
        "delete",
        "--project",
        project,
        "--environment",
        "dev",
        "--name",
        "tick",
        "--yes",
        "--json",
      ]),
    ).toEqual({
      kind: "database-schedule-delete",
      projectId: project,
      environment: "dev",
      name: "tick",
      yes: true,
      credentialStore: "native",
    });
    expect(
      parseProductCliCommand([
        ...schedule,
        "run",
        "--project",
        project,
        "--environment",
        "dev",
        "--name",
        "tick",
        "--yes",
        "--json",
      ]),
    ).toEqual({
      kind: "database-schedule-run",
      projectId: project,
      environment: "dev",
      name: "tick",
      idempotencyKey: null,
      yes: true,
      credentialStore: "native",
    });
    expect(
      parseProductCliCommand([
        "database",
        "executions",
        "--project",
        project,
        "--from",
        "2026-10-30T00:00:00.000Z",
        "--to",
        "2026-10-31T00:00:00.000Z",
        "--granularity",
        "hour",
        "--limit",
        "10",
        "--cursor",
        "abc|1",
        "--json",
      ]),
    ).toEqual({
      kind: "database-executions",
      projectId: project,
      environment: "dev",
      from: "2026-10-30T00:00:00.000Z",
      to: "2026-10-31T00:00:00.000Z",
      granularity: "hour",
      limit: 10,
      cursor: "abc|1",
      credentialStore: "native",
    });

    const setBase = [
      ...schedule,
      "set",
      "--project",
      project,
      "--environment",
      "dev",
      "--name",
      "tick",
      "--every-seconds",
      "60",
      "--statements-file",
      "statements.json",
    ];
    const usageBase = [
      "database",
      "executions",
      "--project",
      project,
      "--from",
      "2026-10-30T00:00:00.000Z",
      "--to",
      "2026-10-30T02:00:00.000Z",
      "--granularity",
      "hour",
    ];
    for (const argv of [
      [...setBase],
      [...setBase, "--cron", "*/5 * * * *", "--yes"],
      [...setBase.filter((value) => value !== "--every-seconds"), "--yes"],
      [...setBase.map((value) => (value === "60" ? "1.5" : value)), "--yes"],
      [...setBase, "--timeout-ms", "1s", "--yes"],
      [...setBase, "--enabled", "yes", "--yes"],
      [...setBase.map((value) => (value === "tick" ? "Bad Name" : value)), "--yes"],
      [...setBase, "--yes", "--wait"],
      [...schedule, "list", "--project", project, "--yes"],
      [...schedule, "get", "--project", project, "--yes"],
      [...schedule, "get", "--project", project],
      [...schedule, "runs", "--project", project, "--name", "tick", "--limit", "51"],
      [...schedule, "delete", "--project", project, "--environment", "dev", "--name", "tick"],
      [...schedule, "run", "--project", project, "--environment", "dev", "--name", "tick"],
      [...schedule, "pause", "--project", project, "--yes"],
      [
        ...schedule,
        "set",
        "--project",
        project,
        "--name",
        "tick",
        "--every-seconds",
        "60",
        "--statements-file",
        "statements.json",
        "--yes",
      ],
      [
        ...schedule,
        "set",
        "--project",
        project,
        "--environment",
        "dev",
        "--name",
        "tick",
        "--every-seconds",
        "60",
        "--yes",
      ],
      [...schedule, "delete", "--project", project, "--name", "tick", "--yes"],
      [...schedule, "run", "--project", project, "--environment", "dev", "--yes"],
      [...schedule, "get", "--project", project, "--name", "tick", "--yes"],
      [...schedule, "runs", "--project", project, "--name", "tick", "--yes"],
      [
        ...schedule,
        "delete",
        "--project",
        project,
        "--environment",
        "dev",
        "--name",
        "tick",
        "--yes",
        "--wait",
      ],
      [
        ...schedule,
        "run",
        "--project",
        project,
        "--environment",
        "dev",
        "--name",
        "tick",
        "--yes",
        "--follow",
      ],
      [
        ...schedule,
        "delete",
        "--project",
        project,
        "--environment",
        "dev",
        "--name",
        "Bad Name",
        "--yes",
      ],
      [...schedule, "run", "--project", project, "--environment", "dev", "--yes"],
      [...usageBase.slice(0, -2), "--granularity", "week"],
      [...usageBase, "--yes"],
      [...usageBase.slice(0, 6), "--to", "2026-10-30T00:30:00.000Z", "--granularity", "hour"],
      [...usageBase.slice(0, 6), "--to", "2026-12-30T00:00:00.000Z", "--granularity", "hour"],
      [...usageBase, "--limit", "101"],
    ])
      expect(() => parseProductCliCommand(argv)).toThrow(InvalidCommandError);
    for (const label of [
      "database schedule set",
      "database schedule list",
      "database schedule get",
      "database schedule delete",
      "database schedule runs",
      "database schedule run",
      "database executions",
    ])
      expect(recognizedCommandLabel(label.split(" "))).toBe(label);
  });

  it.each([
    [["--help"], { kind: "help" }],
    [["help", "--json"], { kind: "help" }],
    [["--version"], { kind: "version" }],
    [["version", "--json"], { kind: "version" }],
    [["whoami", "--json"], { kind: "whoami" }],
    [
      ["project", "list", "--cursor", "01K2F3G4H5J6K7M8N9P0QRSTVW", "--limit", "25", "--json"],
      {
        kind: "project-list",
        cursor: "01K2F3G4H5J6K7M8N9P0QRSTVW",
        limit: 25,
      },
    ],
    [
      ["project", "status", "--project", "01K2F3G4H5J6K7M8N9P0QRSTVW", "--json"],
      { kind: "project-status", projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW" },
    ],
    [
      ["init", "--directory", "/workspace/app", "--project", "stay-simpli", "--dry-run", "--json"],
      {
        kind: "init",
        directory: "/workspace/app",
        project: "stay-simpli",
        root: undefined,
        dryRun: true,
      },
    ],
    [
      ["init", "--directory", "/workspace/repository", "--root", "site", "--json"],
      {
        kind: "init",
        directory: "/workspace/repository",
        project: undefined,
        root: "site",
        dryRun: false,
      },
    ],
    [
      ["init", "--root", ".", "--json"],
      { kind: "init", directory: ".", project: undefined, root: ".", dryRun: false },
    ],
    [
      ["init", "--region", "eu", "--json"],
      {
        kind: "init",
        directory: ".",
        project: undefined,
        root: undefined,
        region: "eu",
        dryRun: false,
      },
    ],
    [
      ["init", "--json"],
      { kind: "init", directory: ".", project: undefined, root: undefined, dryRun: false },
    ],
    [
      [
        "link",
        "--project",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--repository-owner",
        "sebmer-com",
        "--repository-name",
        "fixture",
        "--idempotency-key",
        "link-1",
      ],
      {
        kind: "link",
        projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
        repositoryOwner: "sebmer-com",
        repositoryName: "fixture",
        idempotencyKey: "link-1",
      },
    ],
    [
      [
        "source",
        "auto-deploy",
        "set",
        "--project",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--branch",
        "release/dev",
        "--enabled",
        "true",
        "--idempotency-key",
        "push-1",
      ],
      {
        kind: "source-auto-deploy-set",
        projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
        branch: "release/dev",
        enabled: true,
        idempotencyKey: "push-1",
      },
    ],
    [
      ["source", "auto-deploy", "status", "--project", "01K2F3G4H5J6K7M8N9P0QRSTVW"],
      { kind: "source-auto-deploy-status", projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW" },
    ],
    [
      [
        "domain",
        "cloudflare",
        "authorize",
        "--project",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--zone",
        "tenant-fixture.com",
        "--idempotency-key",
        "cloudflare-auth-1",
        "--json",
      ],
      {
        kind: "domain-cloudflare-authorize",
        projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
        zone: "tenant-fixture.com",
        idempotencyKey: "cloudflare-auth-1",
      },
    ],
    [
      ["domain", "cloudflare", "status", "--project", "01K2F3G4H5J6K7M8N9P0QRSTVW", "--json"],
      { kind: "domain-cloudflare-status", projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW" },
    ],
    [
      [
        "domain",
        "cloudflare",
        "apply",
        "--project",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--idempotency-key",
        "domains-apply-1",
        "--yes",
        "--wait",
        "--json",
      ],
      {
        kind: "domain-cloudflare-apply",
        projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
        idempotencyKey: "domains-apply-1",
        yes: true,
        wait: true,
      },
    ],
    [
      [
        "deployment",
        "logs",
        "--project",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--deployment",
        "01K2F3G4H5J6K7M8N9P0QRSTVX",
        "--cursor",
        "C1",
      ],
      {
        kind: "deployment-logs",
        projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
        deploymentId: "01K2F3G4H5J6K7M8N9P0QRSTVX",
        cursor: "C1",
      },
    ],
    [
      ["plan", "--project", "01K2F3G4H5J6K7M8N9P0QRSTVW", "--commit", "a".repeat(40)],
      { kind: "plan", projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW", commitSha: "a".repeat(40) },
    ],
    [
      [
        "deploy",
        "--project",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--plan-id",
        "01K2F3G4H5J6K7M8N9P0QRSTVX",
        "--idempotency-key",
        "deploy-1",
        "--yes",
        "--wait",
        "--json",
      ],
      {
        kind: "deploy",
        projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
        planId: "01K2F3G4H5J6K7M8N9P0QRSTVX",
        idempotencyKey: "deploy-1",
        yes: true,
        wait: true,
      },
    ],
    [
      ["logs", "01K2F3G4H5J6K7M8N9P0QRSTVW", "--follow", "--json"],
      { kind: "logs", operationId: "01K2F3G4H5J6K7M8N9P0QRSTVW", follow: true },
    ],
    [
      [
        "operation",
        "reconcile",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--idempotency-key",
        "reconcile-1",
        "--yes",
        "--json",
      ],
      {
        kind: "operation-reconcile",
        operationId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
        idempotencyKey: "reconcile-1",
        yes: true,
      },
    ],
    [
      [
        "rollback",
        "plan",
        "--project",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--deployment",
        "01K2F3G4H5J6K7M8N9P0QRSTVX",
      ],
      {
        kind: "rollback-plan",
        projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
        deploymentId: "01K2F3G4H5J6K7M8N9P0QRSTVX",
      },
    ],
    [
      [
        "deployment",
        "promote",
        "plan",
        "--project",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--deployment",
        "01K2F3G4H5J6K7M8N9P0QRSTVX",
      ],
      {
        kind: "promotion-plan",
        projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
        sourceDeploymentId: "01K2F3G4H5J6K7M8N9P0QRSTVX",
      },
    ],
    [
      [
        "deployment",
        "promote",
        "--project",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--deployment",
        "01K2F3G4H5J6K7M8N9P0QRSTVX",
        "--if-match",
        '"sha256-abc"',
        "--confirmation-token",
        "confirmation-token-value-1234567890",
        "--idempotency-key",
        "promote-1",
        "--yes",
        "--wait",
      ],
      {
        kind: "promote",
        projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
        sourceDeploymentId: "01K2F3G4H5J6K7M8N9P0QRSTVX",
        ifMatch: '"sha256-abc"',
        confirmationToken: "confirmation-token-value-1234567890",
        idempotencyKey: "promote-1",
        yes: true,
        wait: true,
      },
    ],
    [
      ["delete", "plan", "--project", "01K2F3G4H5J6K7M8N9P0QRSTVW"],
      { kind: "delete-plan", projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW" },
    ],
    [
      [
        "secret",
        "list",
        "--project",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--environment",
        "01K2F3G4H5J6K7M8N9P0QRSTVX",
      ],
      {
        kind: "secret-list",
        projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
        environmentId: "01K2F3G4H5J6K7M8N9P0QRSTVX",
      },
    ],
    [
      [
        "secret",
        "set",
        "API_KEY",
        "--project",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--environment",
        "01K2F3G4H5J6K7M8N9P0QRSTVX",
        "--idempotency-key",
        "secret-1",
        "--stdin",
        "--wait",
      ],
      {
        kind: "secret-set",
        name: "API_KEY",
        projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
        environmentId: "01K2F3G4H5J6K7M8N9P0QRSTVX",
        idempotencyKey: "secret-1",
        stdin: true,
        wait: true,
      },
    ],
    [
      [
        "secret",
        "set",
        "API_KEY",
        "--project",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--environment",
        "01K2F3G4H5J6K7M8N9P0QRSTVX",
        "--idempotency-key",
        "secret-1",
        "--token-user",
        "user_01M0CUSTOMER",
        "--token-organization",
        "01K2F3G4H5J6K7M8N9P0QRSTVY",
        "--stdin",
      ],
      {
        kind: "secret-set",
        name: "API_KEY",
        wait: false,
        environmentToken: {
          userId: "user_01M0CUSTOMER",
          organizationId: "01K2F3G4H5J6K7M8N9P0QRSTVY",
        },
      },
    ],
    [
      [
        "secret",
        "set",
        "API_KEY",
        "--project",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--environment",
        "01K2F3G4H5J6K7M8N9P0QRSTVX",
        "--idempotency-key",
        "secret-1",
        "--profile-user",
        "user_01M0CUSTOMER",
        "--profile-organization",
        "01K2F3G4H5J6K7M8N9P0QRSTVY",
        "--stdin",
      ],
      {
        kind: "secret-set",
        name: "API_KEY",
        profileAccount: {
          userId: "user_01M0CUSTOMER",
          organizationId: "01K2F3G4H5J6K7M8N9P0QRSTVY",
        },
      },
    ],
  ] as const)("parses product command %#", (argv, expected) => {
    expect(parseProductCliCommand(argv)).toMatchObject(expected);
  });

  it.each([
    "feature..one",
    "feature@{one",
    "feature one",
    "feature\\one",
    ".hidden",
    "release.lock",
    "trailing.",
    "a//b",
    "a~b",
    "a?b",
    "a[b",
  ])("rejects the invalid Git branch %s", (branch) => {
    expect(() =>
      parseProductCliCommand([
        "source",
        "auto-deploy",
        "set",
        "--project",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--branch",
        branch,
        "--enabled",
        "true",
        "--idempotency-key",
        "push-invalid",
      ]),
    ).toThrow(InvalidCommandError);
  });
  it("parses explicit auto-deploy disable", () => {
    expect(
      parseProductCliCommand([
        "source",
        "auto-deploy",
        "set",
        "--project",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--branch",
        "main",
        "--enabled",
        "false",
        "--idempotency-key",
        "disable-1",
      ]),
    ).toMatchObject({ kind: "source-auto-deploy-set", enabled: false, branch: "main" });
  });

  it.each([
    ["deploy", "--project", "p", "--plan-id", "x", "--idempotency-key", "k"],
    ["logs", "op", "--json"],
    ["operation", "reconcile", "op", "--idempotency-key", "k"],
    [
      "rollback",
      "--project",
      "p",
      "--deployment",
      "d",
      "--if-match",
      "e",
      "--confirmation-token",
      "t",
      "--idempotency-key",
      "k",
    ],
    [
      "deployment",
      "promote",
      "--project",
      "p",
      "--deployment",
      "d",
      "--if-match",
      "e",
      "--confirmation-token",
      "t",
      "--idempotency-key",
      "k",
    ],
    [
      "delete",
      "--project",
      "p",
      "--if-match",
      "e",
      "--confirmation-token",
      "t",
      "--idempotency-key",
      "k",
    ],
  ])("rejects missing explicit acknowledgement/follow for %#", (...argv) => {
    expect(() => parseProductCliCommand(argv)).toThrow(InvalidCommandError);
  });

  it.each([
    [
      "domain",
      "cloudflare",
      "authorize",
      "--project",
      "p",
      "--zone",
      "attacker.dev.check.omh.st",
      "--idempotency-key",
      "k",
    ],
    ["domain", "cloudflare", "apply", "--project", "p", "--idempotency-key", "k", "--yes"],
    ["domain", "cloudflare", "apply", "--project", "p", "--idempotency-key", "k", "--wait"],
  ])("rejects unsafe Cloudflare-domain input %#", (...argv) => {
    expect(() => parseProductCliCommand(argv)).toThrow(InvalidCommandError);
  });

  it("accepts flags in any order and returns one typed command", () => {
    expect(
      parseProductCliCommand([
        "--json",
        "project",
        "create",
        "--name",
        "alpha",
        "--idempotency-key",
        "create-a",
        "--organization",
        "org-a",
      ]),
    ).toEqual({
      kind: "project-create",
      organizationId: "org-a",
      name: "alpha",
      idempotencyKey: "create-a",
      credentialStore: "native",
    });
  });

  it("parses the hosting region of a new project and rejects any other region", () => {
    expect(
      parseProductCliCommand([
        "project",
        "create",
        "--organization",
        "org-a",
        "--name",
        "alpha",
        "--region",
        "eu",
        "--data-mode",
        "isolated",
        "--idempotency-key",
        "create-a",
        "--json",
      ]),
    ).toEqual({
      kind: "project-create",
      organizationId: "org-a",
      name: "alpha",
      dataMode: "isolated",
      region: "eu",
      idempotencyKey: "create-a",
      credentialStore: "native",
    });
    for (const region of ["apac", "EU", ""]) {
      expect(() =>
        parseProductCliCommand([
          "project",
          "create",
          "--organization",
          "org-a",
          "--name",
          "alpha",
          "--region",
          region,
          "--idempotency-key",
          "create-a",
          "--json",
        ]),
      ).toThrow(InvalidCommandError);
    }
  });

  it("parses the project dev-access create command without accepting credential arguments", () => {
    expect(
      parseProductCliCommand([
        "project",
        "dev-access",
        "create",
        "--project",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--json",
      ]),
    ).toEqual({
      kind: "project-dev-access-create",
      projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      credentialStore: "native",
    });
    expect(() =>
      parseProductCliCommand([
        "project",
        "dev-access",
        "create",
        "--project",
        "project-a",
        "--ticket",
        "secret",
      ]),
    ).toThrow(InvalidCommandError);
  });

  it("parses the project handle set command with the guard headers a rename needs", () => {
    expect(
      parseProductCliCommand([
        "project",
        "handle",
        "set",
        "--project",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--handle",
        "acme-shop",
        "--if-match",
        '"7"',
        "--idempotency-key",
        "rename-a",
      ]),
    ).toEqual({
      kind: "project-handle-set",
      projectId: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      handle: "acme-shop",
      ifMatch: '"7"',
      idempotencyKey: "rename-a",
      credentialStore: "native",
    });
    expect(
      recognizedCommandLabel(["project", "handle", "set", "--project", "p", "--handle", "a"]),
    ).toBe("project handle set");
    for (const argv of [
      ["project", "handle", "set", "--handle", "acme-shop", "--if-match", "7"],
      ["project", "handle", "set", "--project", "p", "--handle", "acme-shop"],
      [
        "project",
        "handle",
        "set",
        "--project",
        "p",
        "--handle",
        "acme-shop",
        "--if-match",
        "7",
        "--idempotency-key",
        "k",
        "--wait",
      ],
    ])
      expect(() => parseProductCliCommand(argv)).toThrow(InvalidCommandError);
  });

  it("parses the project handle check command and keeps the candidate unnormalised", () => {
    expect(
      parseProductCliCommand(["project", "handle", "check", "--handle", "quiet-otter-waves"]),
    ).toEqual({
      kind: "project-handle-check",
      handle: "quiet-otter-waves",
      credentialStore: "native",
    });
    expect(recognizedCommandLabel(["project", "handle", "check", "--handle", "a"])).toBe(
      "project handle check",
    );
    for (const argv of [
      ["project", "handle", "check"],
      ["project", "handle", "--handle", "quiet-otter-waves"],
      ["project", "handle", "check", "--handle", "quiet-otter-waves", "--yes"],
    ])
      expect(() => parseProductCliCommand(argv)).toThrow(InvalidCommandError);
  });

  it("does not expose a selectable file credential store", () => {
    expect(() => parseProductCliCommand(["login", "--credential-store=file"])).toThrow(
      InvalidCommandError,
    );
    expect(() =>
      parseProductCliCommand(["operation", "get", "operation-a", "--credential-store", "file"]),
    ).toThrow(InvalidCommandError);
  });

  it("rejects platform names on set, preserves installed keys on delete and explains the repair", () => {
    for (const name of [
      "DATABASE_URL",
      "HYPERDRIVE",
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
      "OHMYHOST_MAIL_KEY",
      "OHMYHOST_MAIL_GATEWAY_URL",
      "OHMYHOST_AI_KEY",
      "OHMYHOST_AI_BASE_URL",
    ]) {
      const args = (action: "set" | "delete") => [
        "secret",
        action,
        name,
        "--project",
        "project-a",
        "--environment",
        "environment-a",
        "--idempotency-key",
        "reserved-a",
        ...(action === "set" ? ["--stdin"] : []),
      ];
      expect(() => parseProductCliCommand(args("set"))).toThrow(InvalidCommandError);
      expect(invalidCommandAction(args("set"), "ohmyhost")).toContain("OHMYHOST_");
      expect(invalidCommandAction(args("set"), "ohmyhost")).toContain("reserved for the platform");
      if (
        [
          "BETTER_AUTH_SECRET",
          "OHMYHOST_MAIL_KEY",
          "OHMYHOST_STORAGE_KEY",
          "OHMYHOST_AI_KEY",
        ].includes(name)
      ) {
        expect(() => parseProductCliCommand(args("delete"))).toThrow(InvalidCommandError);
        expect(invalidCommandAction(args("delete"), "ohmyhost")).toContain("installed");
      } else
        expect(parseProductCliCommand(args("delete"))).toMatchObject({
          kind: "secret-delete",
          name,
        });
    }
    expect(
      invalidCommandAction(["secret", "set", "must-never-be-echoed"], "ohmyhost"),
    ).not.toContain("must-never-be-echoed");
  });

  it("rejects duplicates, unknown flags, and token-shaped arguments", () => {
    expect(() => parseProductCliCommand(["login", "--json", "--json"])).toThrow(
      InvalidCommandError,
    );
    expect(() => parseProductCliCommand(["login", "--token", "secret"])).toThrow(
      InvalidCommandError,
    );
    expect(() =>
      parseProductCliCommand([
        "secret",
        "set",
        "API_KEY",
        "--project",
        "project-a",
        "--environment",
        "environment-a",
        "--idempotency-key",
        "secret-a",
        "--value",
        "must-never-be-an-argument",
      ]),
    ).toThrow(InvalidCommandError);
    expect(() =>
      parseProductCliCommand([
        "operation",
        "get",
        "operation-a",
        "--api-url",
        "https://attacker.example",
      ]),
    ).toThrow(InvalidCommandError);
    // A key's account is named by its user and organization together, never by a key.
    const organization = "01K2F3G4H5J6K7M8N9P0QRSTVY";
    const secretSet = [
      "secret",
      "set",
      "API_KEY",
      "--project",
      "project-a",
      "--environment",
      "environment-a",
      "--idempotency-key",
      "secret-a",
      "--stdin",
    ];
    for (const account of [
      ["--token-user", "user_01M0CUSTOMER"],
      ["--token-organization", organization],
      ["--token-user", "user:01M0CUSTOMER", "--token-organization", organization],
      ["--token-user", "user_01M0CUSTOMER", "--token-organization", "org_01M0CUSTOMER"],
      ["--token-user", `sk_${"a".repeat(46)}`, "--token-organization", organization],
      ["--profile-user", "user_01M0CUSTOMER"],
      ["--profile-organization", organization],
      ["--profile-user", `sk_${"a".repeat(46)}`, "--profile-organization", organization],
      // A saved-login form and a key form contradict each other.
      [
        "--profile-user",
        "user_01M0CUSTOMER",
        "--profile-organization",
        organization,
        "--token-user",
        "user_01M0CUSTOMER",
        "--token-organization",
        organization,
      ],
    ])
      expect(() => parseProductCliCommand([...secretSet, ...account])).toThrow(InvalidCommandError);
  });

  it("derives invalid-command labels only from recognized command words", () => {
    expect(recognizedCommandLabel(["--help"])).toBe("help");
    expect(recognizedCommandLabel(["--version"])).toBe("version");
    expect(recognizedCommandLabel(["whoami"])).toBe("whoami");
    expect(recognizedCommandLabel(["init", "--dry-run"])).toBe("init");
    expect(recognizedCommandLabel(["login", "--token", "secret-value"])).toBe("login");
    expect(recognizedCommandLabel(["domain", "cloudflare", "authorize"])).toBe(
      "domain cloudflare authorize",
    );
    expect(recognizedCommandLabel(["attacker-secret-command", "--json"])).toBe("unknown");
    expect(recognizedCommandLabel(["--token", "login"])).toBe("unknown");
  });
});

it("parses connection consent with the default saved session and requires explicit disconnect confirmation", () => {
  const org = "01K00000000000000000000001",
    project = "01K00000000000000000000002",
    environment = "01K00000000000000000000003";
  expect(
    parseProductCliCommand([
      "connection",
      "begin",
      "--organization",
      org,
      "--project",
      project,
      "--environment",
      environment,
      "--idempotency-key",
      "one",
    ]),
  ).toMatchObject({ kind: "connection-begin", credentialStore: "native", organizationId: org });
  expect(
    parseProductCliCommand([
      "connection",
      "begin",
      "--organization",
      org,
      "--idempotency-key",
      "one",
    ]),
  ).toMatchObject({ kind: "connection-begin", organizationId: org });
  expect(
    parseProductCliCommand(["connection", "discover", "--organization", org, "--grant", project]),
  ).toMatchObject({ kind: "connection-discover", grantId: project });
  expect(
    parseProductCliCommand([
      "connection",
      "import",
      "--organization",
      org,
      "--grant",
      project,
      "--project",
      project,
      "--environment",
      environment,
      "--provider-organization",
      "1",
      "--team",
      "2",
      "--connection",
      "3",
      "--idempotency-key",
      "one",
    ]),
  ).toMatchObject({
    kind: "connection-import",
    projectId: project,
    environmentId: environment,
    connectionId: 3,
  });
  expect(() =>
    parseProductCliCommand([
      "connection",
      "begin",
      "--organization",
      org,
      "--project",
      project,
      "--idempotency-key",
      "one",
    ]),
  ).toThrow(InvalidCommandError);
  const discovery = [
    "connection",
    "discover",
    "--organization",
    org,
    "--project",
    project,
    "--environment",
    environment,
    "--grant",
    project,
  ];
  expect(parseProductCliCommand(discovery)).toMatchObject({
    kind: "connection-discover",
    organizationId: org,
    projectId: project,
    environmentId: environment,
    grantId: project,
  });
  expect(
    parseProductCliCommand([...discovery, "--provider-organization", "12", "--team", "34"]),
  ).toMatchObject({ providerOrganizationId: 12, teamId: 34 });
  for (const extra of [
    ["--team", "34"],
    ["--provider-organization", "0"],
    ["--provider-organization", "9007199254740992"],
    ["--provider-organization", "1", "--team", "bad"],
  ])
    expect(() => parseProductCliCommand([...discovery, ...extra])).toThrow(InvalidCommandError);
  expect(() =>
    parseProductCliCommand([
      "connection",
      "disconnect",
      "--organization",
      org,
      "--grant",
      project,
      "--idempotency-key",
      "one",
    ]),
  ).toThrow(InvalidCommandError);
});
