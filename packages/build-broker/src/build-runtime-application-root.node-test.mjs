import assert from "node:assert/strict";
import { test } from "node:test";

import { APPLICATION_ROOT_CONFORMANCE_CORPUS } from "@ohmyhost/contracts/application-root";
import { validateApplicationRoot } from "../../../apps/build-runner/sandbox/build-runtime.mjs";

test("the build sandbox runtime consumes the canonical application-root conformance corpus", () => {
  for (const { value } of APPLICATION_ROOT_CONFORMANCE_CORPUS.accepted) {
    assert.equal(validateApplicationRoot(value), value);
  }
  for (const { value } of APPLICATION_ROOT_CONFORMANCE_CORPUS.rejected) {
    assert.throws(() => validateApplicationRoot(value), /application root is invalid/u);
  }
  assert.equal(APPLICATION_ROOT_CONFORMANCE_CORPUS.ustarEnvelope[0].fitsWithoutPax, true);
});
