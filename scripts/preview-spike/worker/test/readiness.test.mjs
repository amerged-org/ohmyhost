/* global setTimeout, Response */
import assert from "node:assert/strict";
import test from "node:test";
import { waitForReady } from "../readiness.mjs";

test("an indefinitely hanging port request is aborted and no new probe runs after deadline", async () => {
  let calls = 0;
  let aborted = 0;
  await assert.rejects(
    waitForReady(
      (request) => {
        calls++;
        return new Promise(() => {
          request.signal.addEventListener(
            "abort",
            () => {
              aborted++;
            },
            { once: true },
          );
        });
      },
      "http://fixture/",
      { timeoutMs: 30, perRequestMs: 50, pollMs: 5 },
    ),
    /server_not_ready/,
  );
  assert.equal(calls, 1);
  assert.equal(aborted, 1);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(calls, 1);
});

test("a slow first-page compile may finish within the full readiness deadline", async () => {
  let calls = 0;
  await waitForReady(
    async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return new Response("ready");
    },
    "http://fixture/",
    { timeoutMs: 200, pollMs: 5 },
  );
  assert.equal(calls, 1);
});
