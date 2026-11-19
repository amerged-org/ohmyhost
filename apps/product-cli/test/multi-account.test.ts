import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAuthenticatedProductTransport,
  listSavedProfiles,
  runProductionCli,
  type ProductCliEnvironment,
} from "../src/composition.js";
import type { LocalProfile } from "../src/profile-store.js";
import {
  AMERGED,
  claimsOf,
  FakeCloud,
  KEY_A,
  KEY_B,
  ORG_A,
  ORG_B,
  ORG_LABS,
  PLAN,
  PROJECT_A,
  PROJECT_B,
  SEBMER,
  savedCredential,
} from "./fake-cloud.js";
import { fillProfiles, login, memoryProfiles } from "./memory-profiles.js";

// Two independent ohmyho.st accounts on one computer, each with its own workspace. Every run gets
// an in-memory registry, and the Vitest guard blocks the native credential store besides.

/** Runs the real CLI composition the way a customer's shell would, against the fake cloud. */
const cliFor =
  (cloud: FakeCloud, registry: Awaited<ReturnType<typeof memoryProfiles>>["registry"]) =>
  async (
    argv: readonly string[],
    options: {
      environment?: ProductCliEnvironment;
      workingDirectory?: string;
      signal?: AbortSignal;
    } = {},
  ) => {
    vi.stubGlobal("fetch", cloud.fetch);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runProductionCli(
      [...argv, "--json"],
      { OHMYHOST_ENVIRONMENT: "production", ...options.environment },
      { writeStdout: (value) => stdout.push(value), writeStderr: (value) => stderr.push(value) },
      options.signal ?? new AbortController().signal,
      {
        profiles: registry,
        workingDirectory:
          options.workingDirectory ?? (await mkdtemp(join(tmpdir(), "ohmyhost-accounts-"))),
      },
    );
    const document = JSON.parse(stdout.at(-1) ?? "null") as Record<string, unknown> & {
      error?: { code: string; suggested_action: string; acting_as?: unknown };
    };
    // No answer, error or progress line of any account ever carries token material.
    expect(stdout.join("") + stderr.join("")).not.toMatch(TOKEN_MATERIAL);
    return { exitCode, document, stdout: stdout.join(""), stderr: stderr.join("") };
  };
/** Access tokens, refresh tokens and the user API key of the fake cloud. */
const TOKEN_MATERIAL = /eyJ[A-Za-z0-9_-]{8}|refresh\.user_|sk_[a-z]{46}/u;
/** The account a sent bearer belongs to, by its verified claims rather than its exact bytes. */
const accountOf = (authorization: string | null): string => {
  const claims = claimsOf(authorization?.replace(/^Bearer /u, "") ?? "");
  return `${claims.sub}@${claims.org_id ?? "none"}`;
};
const accountLabel = (profile: LocalProfile): string =>
  `${profile.userId}@${profile.organizationId ?? "none"}`;
const actingAs = (profile: LocalProfile) => ({
  credential: "profile",
  profile: {
    name: profile.name,
    user_id: profile.userId,
    organization_id: profile.organizationId,
    organization_name: profile.organizationName,
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("several ohmyho.st accounts on one computer", () => {
  it("adds each account's login, lists them without tokens and never guesses between them", async () => {
    const cloud = new FakeCloud();
    const saved = await memoryProfiles();
    const cli = cliFor(cloud, saved.registry);

    cloud.browser = "amerged";
    expect((await cli(["login"])).document).toMatchObject({
      status: "authenticated",
      organization: { id: ORG_A, name: "amerged" },
      profile: { name: "amerged", user_id: "user_amerged", organization_id: ORG_A },
    });
    cloud.browser = "sebmer";
    expect((await cli(["login"])).document).toMatchObject({
      status: "authenticated",
      organization: { id: ORG_B, name: "Sebmer" },
      profile: { name: "sebmer", user_id: "user_sebmer", organization_id: ORG_B },
    });
    const listed = await cli(["profile", "list"]);
    expect(listed.document).toEqual({
      version: 1,
      command: "profile list",
      status: "listed",
      profiles: [actingAs(AMERGED).profile, actingAs(SEBMER).profile],
      bound: null,
      environment_token: false,
    });
    expect(listed.stdout).not.toMatch(/refresh\.|eyJ/u);
    // MCP's profile_list answers from the same saved logins.
    expect(
      await listSavedProfiles(new AbortController().signal, {
        environment: { OHMYHOST_ENVIRONMENT: "production" },
        profiles: saved.registry,
        fetch: cloud.fetch,
      }),
    ).toEqual({
      profiles: [actingAs(AMERGED).profile, actingAs(SEBMER).profile],
      bound: null,
      environment_token: false,
    });

    // With two logins saved, a command that names no account is refused before any request.
    cloud.calls.length = 0;
    const unscoped = await cli(["project", "status", "--project", PROJECT_B]);
    expect([unscoped.exitCode, unscoped.document.error?.code]).toEqual([
      2,
      "profile_selection_required",
    ]);
    expect(unscoped.document.error?.suggested_action).toContain("amerged, sebmer");
    expect(cloud.calls).toEqual([]);

    // The wrong account is told apart from a missing project: the error names who asked.
    const wrong = await cli([
      "project",
      "status",
      "--project",
      PROJECT_B,
      "--profile-name",
      "amerged",
    ]);
    expect(wrong.document.error).toMatchObject({
      code: "resource_not_found",
      acting_as: actingAs(AMERGED),
    });
    const right = await cli([
      "project",
      "status",
      "--project",
      PROJECT_B,
      "--profile-name",
      "sebmer",
    ]);
    expect(right.exitCode).toBe(0);
    expect(right.document).toMatchObject({ context: actingAs(SEBMER) });
    expect(right.stderr).toContain(
      `acting as profile sebmer (user user_sebmer, organization Sebmer ${ORG_B})`,
    );

    // Deploying to either account uses exactly that account's credential.
    cloud.calls.length = 0;
    for (const [profile, project] of [
      [SEBMER, PROJECT_B],
      [AMERGED, PROJECT_A],
    ] as const) {
      const deployed = await cli([
        "deploy",
        "--project",
        project,
        "--plan-id",
        PLAN,
        "--idempotency-key",
        `deploy-${profile.name}`,
        "--yes",
        "--profile-name",
        profile.name,
      ]);
      expect(deployed.document).toMatchObject({ command: "deploy", status: "accepted" });
    }
    expect(cloud.calls.map((call) => [call.path, accountOf(call.authorization)])).toEqual([
      [`/v1/projects/${PROJECT_B}/deployments`, accountLabel(SEBMER)],
      [`/v1/projects/${PROJECT_A}/deployments`, accountLabel(AMERGED)],
    ]);

    // A process bound to one login cannot be pointed at another by a single command.
    expect(
      (await cli(["whoami"], { environment: { OHMYHOST_PROFILE: "sebmer" } })).document,
    ).toMatchObject({ identity: { actor_id: "user:user_sebmer" }, context: actingAs(SEBMER) });
    expect(
      (
        await cli(["whoami", "--profile-name", "amerged"], {
          environment: { OHMYHOST_PROFILE: "sebmer" },
        })
      ).document.error?.code,
    ).toBe("profile_context_mismatch");

    // Logging out removes only the chosen account's login.
    expect((await cli(["logout", "--profile-name", "amerged"])).document).toMatchObject({
      status: "logged_out",
      profile: actingAs(AMERGED).profile,
    });
    expect(await saved.registry.list()).toEqual([SEBMER]);
    expect(await saved.credential(SEBMER)).toMatchObject({ organizationId: ORG_B });
    // The last login needs no name to log out, and logging out without a login does nothing.
    expect((await cli(["logout"])).document).toMatchObject({
      status: "logged_out",
      profile: actingAs(SEBMER).profile,
    });
    const again = await cli(["logout"]);
    expect([again.exitCode, again.document]).toEqual([
      0,
      { version: 1, command: "logout", status: "logged_out" },
    ]);
    expect(await saved.registry.list()).toEqual([]);
  }, 20_000);

  it("saves nothing on a wrong, unverified, refused or abandoned sign-in and keeps every login", async () => {
    const cloud = new FakeCloud();
    const saved = await memoryProfiles([
      { profile: AMERGED, credential: savedCredential(AMERGED) },
    ]);
    const before = await saved.credential(AMERGED);
    const cli = cliFor(cloud, saved.registry);

    // The customer's prompt asked for sebmer, but the browser is still signed in as amerged.
    cloud.browser = "amerged";
    const mismatch = await cli(["login", "--organization", ORG_B, "--user", "user_sebmer"]);
    expect([mismatch.exitCode, mismatch.document.error?.code]).toEqual([
      4,
      "login_account_mismatch",
    ]);
    expect(mismatch.document.error?.suggested_action).toContain(
      "The browser signed in as user user_amerged, not user_sebmer. Nothing was saved",
    );
    // A workspace the signed-in account does not belong to is refused before anything is saved.
    const foreign = await cli(["login", "--organization", ORG_B]);
    expect(foreign.document.error?.code).toBe("organization_not_found");
    // An alias of another account's login is never taken over.
    cloud.browser = "sebmer";
    const conflict = await cli(["login", "--profile-name", "amerged"]);
    expect(conflict.document.error?.code).toBe("profile_name_conflict");
    // A workspace token that names another account than the one that signed in is not saved.
    cloud.workspaceTokenFor = "amerged";
    const unverified = await cli(["login", "--organization", ORG_B]);
    expect([unverified.exitCode, unverified.document.error?.code]).toEqual([
      4,
      "login_verification_failed",
    ]);
    expect(unverified.document.error?.suggested_action).toBe(
      `The signed-in account could not be verified; nothing was saved. Run 'OHMYHOST_ENVIRONMENT=production ohmyhost login --organization ${ORG_B} --json' again with the same flags and send the customer the new link and code.`,
    );
    cloud.workspaceTokenFor = undefined;
    // A sign-in the customer refuses or abandons saves nothing either.
    cloud.deviceDenied = true;
    const denied = await cli(["login"]);
    expect([denied.exitCode, denied.document.error?.code]).toEqual([
      4,
      "device_authorization_denied",
    ]);
    cloud.deviceDenied = false;
    const abandoned = new AbortController();
    abandoned.abort();
    expect((await cli(["login"], { signal: abandoned.signal })).exitCode).toBe(130);
    // A computer whose saved logins fill the credential entry that lists them adds none.
    const full = await memoryProfiles();
    const fillers = await fillProfiles(full.registry, (index) =>
      login(`filler-${String(index)}`, `user_filler${String(index)}`, ORG_A, "F"),
    );
    const limited = await cliFor(cloud, full.registry)(["login", "--organization", ORG_B]);
    expect([limited.exitCode, limited.document.error?.code]).toEqual([2, "profile_limit_reached"]);
    expect(limited.document.error?.suggested_action).toContain(
      "OHMYHOST_ENVIRONMENT=production ohmyhost logout --profile-name NAME --json",
    );
    expect(await full.registry.list()).toHaveLength(fillers.length);
    expect(await saved.registry.list()).toEqual([AMERGED]);
    expect(await saved.credential(AMERGED)).toEqual(before);

    const added = await cli(["login", "--organization", ORG_B, "--user", "user_sebmer"]);
    expect(added.document).toMatchObject({
      status: "authenticated",
      profile: actingAs(SEBMER).profile,
    });
    expect(await saved.registry.list()).toEqual([AMERGED, SEBMER]);
    expect(await saved.credential(AMERGED)).toEqual(before);

    // Signing that saved login in again while the browser belongs to another account leaves it
    // exactly as it was.
    const sebmerBefore = await saved.credential(SEBMER);
    cloud.browser = "amerged";
    const wrongBrowser = await cli(["login", "--organization", ORG_B, "--user", "user_sebmer"]);
    expect(wrongBrowser.document.error?.code).toBe("login_account_mismatch");
    expect(await saved.credential(SEBMER)).toEqual(sebmerBefore);
    expect(await saved.registry.list()).toEqual([AMERGED, SEBMER]);
  }, 20_000);

  it("keeps concurrent agents on their own account while other logins change", async () => {
    const cloud = new FakeCloud();
    const saved = await memoryProfiles([
      { profile: AMERGED, credential: savedCredential(AMERGED) },
      { profile: SEBMER, credential: savedCredential(SEBMER) },
    ]);
    cloud.amergedAlsoInLabs = true;
    const cli = cliFor(cloud, saved.registry);
    let release: () => void = () => undefined;
    cloud.statusGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Agent A runs in a process bound to amerged and waits on the API.
    const agentA = cli(["project", "status", "--project", PROJECT_A], {
      environment: { OHMYHOST_PROFILE: "amerged" },
    });
    await vi.waitFor(() =>
      expect(cloud.calls.some((call) => call.path.endsWith(`${PROJECT_A}/status`))).toBe(true),
    );
    // Meanwhile another agent works as sebmer, tries to move amerged's login into another
    // workspace of the same user and then logs sebmer out. None of it may retarget agent A.
    cloud.statusGate = undefined;
    expect(
      (await cli(["project", "status", "--project", PROJECT_B, "--profile-name", "sebmer"]))
        .exitCode,
    ).toBe(0);
    // Its next step adds a login of the same user, so another browser account saves nothing.
    const addLogin = `login --organization ${ORG_LABS.id} --user user_amerged --json`;
    const fixed = await cli([
      "organization",
      "use",
      "--organization",
      ORG_LABS.id,
      "--profile-name",
      "amerged",
    ]);
    expect(fixed.document.error?.code).toBe("profile_organization_fixed");
    expect(fixed.document.error?.suggested_action).toContain(addLogin);
    const created = await cli([
      "organization",
      "create",
      "--name",
      "Labs",
      "--idempotency-key",
      "labs-1",
      "--profile-name",
      "amerged",
    ]);
    expect(created.document).toMatchObject({ selected: ORG_A, profile: { name: "amerged" } });
    expect(String(created.document["next_action"])).toContain(addLogin);
    expect((await cli(["logout", "--profile-name", "sebmer"])).exitCode).toBe(0);
    release();
    const finished = await agentA;
    expect(finished.exitCode).toBe(0);
    expect(finished.document).toMatchObject({
      project: { project_id: PROJECT_A },
      context: actingAs(AMERGED),
    });
    for (const call of cloud.calls.filter((entry) => entry.path.includes(PROJECT_A)))
      expect(accountOf(call.authorization)).toBe(accountLabel(AMERGED));
    for (const call of cloud.calls.filter((entry) => entry.path.includes(PROJECT_B)))
      expect(accountOf(call.authorization)).toBe(accountLabel(SEBMER));
    expect(await saved.registry.list()).toEqual([AMERGED]);
  }, 20_000);

  it("binds a login without organization under the name of that organization's existing login", async () => {
    const cloud = new FakeCloud();
    const fresh = login("fresh", "user_amerged", null);
    const saved = await memoryProfiles([
      { profile: AMERGED, credential: savedCredential(AMERGED) },
      { profile: fresh, credential: savedCredential(fresh) },
    ]);
    const cli = cliFor(cloud, saved.registry);

    const bound = await cli([
      "organization",
      "use",
      "--organization",
      ORG_A,
      "--profile-name",
      "fresh",
    ]);

    // The amerged login keeps its name; it is never silently renamed to the unbound login's alias.
    expect(bound.document).toMatchObject({
      status: "selected",
      selected: ORG_A,
      profile: actingAs(AMERGED).profile,
    });
    expect(await saved.registry.list()).toEqual([AMERGED]);
    expect(await saved.credential(fresh)).toBeUndefined();
    expect(await saved.credential(AMERGED)).toMatchObject({ organizationId: ORG_A });
  });

  it("refuses an OHMYHOST_TOKEN of another account before anything is sent", async () => {
    const cloud = new FakeCloud();
    const saved = await memoryProfiles([
      { profile: AMERGED, credential: savedCredential(AMERGED) },
      { profile: SEBMER, credential: savedCredential(SEBMER) },
    ]);
    const cli = cliFor(cloud, saved.registry);
    const withKey = { environment: { OHMYHOST_TOKEN: KEY_A } };

    const create = await cli(
      [
        "project",
        "create",
        "--organization",
        ORG_B,
        "--name",
        "shop",
        "--idempotency-key",
        "create-b",
      ],
      withKey,
    );
    expect([create.exitCode, create.document.error?.code]).toEqual([
      2,
      "environment_token_context_mismatch",
    ]);
    expect(create.document.error?.suggested_action).toContain(
      `OHMYHOST_TOKEN belongs to user user_amerged in organization ${ORG_A}, but this call targets organization ${ORG_B}.`,
    );
    expect(cloud.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /v1/me"]);
    expect((await cli(["whoami", "--profile-name", "sebmer"], withKey)).document.error?.code).toBe(
      "environment_token_context_mismatch",
    );
    // A call that names only the user it must run as is held to that user as well.
    cloud.calls.length = 0;
    const transport = (userId: string) =>
      createAuthenticatedProductTransport(new AbortController().signal, {
        environment: { OHMYHOST_ENVIRONMENT: "production", OHMYHOST_TOKEN: KEY_A },
        profiles: saved.registry,
        fetch: cloud.fetch,
        request: { userId },
      });
    await expect(transport("user_sebmer")).rejects.toMatchObject({
      code: "environment_token_context_mismatch",
      suggestedAction: expect.stringContaining("but this call targets user user_sebmer."),
    });
    expect(cloud.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /v1/me"]);
    expect((await transport("user_amerged")).context).toEqual({
      credential: "environment_token",
      profile: null,
    });
    // The key of the named account runs the command without touching any saved login.
    cloud.calls.length = 0;
    saved.writes.length = 0;
    const matching = await cli(
      ["project", "status", "--project", PROJECT_A, "--profile-name", "amerged"],
      withKey,
    );
    expect(matching.exitCode).toBe(0);
    expect(matching.document).toMatchObject({ context: { credential: "environment_token" } });
    expect(cloud.calls.map((call) => call.authorization)).toEqual([
      `Bearer ${KEY_A}`,
      `Bearer ${KEY_A}`,
    ]);
    expect(saved.writes).toEqual([]);
    // A command handed over from a key's MCP server runs only with a key of that same account.
    const handed = [
      "secret",
      "set",
      "API_KEY",
      "--project",
      PROJECT_A,
      "--environment",
      `01K3E${"A".repeat(21)}`,
      "--idempotency-key",
      "handed-1",
      "--token-user",
      "user_amerged",
      "--token-organization",
      ORG_A,
      "--stdin",
    ];
    cloud.calls.length = 0;
    const keyless = await cli(handed);
    expect([keyless.exitCode, keyless.document.error?.code]).toEqual([
      2,
      "environment_token_required",
    ]);
    expect(cloud.calls).toEqual([]);
    const otherKey = await cli(handed, { environment: { OHMYHOST_TOKEN: KEY_B } });
    expect(otherKey.document.error?.suggested_action).toContain(
      `OHMYHOST_TOKEN belongs to user user_sebmer in organization ${ORG_B}, but this call targets organization ${ORG_A}.`,
    );
    expect(cloud.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /v1/me"]);
    // The saved-login form holds the login of that name to its user and organization.
    cloud.calls.length = 0;
    const renamed = await cli([
      ...handed.slice(0, 9),
      "--profile-name",
      "sebmer",
      "--profile-user",
      "user_amerged",
      "--profile-organization",
      ORG_B,
      "--stdin",
    ]);
    expect([renamed.exitCode, renamed.document.error?.code]).toEqual([
      2,
      "profile_context_mismatch",
    ]);
    expect(cloud.calls).toEqual([]);
    expect(
      await listSavedProfiles(new AbortController().signal, {
        environment: {
          OHMYHOST_ENVIRONMENT: "production",
          OHMYHOST_TOKEN: KEY_A,
          OHMYHOST_PROFILE: "amerged",
        },
        profiles: saved.registry,
        fetch: cloud.fetch,
      }),
    ).toEqual({
      profiles: [actingAs(AMERGED).profile, actingAs(SEBMER).profile],
      bound: "amerged",
      environment_token: true,
    });
  });

  it("links one working copy for two organizations and uses an older link only after verifying it", async () => {
    const cloud = new FakeCloud();
    cloud.githubConnected.add(ORG_B);
    const saved = await memoryProfiles([
      { profile: AMERGED, credential: savedCredential(AMERGED) },
      { profile: SEBMER, credential: savedCredential(SEBMER) },
    ]);
    const cli = cliFor(cloud, saved.registry);
    const checkout = await mkdtemp(join(tmpdir(), "ohmyhost-checkout-"));
    const inCheckout = { workingDirectory: checkout };
    // The same GitHub repository is linked by both accounts, each through its own workspace.
    for (const [profile, project] of [
      [AMERGED, PROJECT_A],
      [SEBMER, PROJECT_B],
    ] as const)
      expect(
        (
          await cli(
            [
              "link",
              "--project",
              project,
              "--repository-owner",
              "acme",
              "--repository-name",
              "shop",
              "--idempotency-key",
              `link-${profile.name}`,
              "--profile-name",
              profile.name,
            ],
            inCheckout,
          )
        ).document,
      ).toMatchObject({ status: "completed", organization_id: profile.organizationId });
    expect((await readdir(join(checkout, ".ohmyhost/production/links"))).sort()).toEqual([
      `${ORG_A}.json`,
      `${ORG_B}.json`,
    ]);
    // Each login finds its own organization's project in the shared checkout.
    cloud.calls.length = 0;
    for (const [profile, project] of [
      [SEBMER, PROJECT_B],
      [AMERGED, PROJECT_A],
    ] as const) {
      const status = await cli(["project", "status", "--profile-name", profile.name], inCheckout);
      expect(status.document).toMatchObject({ project: { project_id: project } });
      expect(status.stderr).toContain(`using linked project ${project}`);
    }
    expect(cloud.calls.map((call) => [call.path, accountOf(call.authorization)])).toEqual([
      [`/v1/projects/${PROJECT_B}/status`, accountLabel(SEBMER)],
      [`/v1/projects/${PROJECT_A}/status`, accountLabel(AMERGED)],
    ]);
    const ambiguous = await cli(["project", "status"], inCheckout);
    expect(ambiguous.document.error?.code).toBe("linked_project_selection_required");
    // An explicit project linked in this checkout names its organization, and so its login.
    cloud.calls.length = 0;
    const explicit = await cli(["project", "status", "--project", PROJECT_B], inCheckout);
    expect(explicit.exitCode).toBe(0);
    expect(explicit.document).toMatchObject({
      project: { project_id: PROJECT_B },
      context: actingAs(SEBMER),
    });
    expect(cloud.calls.map((call) => accountOf(call.authorization))).toEqual([
      accountLabel(SEBMER),
    ]);

    // A link written before links named their organization is verified before use.
    const older = await mkdtemp(join(tmpdir(), "ohmyhost-older-link-"));
    await mkdir(join(older, ".ohmyhost/production"), { recursive: true });
    const legacyLink = JSON.stringify({
      version: 1,
      api_origin: "https://app.ohmyho.st",
      project_id: PROJECT_A,
      installation_id: "42",
      repository_full_name: "acme/shop",
    });
    await writeFile(join(older, ".ohmyhost/production/link.json"), legacyLink);
    cloud.calls.length = 0;
    const foreign = await cli(["project", "status", "--profile-name", "sebmer"], {
      workingDirectory: older,
    });
    expect(foreign.document.error?.code).toBe("linked_project_organization_mismatch");
    expect(cloud.calls.map((call) => call.path)).toEqual([`/v1/projects/${PROJECT_A}`]);
    expect(await readFile(join(older, ".ohmyhost/production/link.json"), "utf8")).toBe(legacyLink);
    const adopted = await cli(["project", "status", "--profile-name", "amerged"], {
      workingDirectory: older,
    });
    expect(adopted.document).toMatchObject({ project: { project_id: PROJECT_A } });
    expect(await readdir(join(older, ".ohmyhost/production/links"))).toEqual([`${ORG_A}.json`]);
    await expect(readFile(join(older, ".ohmyhost/production/link.json"), "utf8")).rejects.toThrow();
  }, 20_000);

  it("tells a wrong login, a workspace without GitHub and a repository outside the App apart", async () => {
    const cloud = new FakeCloud();
    const saved = await memoryProfiles([
      { profile: AMERGED, credential: savedCredential(AMERGED) },
      { profile: SEBMER, credential: savedCredential(SEBMER) },
    ]);
    const cli = cliFor(cloud, saved.registry);
    const link = (project: string, repository: string, profile: LocalProfile) =>
      cli([
        "link",
        "--project",
        project,
        "--repository-owner",
        "acme",
        "--repository-name",
        repository,
        "--idempotency-key",
        `link-${repository}`,
        "--profile-name",
        profile.name,
      ]);
    expect((await link(PROJECT_B, "shop", AMERGED)).document.error).toMatchObject({
      code: "resource_not_found",
      acting_as: actingAs(AMERGED),
    });
    expect((await link(PROJECT_B, "shop", SEBMER)).document.error).toMatchObject({
      code: "github_connection_required",
      acting_as: actingAs(SEBMER),
    });
    expect((await link(PROJECT_A, "private-tool", AMERGED)).document.error).toMatchObject({
      code: "repository_not_installed",
      acting_as: actingAs(AMERGED),
    });
  });

  it("moves a login saved before named profiles into one, keeping it until that succeeded", async () => {
    const cloud = new FakeCloud();
    const legacy = savedCredential(AMERGED);
    const saved = await memoryProfiles([], legacy);
    const cli = cliFor(cloud, saved.registry);

    cloud.identityUnavailable = true;
    const offline = await cli(["whoami"]);
    expect(offline.document.error?.code).toBe("network_error");
    expect(await saved.registry.legacy().read()).toEqual(legacy);
    expect(await saved.registry.list()).toEqual([]);

    cloud.identityUnavailable = false;
    const migrated = await cli(["whoami"]);
    expect(migrated.document).toMatchObject({
      identity: { actor_id: "user:user_amerged", organization_ids: [ORG_A] },
      context: actingAs(AMERGED),
    });
    expect(await saved.registry.list()).toEqual([AMERGED]);
    expect(await saved.credential(AMERGED)).toEqual(legacy);
    expect(await saved.registry.legacy().read()).toBeUndefined();

    // A saved login of the same account whose own credential is stale or missing, for example
    // after an interrupted earlier move, gets the verified one; MCP's profile_list moves it too.
    const stale = {
      ...legacy,
      refreshToken: "refresh.user_ghost.ended",
      expiresAt: "2026-01-01T00:00:00.000Z",
    };
    for (const target of [stale, undefined]) {
      const both = await memoryProfiles(
        [{ profile: AMERGED, credential: target ?? savedCredential(AMERGED) }],
        legacy,
      );
      if (target === undefined) await both.registry.credential(AMERGED).clear();
      expect(
        (
          await listSavedProfiles(new AbortController().signal, {
            environment: { OHMYHOST_ENVIRONMENT: "production" },
            profiles: both.registry,
            fetch: cloud.fetch,
          })
        ).profiles,
      ).toEqual([actingAs(AMERGED).profile]);
      expect(await both.credential(AMERGED)).toEqual(legacy);
      expect(await both.registry.legacy().read()).toBeUndefined();
      expect((await cliFor(cloud, both.registry)(["whoami"])).exitCode).toBe(0);
    }

    // A move that cannot finish keeps the old login and leaves no token of the new one; the next
    // command completes it.
    // (A read-only directory stops writes only for an ordinary user on a POSIX system.)
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const interrupted = await memoryProfiles([], legacy);
      await chmod(interrupted.directory, 0o500);
      const failed = await cliFor(cloud, interrupted.registry)(["whoami"]);
      await chmod(interrupted.directory, 0o700);
      expect(failed.document.error).toMatchObject({
        code: "credential_store_unavailable",
        retryable: false,
        suggested_action:
          "This computer's credential store (for example macOS Keychain or Windows Credential Manager) or the saved-login list in ~/.ohmyhost/profiles could not be read or written; nothing was changed. If the agent runs in a sandbox, run the command with access to them before asking the customer to sign in again. If the store is locked, ask the customer to unlock it, then run the command again. On a server, container or CI runner without a credential store, do not run login: load OHMYHOST_TOKEN from a private env file with a token from the portal's API Tokens page.",
      });
      expect(await interrupted.registry.legacy().read()).toEqual(legacy);
      expect(await interrupted.credential(AMERGED)).toBeUndefined();
      expect((await cliFor(cloud, interrupted.registry)(["whoami"])).exitCode).toBe(0);
      expect(await interrupted.registry.list()).toEqual([AMERGED]);
      expect(await interrupted.registry.legacy().read()).toBeUndefined();
    }

    // A login the provider already ended is removed; nothing is left to move.
    const ended = await memoryProfiles([], {
      ...legacy,
      refreshToken: "refresh.user_ghost.ended",
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
    const endedCli = cliFor(cloud, ended.registry);
    expect((await endedCli(["whoami"])).document.error?.code).toBe("authentication_required");
    expect(await ended.registry.legacy().read()).toBeUndefined();
    expect(await ended.registry.list()).toEqual([]);

    // A login the API refuses cannot be verified, so it is neither moved nor removed.
    const unverifiable = { ...legacy, accessToken: "not-a-token" };
    const refused = await memoryProfiles([], unverifiable);
    expect((await cliFor(cloud, refused.registry)(["whoami"])).document.error?.code).toBe(
      "authentication_required",
    );
    expect(await refused.registry.legacy().read()).toEqual(unverifiable);
    expect(await refused.registry.list()).toEqual([]);
  });
});
