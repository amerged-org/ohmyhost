import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { URL, fileURLToPath } from "node:url";

import { CONTROL_CORE_WORKER_PROFILES } from "../scripts/control-core-worker-profile.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const jsonc = (text) =>
  JSON.parse(text.replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1"));
// A sandbox Worker runs in the Development account and binds the Development Core.
const environmentOf = (config) =>
  config.name.endsWith("-poc-private-fullstack") ||
  config.name.endsWith("-sandbox") ||
  config.name === "ohmyho-connection-broker-development" ||
  /^ohmyho-(?:native-auth|project-database)-development-(?:us|eu)$/u.test(config.name)
    ? "development"
    : config.name.endsWith("-production") ||
        /^ohmyho-(?:native-auth|project-database)-production-(?:us|eu)$/u.test(config.name)
      ? "production"
      : null;

test("every consumer binding of the Core names an exported entrypoint of the right environment", async () => {
  const exported = new Set(
    [
      ...(await readFile(join(root, "apps/control-store/src/worker-main.ts"), "utf8")).matchAll(
        /^export class (\w+) extends WorkerEntrypoint/gmu,
      ),
    ].map((match) => match[1]),
  );
  assert.ok(exported.size > 40);
  const wired = new Map();
  for (const app of await readdir(join(root, "apps"))) {
    if (app === "control-store") continue;
    const files = (await readdir(join(root, "apps", app))).filter((name) =>
      /^wrangler(?:\..*)?\.jsonc$/u.test(name),
    );
    for (const file of files) {
      const config = jsonc(await readFile(join(root, "apps", app, file), "utf8"));
      const environment = environmentOf(config);
      if (
        app === "control-api" &&
        [
          "wrangler.jsonc",
          "wrangler.production.jsonc",
          "wrangler.observer.development.jsonc",
          "wrangler.observer.production.jsonc",
        ].includes(file)
      ) {
        const serviceNames = (config.services ?? []).map(({ binding }) => binding);
        for (const binding of ["PREVIEW_API_RUNTIME", "PREVIEW_EXECUTION"])
          assert.equal(
            serviceNames.includes(binding),
            file !== "wrangler.observer.production.jsonc",
            `${file}: ${binding}`,
          );
        for (const binding of ["CONNECTION_CONTROL", "CONNECTION_BROKER"])
          assert.equal(
            serviceNames.includes(binding),
            !file.includes(".observer."),
            `${file}: ${binding}`,
          );
      }
      const bindings = (config.services ?? []).filter((service) =>
        Object.values(CONTROL_CORE_WORKER_PROFILES).includes(service.service),
      );
      if (bindings.length === 0) continue;
      assert.notEqual(
        environment,
        null,
        `${app}/${file} is neither a development nor a production Worker`,
      );
      // Binding the Core is the whole selection: no mode flag and no other database binding remains.
      assert.equal(
        config.vars?.CONTROL_STORAGE_PROVIDER,
        undefined,
        `${app}/${file} keeps a storage provider flag`,
      );
      assert.equal(config.hyperdrive, undefined, `${app}/${file} binds the Core and a Hyperdrive`);
      for (const service of bindings) {
        assert.equal(service.service, CONTROL_CORE_WORKER_PROFILES[environment], `${app}/${file}`);
        assert.ok(
          exported.has(service.entrypoint),
          `${app}/${file}: ${service.entrypoint} is not exported`,
        );
      }
      wired.set(
        `${app}/${file}`,
        bindings.map((service) => `${service.binding}:${service.entrypoint}`).sort(),
      );
    }
  }
  // A development profile and its production twin bind the identical capabilities.
  for (const [key, bindings] of wired) {
    if (!key.includes(".development.") && !key.endsWith("/wrangler.jsonc")) continue;
    const twin = key
      .replace(".development.", ".production.")
      .replace(/\/wrangler\.jsonc$/u, "/wrangler.production.jsonc");
    if (key === "project-database-runtime/wrangler.development.eu.jsonc") {
      assert.deepEqual(bindings, [
        "PROJECT_PREVIEW_AUTHORITY:PreviewDatabaseAuthorityRuntime",
        "QA_CREDIT:GatewayCreditRuntime",
        "QA_DATABASE_AUTHORITY:PreviewQaDatabaseAuthority",
        "QA_DEV_ACCESS:DevAccessRuntime",
      ]);
      assert.deepEqual(wired.get(twin), [
        "PROJECT_PREVIEW_AUTHORITY:PreviewDatabaseAuthorityRuntime",
      ]);
    } else if (key === "control-api/wrangler.observer.development.jsonc") {
      assert.ok(bindings.includes("PREVIEW_API_RUNTIME:ProductApiPreviewRuntime"));
      assert.deepEqual(
        wired.get(twin),
        bindings.filter((binding) => binding !== "PREVIEW_API_RUNTIME:ProductApiPreviewRuntime"),
        `${key} differs from ${twin}`,
      );
    } else if (wired.has(twin))
      assert.deepEqual(wired.get(twin), bindings, `${key} differs from ${twin}`);
  }
  for (const environment of ["development", "production"]) {
    assert.deepEqual(wired.get(`source-fetcher/wrangler.${environment}.jsonc`), [
      "PREVIEW_CONTROL:PreviewSourceRuntime",
    ]);
    assert.deepEqual(wired.get(`project-database-runtime/wrangler.${environment}.us.jsonc`), [
      "PROJECT_PREVIEW_AUTHORITY:PreviewDatabaseAuthorityRuntime",
    ]);
  }
  assert.ok(wired.size >= 30);
});

test("a deployed development profile and its production twin run one compatibility date and flags", async () => {
  // Local-only templates and sandbox or disabled profiles are never deployed twins of a production Worker.
  const template = /-(?:disabled|local|sandbox)$/u;
  let compared = 0;
  for (const app of await readdir(join(root, "apps"))) {
    const production = await readFile(
      join(root, "apps", app, "wrangler.production.jsonc"),
      "utf8",
    ).catch(() => null);
    const development = await readFile(join(root, "apps", app, "wrangler.jsonc"), "utf8").catch(
      () => null,
    );
    if (production === null || development === null) continue;
    const developmentConfig = jsonc(development);
    if (template.test(developmentConfig.name)) continue;
    const productionConfig = jsonc(production);
    assert.equal(
      developmentConfig.compatibility_date,
      productionConfig.compatibility_date,
      `${app}: the development and production compatibility dates differ`,
    );
    assert.deepEqual(
      developmentConfig.compatibility_flags ?? [],
      productionConfig.compatibility_flags ?? [],
      `${app}: the development and production compatibility flags differ`,
    );
    compared += 1;
  }
  assert.ok(compared >= 10);
});
