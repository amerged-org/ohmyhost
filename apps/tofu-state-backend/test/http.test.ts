import { expect, it } from "vitest";

import { createTofuHttpWorker } from "../src/http.js";

it("admits only the exact operator credential and state path without forwarding that credential", async () => {
  const password = "s".repeat(43);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password)),
  );
  const passwordSha256 = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const calls: { name: string; authorization: string | null }[] = [];
  const worker = createTofuHttpWorker({
    STATE_ORIGIN: "https://prod-state.omh-installation.example.test",
    STATE_PREFIX: "production/",
    STATE_PASSWORD_SHA256: passwordSha256,
    STATES: {
      getByName(name) {
        return {
          async fetch(request) {
            calls.push({ name, authorization: request.headers.get("authorization") });
            return new Response("state", { status: 200 });
          },
        };
      },
    },
  });
  const url = "https://prod-state.omh-installation.example.test/state/production/aws-build.tfstate";
  const auth = `Basic ${btoa(`tofu:${password}`)}`;
  expect((await worker.fetch(new Request(url))).status).toBe(404);
  expect(
    (await worker.fetch(new Request(url, { headers: { authorization: "Basic invalid" } }))).status,
  ).toBe(404);
  expect(
    (
      await worker.fetch(
        new Request(url.replace(new URL(url).origin, "https://wrong-origin.example.test"), {
          headers: { authorization: auth },
        }),
      )
    ).status,
  ).toBe(404);
  expect(
    (await worker.fetch(new Request(`${url}?extra=1`, { headers: { authorization: auth } })))
      .status,
  ).toBe(404);
  expect(
    (
      await worker.fetch(
        new Request("https://prod-state.omh-installation.example.test/state/../escape.tfstate", {
          headers: { authorization: auth },
        }),
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await worker.fetch(
        new Request(
          "https://prod-state.omh-installation.example.test/state/poc-private-fullstack/aws-build.tfstate",
          {
            headers: { authorization: auth },
          },
        ),
      )
    ).status,
  ).toBe(404);
  expect((await worker.fetch(new Request(url, { headers: { authorization: auth } }))).status).toBe(
    200,
  );
  expect(calls).toEqual([{ name: "production/aws-build.tfstate", authorization: null }]);
});
