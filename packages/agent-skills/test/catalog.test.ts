import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { tokenizer } from "acorn";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { describe, expect, it } from "vitest";

import { createPrivateDatabaseClient } from "@ohmyhost/customer-runtime/database";
import { createTransactionalMailClient } from "@ohmyhost/customer-runtime/mail";
import { createPrivateStorageClient } from "@ohmyhost/customer-runtime/storage";

import { INSTALLED_PLATFORM_KEY_NAMES } from "../../contracts/src/secret-names";
import { remoteMcpToolDefinitions } from "../../sdk-ts/src/generated/mcp-remote.gen.js";

import {
  listOhmyhostSkillResources,
  ohmyhostSkillInstallCommand,
  readOhmyhostSkillResource,
} from "../src/index.js";

import {
  DATABASE_PAGE_MAX_ITEMS,
  DATABASE_WATCH_MAX_COLUMNS,
  DATABASE_WATCH_OPERATIONS,
  dataEventTopic,
  isDatabaseWebhookEventPattern,
  parseDatabaseWatchCreateRequest,
} from "../../contracts/src/database-events.js";
import { parseDatabaseTableCreateRequest } from "../../contracts/src/database-tables.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("ohmyhost agent skill catalog", () => {
  it("runs the gateway examples through the real mail and storage clients using global fetch", async () => {
    const projectId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const environmentId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
    const transferId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
    const deletionId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
    const key = "k".repeat(43);
    const env = Object.freeze({
      OHMYHOST_PROJECT_ID: projectId,
      OHMYHOST_ENVIRONMENT_ID: environmentId,
      OHMYHOST_MAIL_GATEWAY_URL: "https://mail.example.test",
      OHMYHOST_STORAGE_GATEWAY_URL: "https://storage.example.test",
      OHMYHOST_MAIL_KEY: key,
      OHMYHOST_STORAGE_KEY: key,
    });
    const imports: Record<string, unknown> = {
      "@ohmyhost/customer-runtime/mail": { createTransactionalMailClient },
      "@ohmyhost/customer-runtime/storage": { createPrivateStorageClient },
    };
    for (const [file, clientName] of [
      ["mail.md", "createTransactionalMailClient"],
      ["stack-contracts.md", "createPrivateStorageClient"],
    ] as const) {
      const reference = await readFile(
        resolve(repositoryRoot, "skills/ohmyhost-build-portable-app/references", file),
        "utf8",
      );
      const examples = [...reference.matchAll(/```ts\n([\s\S]*?)```/gu)]
        .map((match) => match[1] ?? "")
        .filter((body) => body.includes(clientName));
      expect(examples, file).toHaveLength(1);
      const requests: string[] = [];
      const fetch = async (request: Request) => {
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.origin}${url.pathname}`);
        if (url.origin === "https://signed.example.test") {
          expect(request.headers.get("authorization")).toBeNull();
          if (request.method === "PUT") {
            expect(await request.text()).toBe("hello");
            expect(request.headers.get("if-none-match")).toBe("*");
            return new Response(null, { status: 200 });
          }
          expect(request.method).toBe("GET");
          return new Response("hello");
        }
        expect(request.method).toBe("POST");
        expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
        const body = (await request.json()) as Record<string, unknown>;
        if (url.origin === env.OHMYHOST_MAIL_GATEWAY_URL) {
          expect(url.pathname).toBe("/v1/send");
          expect(body).toMatchObject({ project_id: projectId, to: "person@example.com" });
          expect(request.headers.get("idempotency-key")).toBe("example-mail-1");
          return Response.json(
            { state: "accepted", request_id: transferId, message_id: "mail-1" },
            { status: 202 },
          );
        }
        expect(url.origin).toBe(env.OHMYHOST_STORAGE_GATEWAY_URL);
        expect(body).toMatchObject({ projectId, environmentId });
        if (url.pathname === "/v1/uploads" || url.pathname === "/v1/downloads") {
          const operation = url.pathname === "/v1/uploads" ? "PUT" : "GET";
          expect(body["objectKey"]).toBe("checks/example.txt");
          expect(request.headers.get("idempotency-key")).toBe(
            operation === "PUT" ? "example-upload-1" : null,
          );
          return Response.json({
            state: "ready",
            ...(operation === "PUT" ? { transfer_id: transferId } : {}),
            capability: {
              operation,
              objectKey: "checks/example.txt",
              url: "https://signed.example.test/example.txt",
              expiresAt: "2026-10-24T12:05:00.000Z",
              expectedContentLength: operation === "PUT" ? 5 : null,
              requiredHeaders:
                operation === "PUT"
                  ? { "content-length": "5", "content-type": "text/plain", "if-none-match": "*" }
                  : {},
            },
          });
        }
        if (url.pathname === "/v1/uploads/complete") {
          expect(body["transferId"]).toBe(transferId);
          return Response.json({ state: "completed", transfer_id: transferId });
        }
        expect(url.pathname).toBe("/v1/deletions");
        expect(request.headers.get("idempotency-key")).toBe("example-delete-1");
        return Response.json({ state: "completed", deletion_id: deletionId });
      };
      for (const example of examples) {
        const code = transpileModule(example, {
          compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS },
        }).outputText;
        await runInNewContext(
          `(async () => {\n${code}\n})()`,
          {
            env,
            fetch,
            Request,
            TextEncoder,
            exports: {},
            require: (name: string) => {
              if (!Object.hasOwn(imports, name)) throw new Error("Unexpected example import");
              return imports[name];
            },
          },
          { timeout: 1000 },
        );
      }
      expect(requests).toEqual(
        file === "mail.md"
          ? ["POST https://mail.example.test/v1/send"]
          : [
              "POST https://storage.example.test/v1/uploads",
              "PUT https://signed.example.test/example.txt",
              "POST https://storage.example.test/v1/uploads/complete",
              "POST https://storage.example.test/v1/downloads",
              "GET https://signed.example.test/example.txt",
              "POST https://storage.example.test/v1/deletions",
            ],
      );
    }
  });

  it("keeps unsupported gateway transports out of source skills and their published mirrors", async () => {
    const unsupported =
      /\bOHMYHOST_(?:MAIL|STORAGE)_GATEWAY\b|never call it with ordinary outbound fetch|do not fall back to public fetch|createMailAttachmentClient/u;
    for (const directory of ["skills", "plugins/ohmyhost/skills"]) {
      for (const file of await readdir(resolve(repositoryRoot, directory), { recursive: true })) {
        if (!file.endsWith(".md")) continue;
        const text = await readFile(resolve(repositoryRoot, directory, file), "utf8");
        expect(text.replaceAll("`", ""), `${directory}/${file}`).not.toMatch(unsupported);
      }
    }
    for (const resource of listOhmyhostSkillResources())
      expect(resource.text.replaceAll("`", ""), resource.uri).not.toMatch(unsupported);
  });

  it("runs the database example it hands customers, so the snippet cannot rot", async () => {
    // Two applications independently invented wrong database clients on 2026-09-18 because no skill
    // showed the call. A documented example that nothing executes is how that happens twice.
    const reference = await readFile(
      resolve(repositoryRoot, "skills/ohmyhost-build-portable-app/references/database-runtime.md"),
      "utf8",
    );
    const snippets = [...reference.matchAll(/```ts\n([\s\S]*?)```/gu)].map(([, body]) => body);
    expect(snippets.length).toBeGreaterThan(0);
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const binding = {
      query: async (input: unknown) => {
        calls.push(input as { text: string; values: readonly unknown[] });
        return { command: "SELECT", rows: [{ ready: 1 }], rowCount: 1 };
      },
      transaction: async (input: unknown) => {
        for (const statement of input as Array<{ text: string; values: readonly unknown[] }>)
          calls.push(statement);
        return (input as unknown[]).map(() => ({ command: "INSERT", rows: [], rowCount: 1 }));
      },
    };
    const database = createPrivateDatabaseClient(binding);
    // Every statement the reference shows must be one the real client accepts.
    for (const snippet of snippets)
      for (const statement of snippet.matchAll(/text: "([^"]+)",\s*\n?\s*values: /gu)) {
        const start = statement.index + statement[0].length;
        expect(snippet[start]).toBe("[");
        let depth = 0;
        let end = 0;
        for (const token of tokenizer(snippet.slice(start), { ecmaVersion: "latest" })) {
          if (token.type.label === "[") depth += 1;
          if (token.type.label === "]") depth -= 1;
          if (depth === 0) {
            end = start + token.end;
            break;
          }
        }
        expect(end).toBeGreaterThan(start);
        // Execute only the reviewed local literal; parsing keeps nested objects/arrays intact.
        const values = runInNewContext(`(${snippet.slice(start, end)})`, {}, { timeout: 1000 });
        await database.query({
          text: statement[1] as string,
          values: JSON.parse(JSON.stringify(values)) as unknown[],
        });
      }
    expect(calls.length).toBeGreaterThan(0);
    expect(reference).toContain("createPrivateDatabaseClient");
    // The traps the reference names must stay named.
    expect(reference).toMatch(/typeof binding\.anything/u);
    expect(reference).toContain("OHMYHOST_PROJECT_ID");
  });

  it("keeps the table-watch guide in step with the data-event contract", async () => {
    const skill = await readFile(
      resolve(repositoryRoot, "skills/ohmyhost-manage-database/SKILL.md"),
      "utf8",
    );
    const section = skill
      .split(/^## /mu)
      .find((part) => part.startsWith("Get notified when a table changes\n"));
    expect(section).toBeDefined();
    const guide = section ?? "";
    const shell = [...guide.matchAll(/```sh\n([\s\S]*?)```/gu)].map(([, body]) => body ?? "");
    const create = shell.find((body) => body.includes("database watch create")) ?? "";
    const table = /--table (\S+)/u.exec(create)?.[1] ?? "";
    const columns = /--columns (\S+)/u.exec(create)?.[1] ?? "";
    const operations = /--operations (\S+)/u.exec(create)?.[1]?.split(",");
    const eventType = /--event-types (\S+)/u.exec(shell.join("\n"))?.[1] ?? "";
    expect(table).not.toBe("");
    expect(eventType).toBe(`data.${dataEventTopic(table)}`);
    expect(isDatabaseWebhookEventPattern(eventType)).toBe(true);
    expect(isDatabaseWebhookEventPattern("data.*")).toBe(true);
    expect(isDatabaseWebhookEventPattern("*")).toBe(false);
    const watch = parseDatabaseWatchCreateRequest({
      table,
      columns: columns.split(","),
      operations,
    });
    expect(watch.columns.length).toBeLessThanOrEqual(DATABASE_WATCH_MAX_COLUMNS);

    const envelope = JSON.parse(/```json\n([\s\S]*?)```/u.exec(guide)?.[1] ?? "null") as {
      id: string;
      type: string;
      occurred_at: string;
      project_id: string;
      database_id: string;
      epoch: number;
      seq: number;
      data: { schema: string; table: string; op: string };
      [key: string]: unknown;
    };
    expect(Object.keys(envelope).sort()).toEqual(
      ["data", "database_id", "epoch", "id", "occurred_at", "project_id", "seq", "type"].sort(),
    );
    expect(envelope.id).toBe(`${envelope.database_id}:${envelope.epoch}:${envelope.seq}`);
    expect(envelope.id).toMatch(/^[a-z][a-z0-9]{19}:[1-9][0-9]*:[1-9][0-9]*$/u);
    expect(envelope.type).toBe(`data.${dataEventTopic(envelope.data.table)}`);
    expect(Object.keys(envelope.data).sort()).toEqual(
      ["old_record", "op", "record", "schema", "table"].sort(),
    );
    expect(DATABASE_WATCH_OPERATIONS).toContain(envelope.data.op);

    // The traps the guide names must stay named.
    expect(guide).toContain(String(DATABASE_WATCH_MAX_COLUMNS));
    expect(guide).toContain(`${DATABASE_PAGE_MAX_ITEMS} watches`);
    for (const trap of [
      "53400",
      "power_outbox",
      "--exclude-schema=pgcf",
      "2^53",
      "database_watch_create",
      "database_watch_list",
      "database_watch_delete",
      "/v1/projects/{project_id}/database/watches",
      "database watch create",
      "database watch list",
      "database watch delete",
    ])
      expect(guide, trap).toContain(trap);
    expect(guide).toContain("Watch creation and deletion use separately named MCP tools");
    expect(guide).toMatch(/bare `\*` subscription does not include data events/u);
    expect(skill).not.toContain("wildcards and operation events are not offered");
  });

  it("names every installed platform key that delete refuses in the CLI deploy Skill", async () => {
    const skill = await readFile(
      resolve(repositoryRoot, "skills/ohmyhost-build-portable-app/references/cli-deploy.md"),
      "utf8",
    );
    const sentence = skill
      .split("\n")
      .find((line) => line.includes("Delete can remove a previously stored forbidden name"));
    expect(sentence).toBeDefined();
    for (const name of INSTALLED_PLATFORM_KEY_NAMES) expect(sentence).toContain(`\`${name}\``);
  });

  it("states that a suspended database resumes only through Paid access or credit", async () => {
    const skill = await readFile(
      resolve(repositoryRoot, "skills/ohmyhost-manage-database/SKILL.md"),
      "utf8",
    );
    expect(skill).not.toContain("resume it first");
    expect(skill).toMatch(/resumes only when Paid access or usable credit returns/u);
  });

  it("marks the local-only tools that remote-MCP Skills name and gives a remote fallback", async () => {
    const remote = await readFile(
      resolve(repositoryRoot, "apps/control-api/src/remote-mcp.ts"),
      "utf8",
    );
    const effects = remote.slice(
      remote.indexOf("const TOOL_EFFECTS = {"),
      remote.indexOf("} as const satisfies Record<keyof typeof TOOL_EFFECTS"),
    );
    const remoteTools = new Set([
      ...[...effects.matchAll(/^ {2}([a-z_]+): /gmu)].map((match) => match[1]),
      ...remoteMcpToolDefinitions.map(({ name }) => name),
    ]);
    const local = await readFile(resolve(repositoryRoot, "apps/mcp/src/local-server.ts"), "utf8");
    const localOnly = new Set(
      [...local.matchAll(/registerProductTool\(\s*server,\s*dependencies,\s*"([a-z_]+)"/gu)]
        .map((match) => match[1])
        .filter((name) => !remoteTools.has(name)),
    );
    // Verify the named capabilities that previously required local-only instructions.
    const named = new Set([
      "organization_credits_get",
      "organization_usage_get",
      "project_budget_get",
      "domain_paid_status",
      "mail_status",
      "feedback_submit",
      "feedback_status",
    ]);
    for (const skill of [
      "ohmyhost-usage-and-budgets",
      "ohmyhost-domains-and-mail",
      "ohmyhost-troubleshoot-deployment",
      "ohmyhost-get-started",
    ]) {
      const text = await readFile(resolve(repositoryRoot, `skills/${skill}/SKILL.md`), "utf8");
      for (const name of named) {
        if (!text.includes(`\`${name}\``)) continue;
        if (remoteTools.has(name)) {
          expect(text).not.toContain(
            `The local MCP server offers \`${name}\`; the remote MCP does not`,
          );
          continue;
        }
        if (!localOnly.has(name)) continue;
        if (name === "mail_status") {
          expect(
            text
              .split(/\n\s*\n/u)
              .some(
                (paragraph) =>
                  paragraph.includes("`mail_status`") && paragraph.includes("`mail_domain_status`"),
              ),
            `${skill} pairs the local mail summary with the named remote status tool`,
          ).toBe(true);
          continue;
        }
        const fallbacks = [
          ...text.matchAll(
            new RegExp(
              `The local MCP server offers \`${name}\`; the remote MCP does not, [^\\n]*?\\.(?=\\s|$)`,
              "gmu",
            ),
          ),
        ].map((match) => match[0]);
        expect(fallbacks, `${skill} states the remote fallback of ${name} once`).toHaveLength(1);
        // Only a bug report goes to the contact page; status, usage and budget answers are read in the portal or with the CLI.
        if (name !== "feedback_submit")
          expect(fallbacks[0], `${skill} sends ${name} to no contact page`).not.toMatch(
            /contact page/u,
          );
      }
    }
  });

  it("tells the migration Skill that the baseline input is a plain-SQL pg_dump whose order is trusted", async () => {
    const skill = await readFile(
      resolve(repositoryRoot, "skills/ohmyhost-migrate-supabase-postgres/SKILL.md"),
      "utf8",
    );
    expect(skill).toMatch(/`--input` must be a plain-SQL `pg_dump`/u);
    expect(skill).toMatch(/keeps the dump's order, which is trusted/u);
  });

  it("keeps the create-table guide in step with the table contract", async () => {
    const skill = await readFile(
      resolve(repositoryRoot, "skills/ohmyhost-manage-database/SKILL.md"),
      "utf8",
    );
    const section = skill.split(/^## /mu).find((part) => part.startsWith("Create a table\n"));
    expect(section).toBeDefined();
    const guide = section ?? "";
    for (const name of [
      "ohmyhost database table create",
      "database_table_create",
      "database_table_conflict",
      "database_table_limit",
      "created false",
      "migration role",
      "public schema",
    ])
      expect(guide, name).toContain(name);
    const columns = JSON.parse(/```json\n([\s\S]*?)```/u.exec(guide)?.[1] ?? "null") as unknown;
    expect(() =>
      parseDatabaseTableCreateRequest({
        table: "orders",
        columns,
        primaryKey: ["id"],
      }),
    ).not.toThrow();
    expect(guide).not.toContain("—");
  });

  it("names the problem code and the whole-event payload limit that customers see", async () => {
    const skill = await readFile(
      resolve(repositoryRoot, "skills/ohmyhost-manage-database/SKILL.md"),
      "utf8",
    );
    const section =
      skill
        .split(/^## /mu)
        .find((part) => part.startsWith("Get notified when a table changes\n")) ?? "";
    // The answer carries the problem code, not the internal outcome name.
    expect(section).toContain("`database_watch_events_unavailable`");
    expect(section).not.toMatch(/(?<!database_)`watch_events_unavailable`/u);
    // The limit covers the whole event, so an update counts its listed columns twice.
    expect(section).toMatch(/16 KiB for the event as a whole[^.]*old_record/u);
    expect(section).toContain("SQLSTATE 54000");
  });

  it("embeds the exact installable skill and supporting-resource bytes", async () => {
    const resources = listOhmyhostSkillResources();
    expect(resources.map(({ uri }) => uri)).toEqual([
      "skill://ohmyhost/ohmyhost-build-portable-app/SKILL.md",
      "skill://ohmyhost/ohmyhost-build-portable-app/references/ai.md",
      "skill://ohmyhost/ohmyhost-build-portable-app/references/browser-pdf.md",
      "skill://ohmyhost/ohmyhost-build-portable-app/references/cli-deploy.md",
      "skill://ohmyhost/ohmyhost-build-portable-app/references/database-runtime.md",
      "skill://ohmyhost/ohmyhost-build-portable-app/references/mail.md",
      "skill://ohmyhost/ohmyhost-build-portable-app/references/row-level-security.md",
      "skill://ohmyhost/ohmyhost-build-portable-app/references/stack-contracts.md",
      "skill://ohmyhost/ohmyhost-deploy-github/SKILL.md",
      "skill://ohmyhost/ohmyhost-deploy/SKILL.md",
      "skill://ohmyhost/ohmyhost-domains-and-mail/SKILL.md",
      "skill://ohmyhost/ohmyhost-export-database/SKILL.md",
      "skill://ohmyhost/ohmyhost-get-started/SKILL.md",
      "skill://ohmyhost/ohmyhost-get-started/references/harness-setup.md",
      "skill://ohmyhost/ohmyhost-get-started/references/surfaces.md",
      "skill://ohmyhost/ohmyhost-manage-database/SKILL.md",
      "skill://ohmyhost/ohmyhost-migrate-supabase-postgres/SKILL.md",
      "skill://ohmyhost/ohmyhost-migrate-supabase-postgres/references/provider-contracts.md",
      "skill://ohmyhost/ohmyhost-migrate-supabase-postgres/scripts/create-portable-baseline.mjs",
      "skill://ohmyhost/ohmyhost-migrate-supabase-postgres/scripts/portable-rls.mjs",
      "skill://ohmyhost/ohmyhost-troubleshoot-deployment/SKILL.md",
      "skill://ohmyhost/ohmyhost-usage-and-budgets/SKILL.md",
    ]);
    for (const resource of resources) {
      await expect(
        readFile(
          resolve(repositoryRoot, "skills", resource.skillName, resource.relativePath),
          "utf8",
        ),
      ).resolves.toBe(resource.text);
      expect(readOhmyhostSkillResource(resource.uri)).toBe(resource);
    }
  });

  it("returns deterministic install commands and rejects unknown names or URIs", () => {
    expect(ohmyhostSkillInstallCommand("ohmyhost-build-portable-app")).toBe(
      "npx skills add amerged-org/ohmyhost-docs -s ohmyhost-build-portable-app",
    );
    expect(() => ohmyhostSkillInstallCommand("unknown")).toThrow("Unknown ohmyhost skill");
    expect(() => readOhmyhostSkillResource("skill://ohmyhost/unknown")).toThrow(
      "Unknown ohmyhost skill resource",
    );
  });

  it("links mail progress guidance to the named remote tool and canonical REST path", async () => {
    const fallback = "/v1/projects/{project_id}/environments/{environment_id}/mail-domain";
    const troubleshoot = await readFile(
      resolve(repositoryRoot, "skills/ohmyhost-troubleshoot-deployment/SKILL.md"),
      "utf8",
    );
    const tool = remoteMcpToolDefinitions.find(({ name }) => name === "mail_domain_status");
    expect(tool?.operationId).toBe("getManagedMailDomain");
    const waitingForMail = troubleshoot
      .split("\n")
      .find((line) => line.startsWith("| `waiting_for_mail`"));
    expect(waitingForMail).toContain("remote `mail_domain_status`");
    expect(waitingForMail).toContain("local `mail_status`");
    expect(waitingForMail).toContain(fallback);
    // The operation_get description is the one local tool text that names the mail status tool.
    const local = await readFile(resolve(repositoryRoot, "apps/mcp/src/local-server.ts"), "utf8");
    const description = local.match(/"operation_get",\s+"([^"]+)"/u)?.[1] ?? "";
    expect(description).toContain("mail_domain_status");
    expect(description).toContain(fallback);
  });
});
