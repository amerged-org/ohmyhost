import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  listSavedProfiles,
  runProductionCli,
  TokenRefreshRejectedError,
  type ProductCliEnvironment,
  type TokenRefresher,
} from "@ohmyhost/product-cli";

import {
  accessToken,
  AMERGED,
  claimsOf,
  FakeCloud,
  KEY_A,
  KEY_B,
  KEY_TEAMMATE,
  ORG_A,
  ORG_B,
  ORG_LABS,
  PROJECT_A,
  PROJECT_B,
  SEBMER,
  savedCredential,
} from "../../product-cli/test/fake-cloud.js";
import { fillProfiles, login, memoryProfiles } from "../../product-cli/test/memory-profiles.js";
import { createAuthenticatedLocalMcpClient } from "../src/local-client.js";
import { createLocalOhmyhostMcpHandler } from "../src/local-server.js";

// One MCP server on a computer with the saved logins of two independent accounts. Each tool call
// chooses its own login; the in-memory registry keeps every real credential store out of reach.
const handlers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const handler of handlers.splice(0)) await handler.close();
  vi.unstubAllGlobals();
});

const serve = async (
  cloud: Pick<FakeCloud, "fetch">,
  environment: ProductCliEnvironment,
  prepared?: Awaited<ReturnType<typeof memoryProfiles>>,
  tokenRefresher?: TokenRefresher,
) => {
  const saved =
    prepared ??
    (await memoryProfiles([
      { profile: AMERGED, credential: savedCredential(AMERGED) },
      { profile: SEBMER, credential: savedCredential(SEBMER) },
    ]));
  const handler = createLocalOhmyhostMcpHandler({
    environment,
    authenticatedClient: (signal, request) =>
      createAuthenticatedLocalMcpClient(signal, {
        environment,
        profiles: saved.registry,
        fetch: cloud.fetch,
        ...(tokenRefresher === undefined ? {} : { tokenRefresher }),
        ...(request === undefined ? {} : { request }),
      }),
    listProfiles: (signal) =>
      listSavedProfiles(signal, { environment, profiles: saved.registry, fetch: cloud.fetch }),
  });
  handlers.push(handler);
  /** One JSON-RPC exchange with the server, as an MCP host sends it. */
  const rpc = async (method: string, params: Readonly<Record<string, unknown>>) => {
    const response = await handler.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    const text = await response.text();
    // No tool answer or error of any account ever carries token material.
    expect(text).not.toMatch(TOKEN_MATERIAL);
    return JSON.parse(
      text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6) ?? text,
    ) as {
      result?: {
        content?: { type: string; text?: string; uri?: string }[];
        contents?: { uri: string; text: string }[];
        isError?: boolean;
      };
      error?: { message: string };
    };
  };
  const call = async (name: string, args: Readonly<Record<string, unknown>>) => {
    const message = await rpc("tools/call", { name, arguments: args });
    return JSON.parse(message.result?.content?.[0]?.text ?? "null") as Record<string, unknown> & {
      error?: { code: string; suggested_action: string; acting_as?: unknown };
    };
  };
  return Object.assign(call, { rpc });
};
/** Access tokens, refresh tokens and the user API keys of the fake cloud. */
const TOKEN_MATERIAL = /eyJ[A-Za-z0-9_-]{8}|refresh\.user_|sk_[a-z]{46}/u;
/** The argv a shell passes to the CLI for a command returned by MCP. */
const argvOf = (command: unknown): string[] => {
  const prefix = "OHMYHOST_ENVIRONMENT=production ohmyhost ";
  expect(String(command).startsWith(prefix)).toBe(true);
  return (
    String(command)
      .slice(prefix.length)
      .match(/'[^']*'|\S+/gu) ?? []
  ).map((part) => part.replace(/^'(.*)'$/u, "$1"));
};
/** Runs a returned command with the real CLI in a terminal of the same computer. */
const runInTerminal = async (
  cloud: FakeCloud,
  registry: Awaited<ReturnType<typeof memoryProfiles>>["registry"],
  argv: readonly string[],
  terminal: ProductCliEnvironment,
  value: string,
) => {
  vi.stubGlobal("fetch", cloud.fetch);
  const output: string[] = [];
  let reads = 0;
  const exitCode = await runProductionCli(
    argv,
    { OHMYHOST_ENVIRONMENT: "production", ...terminal },
    { writeStdout: (text) => output.push(text), writeStderr: (text) => output.push(text) },
    new AbortController().signal,
    {
      profiles: registry,
      workingDirectory: await mkdtemp(join(tmpdir(), "ohmyhost-secret-")),
      readSecretValue: async () => {
        reads += 1;
        return value;
      },
    },
  );
  // Neither the secret nor any key or token of any account reaches the terminal.
  expect(output.join("")).not.toContain(value);
  expect(output.join("")).not.toMatch(TOKEN_MATERIAL);
  return {
    exitCode,
    reads,
    document: JSON.parse(output.at(-1) ?? "null") as Record<string, unknown> & {
      error?: { code: string; suggested_action: string };
    },
  };
};
const accountOf = (authorization: string | null): string => {
  const claims = claimsOf(authorization?.replace(/^Bearer /u, "") ?? "");
  return `${claims.sub}@${claims.org_id ?? "none"}`;
};

describe("MCP tool calls on a computer with several accounts", () => {
  it("runs every call as the login it names or its organization implies, never a guessed one", async () => {
    const cloud = new FakeCloud();
    const call = await serve(cloud, { OHMYHOST_ENVIRONMENT: "production" });

    const listed = await call("profile_list", {});
    expect(listed).toEqual({
      profiles: [
        {
          name: "amerged",
          user_id: "user_amerged",
          organization_id: ORG_A,
          organization_name: "amerged",
        },
        {
          name: "sebmer",
          user_id: "user_sebmer",
          organization_id: ORG_B,
          organization_name: "Sebmer",
        },
      ],
      bound: null,
      environment_token: false,
    });
    expect(JSON.stringify(listed)).not.toMatch(/refresh\.|eyJ/u);

    expect(await call("identity_get", { profile_name: "sebmer" })).toMatchObject({
      actor_id: "user:user_sebmer",
      organization_ids: [ORG_B],
      context: { credential: "profile", profile: { name: "sebmer", organization_id: ORG_B } },
    });

    cloud.calls.length = 0;
    const unnamed = await call("project_status", { project_id: PROJECT_B });
    expect(unnamed.error?.code).toBe("profile_selection_required");
    expect(unnamed.error?.suggested_action).toContain("pass profile_name (see profile_list)");
    expect(cloud.calls).toEqual([]);

    // A wrong login is named in the error, so it is not mistaken for a missing project.
    expect(
      (await call("project_status", { project_id: PROJECT_B, profile_name: "amerged" })).error,
    ).toMatchObject({
      code: "resource_not_found",
      acting_as: { credential: "profile", profile: { name: "amerged", organization_id: ORG_A } },
    });
    expect(
      await call("project_status", { project_id: PROJECT_B, profile_name: "sebmer" }),
    ).toMatchObject({ project_id: PROJECT_B });

    // A call about one organization runs as that organization's login without a name.
    cloud.calls.length = 0;
    await call("github_status", { organization_id: ORG_A });
    expect(cloud.calls.map((entry) => [entry.path, accountOf(entry.authorization)])).toEqual([
      [`/v1/organizations/${ORG_A}/github`, `user_amerged@${ORG_A}`],
    ]);

    const missing = await call("identity_get", { profile_name: "nobody" });
    expect(missing.error?.code).toBe("profile_not_found");
    expect(missing.error?.suggested_action).toContain(
      "OHMYHOST_ENVIRONMENT=production ohmyhost login --profile-name nobody --json",
    );
  });

  it("keeps a bound server and its OHMYHOST_TOKEN on their own account", async () => {
    const bound = await serve(new FakeCloud(), {
      OHMYHOST_ENVIRONMENT: "production",
      OHMYHOST_PROFILE: "amerged",
    });
    expect((await bound("identity_get", {}))["context"]).toMatchObject({
      profile: { name: "amerged" },
    });
    expect((await bound("identity_get", { profile_name: "sebmer" })).error?.code).toBe(
      "profile_context_mismatch",
    );
    expect((await bound("github_status", { organization_id: ORG_B })).error?.code).toBe(
      "profile_context_mismatch",
    );

    const cloud = new FakeCloud();
    const keyed = await serve(cloud, { OHMYHOST_ENVIRONMENT: "production", OHMYHOST_TOKEN: KEY_A });
    const refused = await keyed("github_status", { organization_id: ORG_B });
    expect(refused.error?.code).toBe("environment_token_context_mismatch");
    expect(cloud.calls.map((entry) => `${entry.method} ${entry.path}`)).toEqual(["GET /v1/me"]);
    expect((await keyed("identity_get", {}))["context"]).toEqual({
      credential: "environment_token",
      profile: null,
    });
    expect((await keyed("profile_list", {}))["environment_token"]).toBe(true);
    // A key belongs to one workspace, so creating another is refused before anything is sent.
    cloud.calls.length = 0;
    const created = await keyed("organization_create", {
      name: "Labs",
      idempotency_key: "labs-with-key",
    });
    expect(created.error).toMatchObject({ code: "interactive_login_required", retryable: false });
    expect(created.error?.suggested_action).toContain(
      "Run 'OHMYHOST_ENVIRONMENT=production ohmyhost login --json' and then the organization command in a terminal without OHMYHOST_TOKEN.",
    );
    expect(created.error?.suggested_action).toContain(
      "remove OHMYHOST_TOKEN from this server's env block and restart it",
    );
    expect(cloud.calls).toEqual([]);

    // A login of an earlier client that no longer fits stays where it is, and the call says how
    // to make room instead of failing as an unavailable store.
    const legacy = savedCredential(AMERGED);
    const full = await memoryProfiles([], legacy);
    await fillProfiles(full.registry, (index) =>
      login(`filler-${String(index)}`, `user_filler${String(index)}`, ORG_A, "F"),
    );
    const limited = await serve(new FakeCloud(), { OHMYHOST_ENVIRONMENT: "production" }, full);
    const noRoom = await limited("identity_get", {});
    expect(noRoom.error?.code).toBe("profile_limit_reached");
    expect(noRoom.error?.suggested_action).toContain(
      "OHMYHOST_ENVIRONMENT=production ohmyhost logout --profile-name NAME --json",
    );
    expect(await full.registry.legacy().read()).toEqual(legacy);
  });

  it("returns a secret command that the real CLI runs as exactly the login the call chose", async () => {
    const cloud = new FakeCloud();
    const saved = await memoryProfiles([
      { profile: AMERGED, credential: savedCredential(AMERGED) },
      { profile: SEBMER, credential: savedCredential(SEBMER) },
    ]);
    const call = await serve(cloud, { OHMYHOST_ENVIRONMENT: "production" }, saved);
    const environmentB = `01K3E${"B".repeat(21)}`;
    const ask = {
      project_id: PROJECT_B,
      environment_id: environmentB,
      name: "GEMINI_API_KEY",
      idempotency_key: "secret-set-1",
    };

    // Two accounts and no name: nothing is guessed, sent or returned.
    expect((await call("secret_set_command", ask)).error?.code).toBe("profile_selection_required");
    expect(cloud.calls).toEqual([]);
    // A login that cannot see the project, or no such login, gets no command either.
    expect(await call("secret_set_command", { ...ask, profile_name: "amerged" })).toMatchObject({
      error: {
        code: "resource_not_found",
        acting_as: { profile: { name: "amerged", organization_id: ORG_A } },
      },
    });
    expect((await call("secret_set_command", { ...ask, profile_name: "nobody" })).error?.code).toBe(
      "profile_not_found",
    );

    const chosen = await call("secret_set_command", { ...ask, profile_name: "sebmer" });
    expect(chosen["acting_as"]).toEqual({
      credential: "profile",
      profile: {
        name: "sebmer",
        user_id: "user_sebmer",
        organization_id: ORG_B,
        organization_name: "Sebmer",
      },
    });
    const argv = argvOf(chosen["command"]);
    expect(argv).toEqual([
      "secret",
      "set",
      "GEMINI_API_KEY",
      "--project",
      PROJECT_B,
      "--environment",
      environmentB,
      "--idempotency-key",
      "secret-set-1",
      "--profile-name",
      "sebmer",
      "--profile-user",
      "user_sebmer",
      "--profile-organization",
      ORG_B,
      "--stdin",
      "--wait",
      "--json",
    ]);

    // The customer runs the returned command in a terminal on the same computer.
    const run = (terminal: ProductCliEnvironment) =>
      runInTerminal(cloud, saved.registry, argv, terminal, "fake-secret-value-for-sebmer");
    cloud.calls.length = 0;
    const written = await run({});
    expect(written.exitCode).toBe(0);
    expect(written.document).toMatchObject({
      command: "secret set",
      status: "ready",
      secret: { name: "GEMINI_API_KEY", delivery_state: "ready" },
    });
    const secrets = `/v1/projects/${PROJECT_B}/environments/${environmentB}/secrets`;
    expect(
      cloud.calls.map((entry) => [entry.method, entry.path, accountOf(entry.authorization)]),
    ).toEqual([
      ["PUT", `${secrets}/GEMINI_API_KEY`, `user_sebmer@${ORG_B}`],
      ["GET", secrets, `user_sebmer@${ORG_B}`],
    ]);
    // A terminal bound to the other login, or holding the other account's key, writes nothing.
    cloud.calls.length = 0;
    expect((await run({ OHMYHOST_PROFILE: "amerged" })).document.error?.code).toBe(
      "profile_context_mismatch",
    );
    expect((await run({ OHMYHOST_TOKEN: KEY_A })).document.error?.code).toBe(
      "environment_token_context_mismatch",
    );
    expect(cloud.calls.map((entry) => `${entry.method} ${entry.path}`)).toEqual(["GET /v1/me"]);

    // A bound server names its own login and refuses another one.
    const bound = await serve(
      new FakeCloud(),
      { OHMYHOST_ENVIRONMENT: "production", OHMYHOST_PROFILE: "amerged" },
      saved,
    );
    expect(
      (await bound("secret_set_command", { ...ask, profile_name: "sebmer" })).error?.code,
    ).toBe("profile_context_mismatch");
    expect(
      String((await bound("secret_set_command", { ...ask, project_id: PROJECT_A }))["command"]),
    ).toContain(
      `--profile-name 'amerged' --profile-user 'user_amerged' --profile-organization '${ORG_A}' --stdin`,
    );

    // The login a workspace step suggests names the same user, so another browser account saves nothing.
    cloud.amergedAlsoInLabs = true;
    const addLogin = `login --organization ${ORG_LABS.id} --user user_amerged --json`;
    expect(
      String(
        (
          await call("organization_create", {
            name: "Labs",
            idempotency_key: "labs-1",
            profile_name: "amerged",
          })
        )["next_action"],
      ),
    ).toContain(addLogin);
    const fixed = await call("organization_use", {
      organization_id: ORG_LABS.id,
      profile_name: "amerged",
    });
    expect(fixed.error?.code).toBe("profile_organization_fixed");
    expect(fixed.error?.suggested_action).toContain(addLogin);
  });

  it("refuses a copied secret command where the login of that name is someone else's", async () => {
    const cloud = new FakeCloud();
    // Computer A runs the MCP server with Sebmer's own login.
    const computerA = await memoryProfiles([
      { profile: SEBMER, credential: savedCredential(SEBMER) },
    ]);
    const call = await serve(cloud, { OHMYHOST_ENVIRONMENT: "production" }, computerA);
    const environmentB = `01K3E${"B".repeat(21)}`;
    const handed = await call("secret_set_command", {
      project_id: PROJECT_B,
      environment_id: environmentB,
      name: "GEMINI_API_KEY",
      idempotency_key: "secret-set-3",
    });
    expect(String(handed["instruction"])).toContain(
      `belongs to user user_sebmer in organization ${ORG_B}`,
    );
    const argv = argvOf(handed["command"]);
    expect(argv.slice(9, 15)).toEqual([
      "--profile-name",
      "sebmer",
      "--profile-user",
      "user_sebmer",
      "--profile-organization",
      ORG_B,
    ]);

    // Computer B is a colleague's in the same workspace, whose login got the same name; computer C
    // has no login of that name at all.
    const colleague = login("sebmer", "user_colleague", ORG_B, "Sebmer");
    const computerB = await memoryProfiles([
      { profile: colleague, credential: savedCredential(colleague) },
    ]);
    const computerC = await memoryProfiles([
      { profile: AMERGED, credential: savedCredential(AMERGED) },
    ]);
    const run = async (
      registry: Awaited<ReturnType<typeof memoryProfiles>>["registry"],
      command: readonly string[] = argv,
    ) => {
      cloud.calls.length = 0;
      const result = await runInTerminal(cloud, registry, command, {}, "fake-secret-value-copied");
      return { ...result, sent: cloud.calls.length };
    };
    const colleagues = await run(computerB.registry);
    expect(colleagues.exitCode).toBe(2);
    expect(colleagues.document.error?.code).toBe("profile_context_mismatch");
    expect(colleagues.document.error?.suggested_action).toContain(
      "belongs to user user_colleague, not user_sebmer",
    );
    // Without that login, or with half of the account pair lost in copying, it stops as well.
    const missing = await run(computerC.registry);
    expect(missing.document.error?.code).toBe("profile_not_found");
    const halved = await run(
      computerA.registry,
      argv.filter(
        (part, index) =>
          part !== "--profile-organization" && argv[index - 1] !== "--profile-organization",
      ),
    );
    expect(halved.document.error?.code).toBe("invalid_command");
    // None of them read the value or sent anything.
    for (const refused of [colleagues, missing, halved])
      expect([refused.sent, refused.reads]).toEqual([0, 0]);

    // On the computer whose login it names, the same command writes as that account.
    const written = await run(computerA.registry);
    expect([written.exitCode, written.reads]).toEqual([0, 1]);
    const secrets = `/v1/projects/${PROJECT_B}/environments/${environmentB}/secrets`;
    expect(
      cloud.calls.map((entry) => [entry.method, entry.path, accountOf(entry.authorization)]),
    ).toEqual([
      ["PUT", `${secrets}/GEMINI_API_KEY`, `user_sebmer@${ORG_B}`],
      ["GET", secrets, `user_sebmer@${ORG_B}`],
    ]);
  });

  it("hands an OHMYHOST_TOKEN server's secret command only to a key of the same account", async () => {
    const cloud = new FakeCloud();
    const saved = await memoryProfiles([
      { profile: AMERGED, credential: savedCredential(AMERGED) },
      { profile: SEBMER, credential: savedCredential(SEBMER) },
    ]);
    const keyed = await serve(
      cloud,
      { OHMYHOST_ENVIRONMENT: "production", OHMYHOST_TOKEN: KEY_A },
      saved,
    );
    const environmentA = `01K3E${"A".repeat(21)}`;
    const ask = {
      project_id: PROJECT_A,
      environment_id: environmentA,
      name: "GEMINI_API_KEY",
      idempotency_key: "secret-set-2",
    };
    expect(
      (await keyed("secret_set_command", { ...ask, profile_name: "sebmer" })).error?.code,
    ).toBe("environment_token_context_mismatch");

    // The key has no saved name, so the command names its verified user and organization.
    const handed = await keyed("secret_set_command", ask);
    expect(handed["acting_as"]).toEqual({ credential: "environment_token", profile: null });
    expect(String(handed["instruction"])).toContain(
      `OHMYHOST_TOKEN holds a key of user user_amerged in organization ${ORG_A}`,
    );
    const argv = argvOf(handed["command"]);
    expect(argv).toEqual([
      "secret",
      "set",
      "GEMINI_API_KEY",
      "--project",
      PROJECT_A,
      "--environment",
      environmentA,
      "--idempotency-key",
      "secret-set-2",
      "--token-user",
      "user_amerged",
      "--token-organization",
      ORG_A,
      "--stdin",
      "--wait",
      "--json",
    ]);

    const value = "fake-secret-value-for-amerged";
    const run = async (
      terminal: ProductCliEnvironment,
      registry: Awaited<ReturnType<typeof memoryProfiles>>["registry"] = saved.registry,
    ) => {
      cloud.calls.length = 0;
      const result = await runInTerminal(cloud, registry, argv, terminal, value);
      return { ...result, sent: cloud.calls.map((entry) => `${entry.method} ${entry.path}`) };
    };
    // A terminal with the same account's key writes the secret with that key.
    const written = await run({ OHMYHOST_TOKEN: KEY_A });
    expect(written.exitCode).toBe(0);
    expect(written.document).toMatchObject({ command: "secret set", status: "ready" });
    const secrets = `/v1/projects/${PROJECT_A}/environments/${environmentA}/secrets`;
    expect(written.sent).toEqual(["GET /v1/me", `PUT ${secrets}/GEMINI_API_KEY`, `GET ${secrets}`]);
    expect(cloud.calls.every((entry) => entry.authorization === `Bearer ${KEY_A}`)).toBe(true);
    expect(written.reads).toBe(1);

    // Without a key, a saved login never stands in, not even one of the same user and workspace.
    const empty = await memoryProfiles();
    for (const [terminal, registry] of [
      [{}, empty.registry],
      [{}, saved.registry],
      [{ OHMYHOST_PROFILE: "amerged" }, saved.registry],
    ] as const) {
      const refused = await run(terminal, registry);
      expect(refused.exitCode).toBe(2);
      expect(refused.document.error?.code).toBe("environment_token_required");
      expect(refused.document.error?.suggested_action).toContain(
        `OHMYHOST_TOKEN holding a key of user user_amerged in organization ${ORG_A}`,
      );
      expect(refused.sent).toEqual([]);
      expect(refused.reads).toBe(0);
    }
    // A key of another user in the same workspace, or of another workspace, reads only its own
    // identity and stops before the value is read or anything is written.
    for (const key of [KEY_TEAMMATE, KEY_B]) {
      const refused = await run({ OHMYHOST_TOKEN: key });
      expect(refused.exitCode).toBe(2);
      expect(refused.document.error?.code).toBe("environment_token_context_mismatch");
      expect(refused.sent).toEqual(["GET /v1/me"]);
      expect(refused.reads).toBe(0);
    }
  });

  it("names the saved login whose sign-in failed, or the server setting to correct", async () => {
    const past = "2026-01-01T00:00:00.000Z";
    const expired = await memoryProfiles([
      { profile: AMERGED, credential: savedCredential(AMERGED) },
      { profile: SEBMER, credential: { ...savedCredential(SEBMER), expiresAt: past } },
    ]);
    // The sign-in service ended Sebmer's login: only that login is removed, and it is named.
    const ended = await serve(new FakeCloud(), { OHMYHOST_ENVIRONMENT: "production" }, expired, {
      refresh: async () => {
        throw new TokenRefreshRejectedError();
      },
    });
    expect(
      (await ended("project_status", { project_id: PROJECT_B, profile_name: "sebmer" })).error,
    ).toEqual({
      code: "authentication_required",
      retryable: false,
      suggested_action: `The sign-in of saved login sebmer (user user_sebmer, organization ${ORG_B}) ended and it was removed. Run 'OHMYHOST_ENVIRONMENT=production ohmyhost login --organization ${ORG_B} --user user_sebmer --profile-name sebmer --json', send its link and code to the customer, then repeat this call; the MCP server needs no restart.`,
    });
    expect((await expired.registry.list()).map((profile) => profile.name)).toEqual(["amerged"]);

    // An unreachable sign-in service keeps the login; one without an organization is named so.
    const solo = login("solo", "user_solo", null);
    const kept = await memoryProfiles([
      {
        profile: solo,
        credential: {
          accessToken: accessToken("user_solo", null),
          refreshToken: "refresh.user_solo.saved",
          expiresAt: past,
        },
      },
    ]);
    const unreachable = await serve(new FakeCloud(), { OHMYHOST_ENVIRONMENT: "production" }, kept, {
      refresh: async () => {
        throw new Error("sign-in service unavailable");
      },
    });
    expect((await unreachable("identity_get", {})).error).toEqual({
      code: "token_refresh_failed",
      retryable: true,
      suggested_action:
        "The saved login solo could not be renewed at the sign-in service; it was kept. Repeat this call in a minute; if it keeps failing, run 'OHMYHOST_ENVIRONMENT=production ohmyhost login --user user_solo --profile-name solo --json'.",
    });
    expect(await kept.registry.list()).toEqual([solo]);

    // A server setting that no login can repair names that setting instead.
    const unbound = await serve(new FakeCloud(), {
      OHMYHOST_ENVIRONMENT: "production",
      OHMYHOST_PROFILE: "Not A Login",
    });
    for (const name of ["identity_get", "profile_list"])
      expect((await unbound(name, {})).error, name).toEqual({
        code: "invalid_profile_binding",
        retryable: false,
        suggested_action:
          "Set OHMYHOST_PROFILE in this MCP server's env block to the name of a saved login (profile_list shows them), or remove it, then restart the server.",
      });
    const keyed = await serve(new FakeCloud(), {
      OHMYHOST_ENVIRONMENT: "production",
      OHMYHOST_TOKEN: "not-a-user-api-key",
    });
    expect((await keyed("identity_get", {})).error).toMatchObject({
      code: "invalid_environment_token",
      retryable: false,
      suggested_action: expect.stringContaining("ohmyhost login does not help while it is set"),
    });
  });

  it("reads a project's context as the login its link names", async () => {
    const cloud = new FakeCloud();
    const markdown = "# shop\n\nLifecycle: active";
    // The API answers a project's context only inside the organization that owns it.
    const call = await serve(
      {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (new URL(request.url).pathname !== `/v1/projects/${PROJECT_B}/context`)
            return cloud.fetch(request);
          expect(accountOf(request.headers.get("authorization"))).toBe(`user_sebmer@${ORG_B}`);
          return Response.json({
            project_id: PROJECT_B,
            generated_at: "2026-09-28T10:00:00.000Z",
            credit_access: "included",
            notes: { version: 0, markdown: "", updated_at: null },
            markdown,
          });
        },
      },
      { OHMYHOST_ENVIRONMENT: "production" },
    );

    const answered = await call.rpc("tools/call", {
      name: "project_status",
      arguments: { project_id: PROJECT_B, profile_name: "sebmer" },
    });
    const link = answered.result?.content?.find((item) => item.type === "resource_link");
    expect(link?.uri).toBe(`ohmyho://projects/${PROJECT_B}/context?profile_name=sebmer`);
    const read = await call.rpc("resources/read", { uri: link?.uri });
    expect(read.result?.contents).toEqual([
      { uri: link?.uri, mimeType: "text/markdown", text: markdown },
    ]);

    // Without the login's name, two logins could read it: the answer says how to choose.
    const unnamed = await call.rpc("resources/read", {
      uri: `ohmyho://projects/${PROJECT_B}/context`,
    });
    expect(unnamed.error?.message).toContain("profile_selection_required");
    expect(unnamed.error?.message).toContain("profile_name");
  });
  it("lists the workspaces of a login that has none yet and binds it to the chosen one", async () => {
    const cloud = new FakeCloud();
    const unbound = login("unbound", "user_amerged", null);
    const saved = await memoryProfiles([
      { profile: unbound, credential: savedCredential(unbound) },
    ]);
    const call = await serve(cloud, { OHMYHOST_ENVIRONMENT: "production" }, saved);

    const listed = await call("organization_list", {});
    expect(listed).toMatchObject({
      organizations: [{ id: ORG_A, name: "amerged" }],
      selected: null,
    });
    const used = await call("organization_use", { organization_id: ORG_A });
    expect(used).toMatchObject({ selected: ORG_A, profile: { name: "unbound" } });
    // The binding is saved with the login, so the next call is scoped to the workspace.
    expect(await call("organization_list", {})).toMatchObject({ selected: ORG_A });
  });
});
