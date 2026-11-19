import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  CredentialStoreUnavailableError,
  NativeNapiKeyringCredentialStore,
} from "../apps/product-cli/src/credential-store.js";
import { profileIndexDirectory } from "../apps/product-cli/src/profile-store.js";

// Regression for 2026-09-24: product CLI tests that did not inject their credential store reached
// the operator's real Keychain and removed a production login. The Vitest setup replaces the
// native module in every test file. The repository root does not install "@napi-rs/keyring", so a
// mock of the bare name alone never matches the file product code loads; this proof checks both
// module identities first. It names only a random service no client uses, constructing an entry
// does no I/O, and a failed assertion ends the test before the product store reads anything.
const SERVICE = `ohmyhost-guard-proof-${randomUUID()}`;
const REFUSAL = "Tests must not use the real native credential store";
const NATIVE_KEYRING = "@napi-rs/keyring";

/** The part of the native module this proof calls; the root does not install its types. */
interface NativeKeyringModule {
  readonly AsyncEntry: new (service: string, account: string) => unknown;
  readonly Entry: new (service: string, account: string) => unknown;
  readonly findCredentials: (service: string) => unknown;
}

it("replaces the native keyring module product code loads, so no test reaches a real store", async () => {
  const bare = (await import(NATIVE_KEYRING)) as NativeKeyringModule;
  expect(() => new bare.AsyncEntry(SERVICE, "probe")).toThrow(REFUSAL);
  const loadedByProductCode = (await import(
    createRequire(new URL("../apps/product-cli/package.json", import.meta.url)).resolve(
      NATIVE_KEYRING,
    )
  )) as NativeKeyringModule;
  expect(() => new loadedByProductCode.AsyncEntry(SERVICE, "probe")).toThrow(REFUSAL);
  expect(() => new loadedByProductCode.Entry(SERVICE, "probe")).toThrow(REFUSAL);
  expect(() => loadedByProductCode.findCredentials(SERVICE)).toThrow(REFUSAL);

  await expect(
    new NativeNapiKeyringCredentialStore(undefined, SERVICE).read(),
  ).rejects.toBeInstanceOf(CredentialStoreUnavailableError);
});

it("gives product code a temporary home, so no test reads or changes the saved-login list", () => {
  // The list of saved logins lives below the home directory; the real one belongs to the operator.
  const directory = profileIndexDirectory("ohmyhost.production");
  expect(directory.startsWith(join(tmpdir(), "ohmyhost-test-home-"))).toBe(true);
  expect(directory).not.toBe(
    join(process.env["HOME"] ?? "", ".ohmyhost", "profiles", "ohmyhost.production"),
  );
});
