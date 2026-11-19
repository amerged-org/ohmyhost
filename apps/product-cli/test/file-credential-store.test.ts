import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CredentialStoreUnavailableError } from "../src/credential-store.js";
import { OwnerOnlyFileCredentialStore } from "../src/file-credential-store.js";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe.skipIf(process.platform === "win32")("explicit owner-only file credential store", () => {
  it("atomically writes owner-only credentials and clears them", async () => {
    const directory = await temporaryDirectory();
    const store = new OwnerOnlyFileCredentialStore(directory, ownerId());

    await store.replace({
      accessToken: "access-a",
      refreshToken: "refresh-a",
      expiresAt: "2026-08-18T01:00:00.000Z",
    });

    await expect(store.read()).resolves.toEqual({
      accessToken: "access-a",
      refreshToken: "refresh-a",
      expiresAt: "2026-08-18T01:00:00.000Z",
    });
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(directory, "credentials.json"))).mode & 0o777).toBe(0o600);
    await store.clear();
    await expect(store.read()).resolves.toBeUndefined();
  });

  it("rejects symlinks and permissive owner modes", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "target");
    const store = new OwnerOnlyFileCredentialStore(directory, ownerId());
    await mkdir(directory, { mode: 0o700 });
    await symlink(target, join(directory, "credentials.json"));

    await expect(store.read()).rejects.toEqual(new CredentialStoreUnavailableError());

    await writeFile(target, "preserve-target", { mode: 0o600 });
    await expect(
      store.replace({
        accessToken: "replacement-access",
        refreshToken: "replacement-refresh",
        expiresAt: "2026-08-18T01:00:00.000Z",
      }),
    ).rejects.toEqual(new CredentialStoreUnavailableError());
    expect(await readFile(target, "utf8")).toBe("preserve-target");
    expect((await lstat(join(directory, "credentials.json"))).isSymbolicLink()).toBe(true);
    await expect(lstat(join(directory, ".credentials.next"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await rm(join(directory, "credentials.json"));
    await chmod(directory, 0o755);
    await expect(store.read()).rejects.toEqual(new CredentialStoreUnavailableError());
  });

  it("removes the one discoverable uncommitted slot after a crash", async () => {
    const directory = await temporaryDirectory();
    await mkdir(directory, { mode: 0o700 });
    const temporaryPath = join(directory, ".credentials.next");
    await writeFile(temporaryPath, "uncommitted-token", { mode: 0o600 });
    const store = new OwnerOnlyFileCredentialStore(directory, ownerId());

    await expect(store.read()).resolves.toBeUndefined();
    await expect(lstat(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("logout removes both active and temporary artifacts even when the active path is corrupt", async () => {
    const directory = await temporaryDirectory();
    await mkdir(directory, { mode: 0o700 });
    const credentialPath = join(directory, "credentials.json");
    const temporaryPath = join(directory, ".credentials.next");
    await symlink(join(directory, "missing-target"), credentialPath);
    await writeFile(temporaryPath, "uncommitted-token", { mode: 0o600 });
    const store = new OwnerOnlyFileCredentialStore(directory, ownerId());

    await expect(store.clear()).resolves.toBeUndefined();
    await expect(lstat(credentialPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(temporaryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

const temporaryDirectory = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-product-cli-"));
  temporaryDirectories.push(root);
  const directory = join(root, "credentials");
  return directory;
};

const ownerId = (): number => {
  const value = process.getuid?.();
  if (value === undefined) throw new Error("POSIX owner ID is unavailable");
  return value;
};
