/* global Buffer, Headers, Request, Response, TextEncoder, setTimeout */
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, URL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { build } from "esbuild";
import { createFunctionsFrameworkAdapter } from "../packages/adapter-functions/dist/index.js";
import { parseOhmyhostConfigYaml } from "../packages/contracts/dist/index.js";

const run = promisify(execFile);
test("prepared native canary bundles the public SDK and guards the server route", async () => {
  const temp = await mkdtemp(join(tmpdir(), "native-canary-test-"));
  const app = join(temp, "app");
  try {
    await run("node", ["fixtures/native-auth-canary/prepare.mjs", app, "--google"], {
      cwd: resolve("."),
      timeout: 120000,
    });
    const manifest = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
    const config = parseOhmyhostConfigYaml(await readFile(join(app, "ohmyhost.yaml"), "utf8"));
    const adapter = createFunctionsFrameworkAdapter({ loadPackageJson: async () => manifest });
    const application = {
      root: config.applicationRoot,
      files: [
        "ohmyhost.yaml",
        "package.json",
        "pnpm-lock.yaml",
        "src/ohmyhost/worker.ts",
        "src/browser.ts",
        "src/browser-bundle.ts",
        "vendor/customer-runtime.tgz",
      ],
    };
    const plan = await adapter.plan({
      repositoryConfig: config,
      repositoryConfigEvidence: {
        scope: "repository",
        path: "ohmyhost.yaml",
        reason: "authoritative repository configuration",
      },
      application,
      detection: await adapter.detect(application),
    });
    assert.equal(plan.adapter, "functions");
    assert.equal(plan.installCommand, "pnpm install --frozen-lockfile --ignore-scripts");
    assert.equal(plan.auth.provider, "omh-native");
    const bundled = await build({
      entryPoints: [join(app, "src/ohmyhost/worker.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      logLevel: "silent",
    });
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
    );
    const worker = module.default;
    const anonymous = { OHMYHOST_AUTH: { validateSession: async () => null } };
    const active = {
      OHMYHOST_AUTH: {
        validateSession: async ({ cookie }) => {
          assert.equal(cookie, "session=sentinel");
          return {
            user: { id: "id-1", email: "test@example.test", private: "hidden" },
            session: { id: "session-id", expiresAt: "2030-01-01T00:00:00Z" },
          };
        },
      },
    };
    assert.equal(
      (await worker.fetch(new Request("https://example.test/health"), anonymous)).status,
      200,
    );
    for (const path of ["/login", "/reset-password", "/accept-invitation"]) {
      const mailPage = await worker.fetch(
        new Request(`https://example.test${path}?token=secret`),
        anonymous,
      );
      assert.equal(mailPage.status, 200);
      assert.equal(mailPage.headers.get("cache-control"), "no-store");
      assert.equal(mailPage.headers.get("referrer-policy"), "no-referrer");
      assert.doesNotMatch(await mailPage.text(), /secret/);
    }
    const page = await worker.fetch(new Request("https://example.test/"), anonymous);
    assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
    const html = await page.text();
    assert.match(html, /Google sign in/);
    assert.doesNotMatch(html, /GitHub sign in/);
    const denied = await worker.fetch(
      new Request("https://example.test/protected", { headers: { "x-user-id": "forged" } }),
      anonymous,
    );
    assert.equal(denied.status, 401);
    const accepted = await worker.fetch(
      new Request("https://example.test/protected", { headers: { cookie: "session=sentinel" } }),
      active,
    );
    assert.deepEqual(await accepted.json(), { id: "id-1", email: "test@example.test" });
    assert.equal(
      (await worker.fetch(new Request("https://example.test/unknown"), anonymous)).status,
      404,
    );
    const browser = await worker.fetch(new Request("https://example.test/canary.js"), anonymous);
    const script = await browser.text();
    assert.match(script, /\/api\/auth\/v1/);
    const dom = new JSDOM(html, {
      url: "https://example.test/accept-invitation?token=mail-secret",
      runScripts: "outside-only",
    });
    const window = dom.window;
    const withoutScript = window.document.querySelector("form");
    assert.ok(withoutScript);
    assert.equal(withoutScript.method, "post");
    const fallbackAction = new URL(withoutScript.action);
    assert.equal(fallbackAction.origin, "https://example.test");
    assert.equal(fallbackAction.pathname, "/");
    assert.equal(fallbackAction.search, "");
    Object.defineProperty(window.crypto, "subtle", { value: webcrypto.subtle });
    window.TextEncoder = TextEncoder;
    window.Headers = Headers;
    window.Request = Request;
    window.Response = Response;
    const calls = [];
    window.fetch = async (url, init) => {
      calls.push({ url: String(url), key: new Headers(init.headers).get("idempotency-key") });
      return Response.json({ message: "unavailable" }, { status: 503 });
    };
    window.eval(script);
    assert.equal(window.document.querySelector('[name="token"]').value, "mail-secret");
    assert.equal(window.document.querySelector('[name="token"]').type, "password");
    assert.equal(window.location.search, "");
    const form = window.document.querySelector("form");
    const button = window.document.querySelector('[value="signup"]');
    const submit = async (email) => {
      form.elements.namedItem("email").value = email;
      form.elements.namedItem("name").value = "Canary";
      form.elements.namedItem("password").value = "private-password";
      form.requestSubmit(button);
      const count = calls.length;
      for (let i = 0; i < 100 && calls.length === count; i++)
        await new Promise((done) => setTimeout(done, 10));
      assert.ok(calls.length > count);
      // Let the response settle before submitting again.
      await new Promise((done) => setTimeout(done, 10));
    };
    await submit("one@example.test");
    await submit("one@example.test");
    await submit("two@example.test");
    assert.ok(calls[0].key);
    assert.equal(calls[0].key, calls[1].key);
    assert.notEqual(calls[0].key, calls[2].key);
    for (const action of ["invite", "recovery"]) {
      const actionButton = window.document.querySelector(`[value="${action}"]`);
      const first = calls.length;
      for (let i = 0; i < 2; i++) {
        form.elements.namedItem("token").value = "invitation-secret";
        form.elements.namedItem("password").value = "private-password";
        form.requestSubmit(actionButton);
        for (let n = 0; n < 100 && calls.length <= first + i; n++)
          await new Promise((done) => setTimeout(done, 10));
        assert.ok(calls.length > first + i);
        await new Promise((done) => setTimeout(done, 10));
      }
      assert.ok(calls[first].key);
      assert.equal(calls[first].key, calls[first + 1].key);
    }
    assert.doesNotMatch(
      window.document.querySelector("#result").textContent,
      /private-password|mail-secret/,
    );
    dom.window.close();
    assert.match(await readFile(join(app, "pnpm-lock.yaml"), "utf8"), /customer-runtime\.tgz/);
    assert.ok(
      (
        await import(
          pathToFileURL(join(app, "node_modules/@ohmyhost/customer-runtime/dist/auth-browser.js"))
        )
      ).createNativeAuthBrowser,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
