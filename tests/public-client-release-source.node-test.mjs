import assert from "node:assert/strict";
import test from "node:test";
import { verifiedReleaseSource } from "../scripts/prepare-public-client-release.mjs";

const SHA = "a".repeat(40);

test("a public client release is bound to the CI run that verified its exact source commit", async () => {
  const runs = (conclusion) => async () =>
    JSON.stringify([{ databaseId: 4242, headSha: SHA, status: "completed", conclusion }]);
  assert.deepEqual(await verifiedReleaseSource({ sha: SHA, run: runs("success") }), {
    source_repository: "amerged-org/ohmyhost",
    source_commit: SHA,
    ci_run_id: 4242,
  });
  await assert.rejects(
    verifiedReleaseSource({ sha: SHA, run: runs("failure") }),
    /ended as failure/u,
  );
});
