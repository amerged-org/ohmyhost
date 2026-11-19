/* global Headers */
import assert from "node:assert/strict";
import test from "node:test";
import { activeNavigation, shouldExpire, wakeScript } from "../idle.mjs";

test("only a user navigation may wake a sleeping preview; HMR traffic cannot", () => {
  assert.equal(
    activeNavigation(
      new Headers({
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        "sec-fetch-site": "none",
      }),
    ),
    true,
  );
  assert.equal(
    activeNavigation(
      new Headers({
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        "sec-fetch-user": "?1",
      }),
    ),
    true,
  );
  assert.equal(
    activeNavigation(
      new Headers({
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        "sec-fetch-site": "same-origin",
      }),
    ),
    false,
  );
  assert.equal(
    activeNavigation(new Headers({ upgrade: "websocket", "sec-fetch-site": "same-origin" })),
    false,
  );
});

test("expiry follows last user action and is independent of pings or open sockets", () => {
  assert.equal(shouldExpire(1_000, 10_000, 10_999), false);
  assert.equal(shouldExpire(1_000, 10_000, 11_000), true);
  assert.match(wakeScript, /isTrusted/);
  assert.match(wakeScript, /pointerdown/);
  assert.match(wakeScript, /visibilitychange/);
});
