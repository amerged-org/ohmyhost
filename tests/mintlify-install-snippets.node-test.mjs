import assert from "node:assert/strict";
import { test } from "node:test";
import { installSdkSnippet } from "../scripts/mintlify-install-snippets.mjs";

test("the SDK install snippet names the npm package of the release, never a website archive", () => {
  const snippet = installSdkSnippet("0.1.57");
  assert.match(snippet, /^\n```sh\nnpm install @amerged\/ohmyhost-sdk@0\.1\.57\n```\n$/u);
  assert.doesNotMatch(snippet, /https:\/\/ohmyho\.st\/releases\//u);
});
