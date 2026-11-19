import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupDisposableRepository } from "../apps/source-fetcher/scripts/managed-git-preflight-cleanup.mjs";

const name = "p39-proof-disposable";
const remote =
  "https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/ohmyhost-development-us/p39-proof-disposable.git";
const notFound = () => Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });

test("uncertain create cleanup observes the exact disposable repository and preserves its failure", async () => {
  const originalFailure = new Error("CREATE_RESPONSE_LOST");
  const calls = [];
  let exists = true;
  const result = await cleanupDisposableRepository(
    {
      created: false,
      creationAttempted: true,
      name,
      remote,
      read: async () => {
        calls.push("read");
        if (!exists) throw notFound();
        return { name, remote };
      },
      remove: async () => {
        calls.push("delete");
        exists = false;
      },
    },
    originalFailure,
  );
  assert.deepEqual(calls, ["read", "delete", "read"]);
  assert.equal(result, originalFailure);

  let deletes = 0;
  assert.equal(
    await cleanupDisposableRepository(
      {
        creationAttempted: true,
        name,
        remote,
        read: async () => {
          throw notFound();
        },
        remove: async () => {
          deletes++;
        },
      },
      originalFailure,
    ),
    originalFailure,
  );
  assert.equal(deletes, 0);
});

test("cleanup refuses unowned or unknown outcomes and never reports unobserved deletion", async () => {
  const originalFailure = new Error("PROOF_FAILED");
  for (const value of [null, { name: "other", remote }, { name, remote: `${remote}-other` }]) {
    let deletes = 0;
    const result = await cleanupDisposableRepository({
      creationAttempted: true,
      name,
      remote,
      read: async () => value,
      remove: async () => {
        deletes++;
      },
    });
    assert.match(result.message, /IDENTITY_MISMATCH/u);
    assert.equal(deletes, 0);
  }
  for (const failAt of ["read", "delete", "readback"]) {
    let reads = 0;
    const cleanupFailure = new Error(`UNKNOWN_${failAt}`);
    const input = {
      creationAttempted: true,
      name,
      remote,
      read: async () => {
        if (failAt === "read" || (failAt === "readback" && reads++ > 0)) throw cleanupFailure;
        return { name, remote };
      },
      remove: async () => {
        if (failAt === "delete") throw cleanupFailure;
      },
    };
    assert.equal(await cleanupDisposableRepository(input, originalFailure), originalFailure);
    reads = 0;
    assert.equal(await cleanupDisposableRepository(input), cleanupFailure);
  }
  const observed = {
    creationAttempted: true,
    name,
    remote,
    read: async () => ({ name, remote }),
    remove: async () => {},
  };
  assert.match((await cleanupDisposableRepository(observed)).message, /DELETE_UNVERIFIED/u);
  let reads = 0;
  assert.equal(
    await cleanupDisposableRepository({
      ...observed,
      read: async () => {
        if (reads++ > 0) throw notFound();
        return { name, remote };
      },
      remove: async () => {
        throw notFound();
      },
    }),
    null,
  );
  assert.equal(
    await cleanupDisposableRepository({
      creationAttempted: false,
      read: async () => assert.fail("No owned creation attempt"),
      remove: async () => assert.fail("No owned creation attempt"),
    }),
    null,
  );
});
