import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { expect, it } from "vitest";
import { prepareUserTokenFile, preparePrivateSecretFile } from "../src/user-token-file.js";

it("reserves a new private signing-secret file before activation and refuses replacement or links", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-private-secret-"));
  try {
    const path = join(directory, "webhook.secret"),
      secret = "whsec_test_only_fixture";
    const file = await preparePrivateSecretFile(path);
    try {
      await file.save(secret);
      expect(await readFile(path, "utf8")).toBe(secret);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(file.save(secret)).rejects.toMatchObject({ code: "private_output_invalid" });
    } finally {
      await file.close();
    }
    await expect(preparePrivateSecretFile(path)).rejects.toMatchObject({
      code: "private_output_invalid",
    });
    const linked = join(directory, "linked.secret");
    await symlink(path, linked);
    await expect(preparePrivateSecretFile(linked)).rejects.toMatchObject({
      code: "private_output_invalid",
    });
    expect(await readFile(path, "utf8")).toBe(secret);
    const repository = join(directory, "repo");
    await mkdir(repository);
    await promisify(execFile)("git", ["init", "--initial-branch=main", repository]);
    const ignore = join(directory, "empty-ignore");
    await writeFile(ignore, "");
    await promisify(execFile)("git", ["-C", repository, "config", "core.excludesFile", ignore]);
    await expect(preparePrivateSecretFile(join(repository, "secret.txt"))).rejects.toMatchObject({
      code: "private_output_invalid",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("saves only the new token into a private env file, preserves other values and rejects replacement, links and concurrent edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-user-token-"));
  const path = join(directory, ".env.local");
  const original = '# Keep this comment\nAPP_SECRET="local fixture"\nMULTILINE="first\nsecond"\n';
  const value = `sk_${"k".repeat(46)}`;
  const result = {
    request_id: "00000000000000000000000001",
    replayed: false,
    value,
    key: {
      id: "api_key_test",
      organization_id: "00000000000000000000000002",
      name: "Agent",
      obfuscated_value: "sk_…kkkk",
      permissions: ["projects:read"],
      created_at: "2026-09-09T00:00:00.000Z",
      expires_at: "2026-12-08T00:00:00.000Z",
      last_used_at: null,
    },
  };
  try {
    await writeFile(path, original, { mode: 0o644 });
    const prepared = await prepareUserTokenFile(path);
    try {
      const stored = await prepared.save(result);
      expect(stored).toEqual({ request_id: result.request_id, key: result.key, token_file: path });
      expect(JSON.stringify(stored)).not.toContain(value);
      expect(JSON.stringify(stored)).not.toContain("local fixture");
    } finally {
      await prepared.close();
    }
    const contents = await readFile(path, "utf8");
    expect(contents.startsWith(original)).toBe(true);
    expect(parseEnv(contents)).toEqual({
      APP_SECRET: "local fixture",
      MULTILINE: "first\nsecond",
      OHMYHOST_TOKEN: value,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(prepareUserTokenFile(path)).rejects.toMatchObject({
      code: "token_file_has_token",
    });
    expect(await readFile(path, "utf8")).toBe(contents);
    await symlink(path, join(directory, "linked.env"));
    await expect(prepareUserTokenFile(join(directory, "linked.env"))).rejects.toMatchObject({
      code: "token_file_unsafe",
      message:
        "Choose an env file whose name starts or ends with .env, for example .env.local: a regular file you own, not a symlink or hard link, at most 64 KiB.",
    });
    await link(path, join(directory, "hard.env"));
    await expect(prepareUserTokenFile(join(directory, "hard.env"))).rejects.toMatchObject({
      code: "token_file_unsafe",
    });
    const empty = await prepareUserTokenFile(join(directory, "new.env"));
    try {
      await expect(empty.save({ ...result, value: null, replayed: true })).rejects.toMatchObject({
        code: "token_value_unavailable",
        keyId: "api_key_test",
        message:
          "A key was already issued for this idempotency key, and its value is shown only once. Use the file it was saved to, or revoke key api_key_test (ohmyhost token revoke, MCP token_revoke) and create a replacement with a new idempotency key.",
      });
    } finally {
      await empty.close();
    }
    const changedPath = join(directory, "changed.env"),
      changed = await prepareUserTokenFile(changedPath);
    try {
      await writeFile(changedPath, "OTHER=preserve\n");
      // The key was issued before the file changed, so every such answer names it for revocation.
      await expect(changed.save(result)).rejects.toMatchObject({
        code: "token_file_changed",
        keyId: "api_key_test",
        message:
          "The env file changed while the token was being saved, so its value may not be in the file; key api_key_test was issued. Revoke it with 'ohmyhost token revoke --organization ULID --key api_key_test --yes --json' (MCP token_revoke), then create a new one with a new idempotency key.",
      });
      expect(await readFile(changedPath, "utf8")).toBe("OTHER=preserve\n");
    } finally {
      await changed.close();
    }
    const removedPath = join(directory, "removed.env"),
      removed = await prepareUserTokenFile(removedPath);
    try {
      await rm(removedPath);
      await expect(removed.save(result)).rejects.toMatchObject({
        code: "token_file_changed",
        keyId: "api_key_test",
        message: expect.stringContaining("--key api_key_test --yes --json"),
      });
    } finally {
      await removed.close();
    }
    const repository = join(directory, "git-repository");
    await mkdir(repository);
    await promisify(execFile)("git", ["init", "--initial-branch=main", repository]);
    const ignore = join(directory, "empty-ignore");
    await writeFile(ignore, "");
    await promisify(execFile)("git", ["-C", repository, "config", "core.excludesFile", ignore]);
    const unignored = await prepareUserTokenFile(join(repository, ".env.local")).catch(
      (error: unknown) => error,
    );
    if (
      unignored &&
      typeof unignored === "object" &&
      "close" in unignored &&
      typeof unignored.close === "function"
    )
      await unignored.close();
    expect(unignored).toMatchObject({ code: "token_file_not_ignored" });
    await writeFile(join(repository, ".gitignore"), ".env.local\n");
    const ignored = await prepareUserTokenFile(join(repository, ".env.local"));
    await ignored.close();
    await expect(prepareUserTokenFile(join(directory, "source.ts"))).rejects.toMatchObject({
      code: "token_file_unsafe",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
