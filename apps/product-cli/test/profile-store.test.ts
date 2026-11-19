import { execFile } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { chmod, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  CredentialStoreIntegrityError,
  CredentialStoreUnavailableError,
} from "../src/credential-store.js";
import {
  defaultProfileName,
  describeProfile,
  isProfileName,
  isProfileUserId,
  ProfileIndexFiles,
  ProfileLimitError,
  ProfileNameConflictError,
  profileSelectionError,
  publicProfile,
  selectProfile,
  selectProfileForOrganization,
  type LocalProfile,
} from "../src/profile-store.js";
import { fillProfiles, login, memoryProfiles } from "./memory-profiles.js";

const ORG_A = "01K3AAAAAAAAAAAAAAAAAAAAAA";
const ORG_B = "01K3BBBBBBBBBBBBBBBBBBBBBB";
const AMERGED = login("amerged", "user_amerged", ORG_A);
const SEBMER = login("sebmer", "user_sebmer", ORG_B);
const credential = (label: string) => ({
  accessToken: `access-${label}`,
  refreshToken: `refresh-${label}`,
  expiresAt: "2099-01-01T00:00:00.000Z",
});

describe("saved logins in the native credential store", () => {
  it("keeps each login in its own entry beside a non-secret index and removes only the chosen one", async () => {
    const saved = await memoryProfiles();
    await saved.registry.save(SEBMER, credential("sebmer"));
    await saved.registry.save(AMERGED, credential("amerged"));
    expect(await saved.registry.list()).toEqual([AMERGED, SEBMER]);
    expect([...saved.entries.keys()].sort()).toEqual([
      "profile:user_amerged:01K3AAAAAAAAAAAAAAAAAAAAAA",
      "profile:user_sebmer:01K3BBBBBBBBBBBBBBBBBBBBBB",
    ]);
    // The index is a file that names the logins; no token ever enters it.
    expect(await saved.index()).toContain('"user_id":"user_sebmer"');
    expect(await saved.index()).not.toMatch(/access-|refresh-/u);
    expect(await saved.credential(AMERGED)).toEqual(credential("amerged"));

    // Signing the same account in again replaces its credential and keeps one entry.
    await saved.registry.save(AMERGED, credential("amerged-again"));
    expect(await saved.credential(AMERGED)).toEqual(credential("amerged-again"));
    expect(await saved.registry.list()).toEqual([AMERGED, SEBMER]);

    await saved.registry.remove(SEBMER);
    expect(await saved.registry.list()).toEqual([AMERGED]);
    expect(await saved.credential(SEBMER)).toBeUndefined();
    expect(await saved.credential(AMERGED)).toEqual(credential("amerged-again"));

    // A name already used by another account's login is refused before anything is written.
    saved.writes.length = 0;
    await expect(
      saved.registry.save({ ...SEBMER, name: "amerged" }, credential("sebmer")),
    ).rejects.toEqual(new ProfileNameConflictError(AMERGED));
    expect(saved.writes).toEqual([]);

    // Binding a login without organization replaces it under the same name.
    const open = login("account", "user_new", null);
    await saved.registry.save(open, credential("open"));
    const bound = login("account", "user_new", ORG_B, "Sebmer");
    await saved.registry.save(bound, credential("bound"), open);
    expect(await saved.registry.list()).toEqual([bound, AMERGED]);
    expect(await saved.credential(open)).toBeUndefined();
    expect(await saved.credential(bound)).toEqual(credential("bound"));

    // The single login of clients before named profiles is its own entry, never a listed login.
    const legacy = await memoryProfiles([], credential("legacy"));
    expect(await legacy.registry.list()).toEqual([]);
    expect(await legacy.registry.legacy().read()).toEqual(credential("legacy"));
  });

  it("keeps at most 64 logins per environment and refuses the next one before writing anything", async () => {
    const saved = await memoryProfiles();
    const logins = await fillProfiles(saved.registry, (index) =>
      login(`client-${String(index)}`, `user_client${String(index)}`, ORG_A, "Client GmbH"),
    );
    expect(logins).toHaveLength(64);
    const index = await saved.index();
    saved.writes.length = 0;
    const refused = await saved.registry.save(SEBMER, credential("sebmer")).catch((error) => error);
    expect(refused).toBeInstanceOf(ProfileLimitError);
    expect(refused).toMatchObject({ saved: 64 });
    expect(saved.writes).toEqual([]);
    expect(await saved.index()).toBe(index);
  });

  it("keeps every login when separate processes save and remove at the same moment", async () => {
    // Each child process saves its logins concurrently into the same index, as agents on one
    // computer would; its credential entries stay in its own memory, never a native store.
    const saved = await memoryProfiles([{ profile: SEBMER, credential: credential("sebmer") }]);
    const child = fileURLToPath(new URL("./save-profiles.fixture.mjs", import.meta.url));
    const run = (prefix: string) =>
      promisify(execFile)(process.execPath, [child, saved.directory, prefix, "15"]);
    await Promise.all([
      run("first"),
      run("second"),
      saved.registry.save(AMERGED, credential("amerged")),
      saved.registry.remove(SEBMER),
    ]);
    const names = (await saved.registry.list()).map((profile) => profile.name);
    expect(names).toHaveLength(31);
    for (const prefix of ["first", "second"])
      for (let index = 0; index < 15; index += 1)
        expect(names).toContain(`${prefix}-${String(index)}`);
    expect(names).toContain("amerged");
    expect(names).not.toContain("sebmer");
    // Every change created one complete version; older versions are pruned and no temporary file
    // of a finished change stays behind.
    const files = await readdir(saved.directory);
    expect(files.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(files.length).toBeLessThanOrEqual(2);

    // A writer delayed since its read may find its next number free again, because newer changes
    // already superseded and pruned it. Its file is then not the newest, so it applies its change
    // again on top instead of reporting a success that no reader would see.
    const raced = await memoryProfiles([{ profile: AMERGED, credential: credential("amerged") }]);
    const entry = (name: string) => ({
      name,
      user_id: `user_${name}`,
      organization_id: null,
      organization_name: null,
    });
    const amerged = {
      name: "amerged",
      user_id: "user_amerged",
      organization_id: ORG_A,
      organization_name: "amerged",
    };
    let delayedOnce = false;
    await new ProfileIndexFiles(raced.directory).update((current) => {
      if (!delayedOnce) {
        delayedOnce = true;
        // Meanwhile other processes write versions 2 to 4; the writer of 4 prunes 1 and 2.
        const others = [entry("second"), entry("third"), entry("fourth")];
        for (let version = 2; version <= 4; version += 1)
          writeFileSync(
            join(raced.directory, `index-${String(version)}.json`),
            JSON.stringify({ version: 1, profiles: [amerged, ...others.slice(0, version - 1)] }),
          );
        for (const version of [1, 2])
          unlinkSync(join(raced.directory, `index-${String(version)}.json`));
      }
      return [...current, login("delayed", "user_delayed", null)];
    });
    expect((await raced.registry.list()).map((profile) => profile.name)).toEqual([
      "amerged",
      "delayed",
      "fourth",
      "second",
      "third",
    ]);
  }, 30_000);

  it("ignores what a crashed writer left and refuses a tampered or unwritable index", async () => {
    // A writer that crashed before linking its version left only a temporary file behind.
    const crashed = await memoryProfiles([{ profile: SEBMER, credential: credential("sebmer") }]);
    await writeFile(join(crashed.directory, ".index-crashed.tmp"), '{"version":1,"prof');
    await crashed.registry.save(AMERGED, credential("amerged"));
    expect(await crashed.registry.list()).toEqual([AMERGED, SEBMER]);

    for (const index of [
      "not json",
      JSON.stringify({ version: 2, profiles: [] }),
      JSON.stringify({
        version: 1,
        profiles: [
          { name: "Bad Name", user_id: "u", organization_id: null, organization_name: null },
        ],
      }),
      JSON.stringify({
        version: 1,
        profiles: [{ name: "a", user_id: "u", organization_id: null, organization_name: "Named" }],
      }),
      JSON.stringify({
        version: 1,
        profiles: [
          { name: "a", user_id: "u", organization_id: null, organization_name: null },
          { name: "a", user_id: "v", organization_id: null, organization_name: null },
        ],
      }),
    ]) {
      const tampered = await memoryProfiles();
      await writeFile(join(tampered.directory, "index-1.json"), index);
      await expect(tampered.registry.list()).rejects.toBeInstanceOf(CredentialStoreIntegrityError);
    }

    // An index that cannot be written keeps nothing of a new login, not even its token.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const locked = await memoryProfiles([{ profile: SEBMER, credential: credential("sebmer") }]);
      await chmod(locked.directory, 0o500);
      await expect(locked.registry.save(AMERGED, credential("amerged"))).rejects.toBeInstanceOf(
        CredentialStoreUnavailableError,
      );
      await chmod(locked.directory, 0o700);
      expect(await locked.credential(AMERGED)).toBeUndefined();
      expect(await locked.registry.list()).toEqual([SEBMER]);
    }
  });
});

describe("choosing the login a command runs as", () => {
  const OPEN = login("account", "user_open", null);
  const profiles: readonly LocalProfile[] = [AMERGED, SEBMER, OPEN];

  it("takes a requested login exactly and otherwise uses only an unambiguous match", () => {
    expect(selectProfile(profiles, { name: "sebmer" })).toEqual({
      outcome: "selected",
      profile: SEBMER,
    });
    expect(selectProfile(profiles, { bound: "amerged" })).toEqual({
      outcome: "selected",
      profile: AMERGED,
    });
    expect(selectProfile(profiles, { name: "sebmer", bound: "amerged" })).toEqual({
      outcome: "conflict",
      field: "binding",
      profile: null,
    });
    expect(selectProfile(profiles, { name: "amerged", organizationId: ORG_B })).toEqual({
      outcome: "conflict",
      field: "organization",
      profile: AMERGED,
    });
    expect(selectProfile(profiles, { name: "amerged", userId: "user_sebmer" })).toEqual({
      outcome: "conflict",
      field: "user",
      profile: AMERGED,
    });
    expect(selectProfile(profiles, { name: "missing" })).toEqual({ outcome: "not_found" });
    expect(selectProfile(profiles, { organizationId: ORG_B })).toEqual({
      outcome: "selected",
      profile: SEBMER,
    });
    expect(selectProfile(profiles, { userId: "user_amerged" })).toEqual({
      outcome: "selected",
      profile: AMERGED,
    });
    // No machine-wide default: several logins and no request is a question, not a guess.
    expect(selectProfile(profiles, {})).toEqual({ outcome: "ambiguous", candidates: profiles });
    expect(selectProfile(profiles, { organizationId: "01K3CCCCCCCCCCCCCCCCCCCCCC" })).toEqual({
      outcome: "not_found",
    });
    expect(selectProfile([], {})).toEqual({ outcome: "none" });
    expect(selectProfile([SEBMER], {})).toEqual({ outcome: "selected", profile: SEBMER });

    // `organization use` finds the login in that organization, else the one without organization.
    expect(selectProfileForOrganization(profiles, { organizationId: ORG_A })).toEqual({
      outcome: "selected",
      profile: AMERGED,
    });
    expect(
      selectProfileForOrganization(profiles, { organizationId: "01K3CCCCCCCCCCCCCCCCCCCCCC" }),
    ).toEqual({ outcome: "selected", profile: OPEN });
    expect(
      selectProfileForOrganization([AMERGED, { ...SEBMER, organizationId: ORG_A }], {
        organizationId: ORG_A,
      }),
    ).toEqual({
      outcome: "ambiguous",
      candidates: [AMERGED, { ...SEBMER, organizationId: ORG_A }],
    });
    expect(
      selectProfileForOrganization(profiles, { organizationId: ORG_A, name: "sebmer" }),
    ).toEqual({ outcome: "selected", profile: SEBMER });
    expect(
      selectProfileForOrganization([AMERGED, SEBMER], {
        organizationId: "01K3CCCCCCCCCCCCCCCCCCCCCC",
      }),
    ).toEqual({ outcome: "ambiguous", candidates: [AMERGED, SEBMER] });
    // A requested user is held everywhere: only that user's login is ever bound or chosen.
    const OTHER_OPEN = login("other-open", "user_other", null);
    expect(
      selectProfileForOrganization([OPEN, OTHER_OPEN], {
        organizationId: ORG_B,
        userId: "user_other",
      }),
    ).toEqual({ outcome: "selected", profile: OTHER_OPEN });
    expect(
      selectProfileForOrganization([AMERGED, OPEN], { organizationId: ORG_A, userId: "user_open" }),
    ).toEqual({ outcome: "selected", profile: OPEN });
    expect(
      selectProfileForOrganization([AMERGED], { organizationId: ORG_A, userId: "user_sebmer" }),
    ).toEqual({ outcome: "not_found" });
    expect(
      selectProfileForOrganization(profiles, {
        organizationId: ORG_A,
        name: "sebmer",
        userId: "user_amerged",
      }),
    ).toEqual({ outcome: "conflict", field: "user", profile: SEBMER });
  });

  it("says how to get the right login for every refused choice", () => {
    const prefix = "OHMYHOST_ENVIRONMENT=production ohmyhost";
    const none = profileSelectionError(
      { outcome: "none" },
      { organizationId: ORG_A },
      prefix,
      "cli",
    );
    expect([none.code, none.exitCode, none.suggestedAction]).toEqual([
      "authentication_required",
      5,
      `No login is saved on this computer. Run '${prefix} login --organization ${ORG_A} --json'.`,
    ]);
    const missing = profileSelectionError(
      { outcome: "not_found" },
      { organizationId: ORG_B, userId: "user_sebmer", bound: "sebmer" },
      prefix,
      "cli",
    );
    expect([missing.code, missing.exitCode]).toEqual(["profile_not_found", 5]);
    expect(missing.suggestedAction).toContain(
      `${prefix} login --organization ${ORG_B} --user user_sebmer --profile-name sebmer --json`,
    );
    expect(missing.suggestedAction).toContain(
      "profile sebmer, organization 01K3BBBBBBBBBBBBBBBBBBBBBB, user user_sebmer",
    );
    expect(missing.message).toBe(`profile_not_found: ${missing.suggestedAction}`);
    const empty = profileSelectionError({ outcome: "not_found" }, {}, prefix, "cli");
    expect(empty.suggestedAction).toContain("No saved login matches this request.");
    const ambiguousCli = profileSelectionError(
      { outcome: "ambiguous", candidates: [AMERGED, SEBMER] },
      {},
      prefix,
      "cli",
    );
    expect([ambiguousCli.code, ambiguousCli.exitCode]).toEqual(["profile_selection_required", 2]);
    expect(ambiguousCli.suggestedAction).toContain("amerged, sebmer");
    expect(ambiguousCli.suggestedAction).toContain("--profile-name NAME");
    expect(
      profileSelectionError({ outcome: "ambiguous", candidates: [AMERGED] }, {}, prefix, "mcp")
        .suggestedAction,
    ).toContain("pass profile_name (see profile_list)");
    expect(
      profileSelectionError(
        { outcome: "conflict", field: "binding", profile: null },
        { name: "sebmer", bound: "amerged" },
        prefix,
        "cli",
      ).suggestedAction,
    ).toContain("bound to OHMYHOST_PROFILE=amerged");
    const organization = profileSelectionError(
      { outcome: "conflict", field: "organization", profile: AMERGED },
      { name: "amerged", organizationId: ORG_B },
      prefix,
      "cli",
    );
    expect([organization.code, organization.exitCode]).toEqual(["profile_context_mismatch", 2]);
    expect(organization.suggestedAction).toContain(
      `Profile amerged is signed in to organization ${ORG_A}, but this targets organization ${ORG_B}.`,
    );
    expect(
      profileSelectionError(
        { outcome: "conflict", field: "user", profile: AMERGED },
        { name: "amerged", userId: "user_sebmer" },
        prefix,
        "cli",
      ).suggestedAction,
    ).toContain("belongs to user user_amerged, not user_sebmer");
  });

  it("names a login after its organization without taking another login's name", () => {
    expect(
      defaultProfileName([], {
        userId: "user_new",
        organizationId: ORG_A,
        organizationName: "Sébmer GmbH & Co.",
      }),
    ).toBe("sebmer-gmbh-co");
    expect(defaultProfileName([AMERGED], { ...AMERGED, organizationName: "Renamed" })).toBe(
      "amerged",
    );
    expect(
      defaultProfileName([AMERGED], {
        userId: "user_other",
        organizationId: ORG_B,
        organizationName: "amerged",
      }),
    ).toBe("amerged-bbbbbb");
    expect(
      defaultProfileName([AMERGED, login("amerged-bbbbbb", "user_x", null)], {
        userId: "user_other",
        organizationId: ORG_B,
        organizationName: "amerged",
      }),
    ).toBe("amerged-bbbbbb-2");
    expect(
      defaultProfileName([], { userId: "user_new", organizationId: null, organizationName: null }),
    ).toBe("account");
    expect(
      defaultProfileName([], {
        userId: "user_new",
        organizationId: ORG_A,
        organizationName: "!!!",
      }),
    ).toBe("workspace");
    expect(publicProfile(AMERGED)).toEqual({
      name: "amerged",
      user_id: "user_amerged",
      organization_id: ORG_A,
      organization_name: "amerged",
    });
    expect(describeProfile(AMERGED)).toBe(
      `profile amerged (user user_amerged, organization amerged ${ORG_A})`,
    );
    expect(describeProfile(login("account", "user_open", null))).toBe(
      "profile account (user user_open, no organization)",
    );
    expect(describeProfile({ ...SEBMER, organizationName: null })).toBe(
      `profile sebmer (user user_sebmer, organization ${ORG_B})`,
    );
    expect([isProfileName("amerged-2"), isProfileName("Amerged"), isProfileName("-x")]).toEqual([
      true,
      false,
      false,
    ]);
    expect([isProfileUserId("user_01M2"), isProfileUserId("user:x")]).toEqual([true, false]);
  });
});
