import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CurrentCredential, StoredCredential } from "../src/credential-store.js";
import {
  NativeKeyringProfileRegistry,
  ProfileLimitError,
  type LocalProfile,
  type ProfileRegistry,
} from "../src/profile-store.js";

/**
 * The native profile registry over an in-memory keyring with the same accounts and a fresh index
 * directory: tests read and write saved logins exactly as a customer's computer would, without
 * touching a real keychain or the operator's home directory.
 */
export const memoryProfiles = async (
  logins: readonly {
    readonly profile: LocalProfile;
    readonly credential: CurrentCredential;
  }[] = [],
  legacy?: StoredCredential,
) => {
  const entries = new Map<string, string>();
  const writes: string[] = [];
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-profiles-"));
  const registry = new NativeKeyringProfileRegistry(
    async (account) => ({
      setPassword: async (password: string) => {
        writes.push(account);
        entries.set(account, password);
      },
      getPassword: async () => entries.get(account),
      deleteCredential: async () => entries.delete(account),
    }),
    "ohmyhost",
    directory,
  );
  for (const login of logins) await registry.save(login.profile, login.credential);
  if (legacy !== undefined) entries.set("credential", JSON.stringify(legacy));
  writes.length = 0;
  return {
    registry,
    entries,
    writes,
    /** Where the non-secret index of these logins lives. */
    directory,
    /** The newest index file as written, or undefined before the first login. */
    index: async (): Promise<string | undefined> => {
      const newest = (await readdir(directory))
        .map((name) => Number(/^index-(\d+)\.json$/u.exec(name)?.[1] ?? 0))
        .reduce((left, right) => Math.max(left, right), 0);
      return newest === 0
        ? undefined
        : await readFile(join(directory, `index-${String(newest)}.json`), "utf8");
    },
    /** The stored credential of one saved login, read back from its own entry. */
    credential: async (profile: LocalProfile) => await registry.credential(profile).read(),
  };
};

/** Saves `make(0)`, `make(1)`, … until the environment keeps no more; returns the saved logins. */
export const fillProfiles = async (
  registry: ProfileRegistry,
  make: (index: number) => LocalProfile,
): Promise<LocalProfile[]> => {
  const saved: LocalProfile[] = [];
  for (;;) {
    const next = make(saved.length);
    try {
      await registry.save(next, {
        accessToken: `access-${next.name}`,
        refreshToken: `refresh-${next.name}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    } catch (error) {
      if (error instanceof ProfileLimitError) return saved;
      throw error;
    }
    saved.push(next);
  }
};

/** A saved login fixture; the organization name defaults to the organization's alias. */
export const login = (
  name: string,
  userId: string,
  organizationId: string | null,
  organizationName: string | null = organizationId === null ? null : name,
): LocalProfile => ({ name, userId, organizationId, organizationName });
