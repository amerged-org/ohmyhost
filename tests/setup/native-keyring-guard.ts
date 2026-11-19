import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vi } from "vitest";

// A test run must never read or write the operator's real OS credential store: saved logins there
// belong to real accounts (on 2026-09-24 a test run removed a production login). A test that
// exercises the native adapter mocks "@napi-rs/keyring" itself; every other use fails as an
// unavailable store instead of reaching the Keychain.
function blockedNativeKeyring() {
  const refuse = (): never => {
    throw new Error("Tests must not use the real native credential store");
  };
  // Plain functions stay constructible, so `new AsyncEntry(...)` reaches the refusal.
  return {
    AsyncEntry: function AsyncEntry(): never {
      return refuse();
    },
    Entry: function Entry(): never {
      return refuse();
    },
    findCredentials: refuse,
    findCredentialsAsync: refuse,
  };
}

// The repository root does not install the package, so a bare "@napi-rs/keyring" mock registered
// here never matches the file product code loads. Mock the exact file the product CLI resolves.
vi.doMock(
  createRequire(new URL("../../apps/product-cli/package.json", import.meta.url)).resolve(
    "@napi-rs/keyring",
  ),
  blockedNativeKeyring,
);
vi.doMock("@napi-rs/keyring", blockedNativeKeyring);

// Saved logins are listed in files below the home directory. Product code under test sees its own
// temporary home instead, so a test run never reads or changes the operator's list of logins.
let temporaryHome: string | undefined;
const homedir = (): string =>
  (temporaryHome ??= mkdtempSync(join(tmpdir(), "ohmyhost-test-home-")));
async function withTemporaryHome(importOriginal: () => Promise<typeof import("node:os")>) {
  const actual = await importOriginal();
  return { ...actual, homedir, default: { ...actual, homedir } };
}
vi.doMock("node:os", withTemporaryHome);
vi.doMock("os", withTemporaryHome);
