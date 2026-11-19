/* global Buffer, Response */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { afterEach, test } from "node:test";

import {
  decidePublishAction,
  publishNpmClients,
  readPublishToken,
  verifyRegistryRecord,
} from "../scripts/publish-npm-clients.mjs";

const TOKEN = "test-publish-token-not-a-secret";
const SOURCE = "e3068bd04a2f752770f0f29a88f902b97e4b451c";
const NAMES = ["cli", "mcp", "sdk", "runtime", "auth"].map((x) => `@amerged/ohmyhost-${x}`);
const roots = [];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const integrityOf = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const tarballOf = (name) => `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-0.1.22.tgz`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function prepared() {
  const directory = await mkdtemp(join(tmpdir(), "ohmyhost-npm-publish-test-"));
  roots.push(directory);
  const packages = [];
  for (const name of NAMES) {
    const file = `amerged-${name.split("/")[1]}-0.1.22.tgz`;
    const bytes = Buffer.from(`archive of ${name}`);
    await writeFile(join(directory, file), bytes);
    packages.push({
      name,
      version: "0.1.22",
      file,
      sha256: sha256(bytes),
      integrity: integrityOf(bytes),
    });
  }
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({ version: "0.1.22", sourceCommit: SOURCE, packages }),
  );
  return { directory, packages };
}

function registry(packages, { published = new Set() } = {}) {
  const byName = new Map(packages.map((record) => [record.name, record]));
  return async (url) => {
    const href = String(url);
    for (const record of packages) {
      if (href === `https://registry.npmjs.org/${record.name.replace("/", "%2F")}/0.1.22`)
        return published.has(record.name)
          ? Response.json({
              name: record.name,
              version: "0.1.22",
              license: "Apache-2.0",
              dist: { integrity: record.integrity, tarball: tarballOf(record.name) },
            })
          : new Response("", { status: 404 });
      if (href === tarballOf(record.name))
        return new Response(Buffer.from(`archive of ${byName.get(record.name).name}`));
    }
    return new Response("", { status: 404 });
  };
}

test("npm publication acts only on a definite registry answer and accepts only the prepared bytes", () => {
  assert.equal(decidePublishAction(404), "publish");
  assert.equal(decidePublishAction(404, { submitted: true }), "wait");
  assert.equal(decidePublishAction(200), "verify");
  assert.equal(decidePublishAction(200, { submitted: true }), "verify");
  assert.throws(
    () => decidePublishAction(500),
    /Registry answered 500; publish only after a definite 404/u,
  );
  assert.throws(() => decidePublishAction(403), /Registry answered 403/u);

  const record = { name: "@amerged/ohmyhost-mcp", version: "0.1.22", integrity: "sha512-x" };
  const metadata = {
    name: record.name,
    version: "0.1.22",
    license: "Apache-2.0",
    dist: { integrity: "sha512-x", tarball: tarballOf(record.name) },
  };
  assert.equal(verifyRegistryRecord(metadata, record), tarballOf(record.name));
  for (const [field, changed] of [
    ["integrity", { ...metadata, dist: { ...metadata.dist, integrity: "sha512-y" } }],
    ["name", { ...metadata, name: "@amerged/other" }],
    ["version", { ...metadata, version: "0.1.21" }],
    ["license", { ...metadata, license: "MIT" }],
    [
      "tarball",
      { ...metadata, dist: { ...metadata.dist, tarball: "http://registry.npmjs.org/x.tgz" } },
    ],
    ["tarball", { ...metadata, dist: { ...metadata.dist, tarball: "https://example.com/x.tgz" } }],
  ])
    assert.throws(
      () => verifyRegistryRecord(changed, record),
      new RegExp(`\\(${field}\\); a published version is never overwritten`, "u"),
    );

  assert.equal(readPublishToken(`OTHER=1\nNPM_PUBLISH_TOKEN=${TOKEN}\n`), TOKEN);
  assert.throws(() => readPublishToken("OTHER=1\n"), /NPM_PUBLISH_TOKEN is missing/u);
  assert.throws(() => readPublishToken('NPM_PUBLISH_TOKEN="a b"\n'), /single printable line/u);
});

test("npm publication runs from the green source commit with a token that never reaches an argument or the disk", async () => {
  const { directory, packages } = await prepared();
  const published = new Set(["@amerged/ohmyhost-runtime", "@amerged/ohmyhost-auth"]);
  const calls = [];
  let privateDirectory = null;
  const inherited = { npm_config_registry: "https://example.invalid/", NODE_AUTH_TOKEN: "other" };
  const saved = Object.fromEntries(Object.keys(inherited).map((key) => [key, process.env[key]]));
  Object.assign(process.env, inherited);
  const result = await publishNpmClients({
    directory,
    token: TOKEN,
    fetch: registry(packages, { published }),
    verifyCommit: async (sha) => {
      calls.push(["verify", sha]);
      return 4242;
    },
    run: async (command, args, { cwd, env }) => {
      calls.push([command, ...args]);
      privateDirectory = cwd;
      const npmrc = await readFile(env.NPM_CONFIG_USERCONFIG, "utf8");
      assert.equal((await stat(env.NPM_CONFIG_USERCONFIG)).mode & 0o777, 0o600);
      assert.ok(npmrc.includes("${NPM_PUBLISH_TOKEN}"));
      assert.equal(npmrc.includes(TOKEN), false);
      assert.equal(env.NPM_PUBLISH_TOKEN, TOKEN);
      assert.deepEqual(
        Object.keys(env).filter((key) => /^npm_config_/iu.test(key)),
        ["NPM_CONFIG_USERCONFIG"],
      );
      assert.equal(env.NODE_AUTH_TOKEN, undefined);
      assert.equal(args.join(" ").includes(TOKEN), false);
      assert.notEqual(resolve(cwd), resolve(import.meta.dirname, ".."));
      if (args[0] === "whoami") return "amerged\n";
      published.add(packages.find((record) => args[1].endsWith(record.file)).name);
      return "";
    },
    wait: async () => {},
    now: () => new Date("2026-09-26T12:00:00.000Z"),
  }).finally(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
  });

  assert.deepEqual(calls[0], ["verify", SOURCE]);
  assert.deepEqual(
    calls.slice(1).map((call) => call.slice(0, 2).join(" ")),
    ["npm whoami", `npm publish`, `npm publish`, `npm publish`],
  );
  for (const [index, record] of packages.slice(0, 3).entries())
    assert.deepEqual(calls[index + 2], [
      "npm",
      "publish",
      join(directory, record.file),
      "--access",
      "public",
      "--ignore-scripts",
      "--registry",
      "https://registry.npmjs.org/",
    ]);
  assert.deepEqual(result, {
    version: "0.1.22",
    sourceCommit: SOURCE,
    ciRun: 4242,
    verified: [...NAMES].sort(),
    pending: [],
  });
  assert.deepEqual(JSON.parse(await readFile(join(directory, "published.json"), "utf8")), {
    version: "0.1.22",
    sourceCommit: SOURCE,
    ciRun: 4242,
    packages: [...packages]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((record) => ({
        name: record.name,
        version: "0.1.22",
        state: "verified",
        integrity: record.integrity,
        sha256: record.sha256,
        tarball: tarballOf(record.name),
        observedAt: "2026-09-26T12:00:00.000Z",
      })),
  });
  assert.equal(existsSync(privateDirectory), false, "the private npm configuration is removed");
});

test("npm publication refuses changed archives, a red commit and a wrong account, and waits out registry propagation", async () => {
  const noRun = async () => assert.fail("npm must not run");
  const tampered = await prepared();
  await writeFile(join(tampered.directory, tampered.packages[1].file), "changed");
  await assert.rejects(
    publishNpmClients({
      directory: tampered.directory,
      token: TOKEN,
      fetch: registry(tampered.packages),
      verifyCommit: async () => 1,
      run: noRun,
    }),
    /Prepared archive amerged-ohmyhost-mcp-0\.1\.22\.tgz changed after preparation/u,
  );

  const red = await prepared();
  await assert.rejects(
    publishNpmClients({
      directory: red.directory,
      token: TOKEN,
      fetch: registry(red.packages),
      verifyCommit: async () => {
        throw new Error("CI run 1 for the commit ended as failure");
      },
      run: noRun,
    }),
    /ended as failure/u,
  );

  const account = await prepared();
  let accountDirectory = null;
  await assert.rejects(
    publishNpmClients({
      directory: account.directory,
      token: TOKEN,
      fetch: registry(account.packages),
      verifyCommit: async () => 1,
      run: async (_command, _args, { cwd }) => {
        accountDirectory = cwd;
        return "someone\n";
      },
    }),
    /npm publishes as someone; expected amerged/u,
  );
  assert.equal(existsSync(accountDirectory), false);

  const failing = await prepared();
  await assert.rejects(
    publishNpmClients({
      directory: failing.directory,
      token: TOKEN,
      fetch: registry(failing.packages),
      verifyCommit: async () => 1,
      run: async (_command, args) => {
        if (args[0] === "whoami") return "amerged\n";
        throw Object.assign(new Error("npm failed"), {
          stderr: `npm error 403 token ${TOKEN} lacks publish rights`,
        });
      },
    }),
    (error) =>
      /failed and the registry has no record: npm error 403 token \[redacted\]/u.test(
        error.message,
      ) && !error.message.includes(TOKEN),
  );

  const slow = await prepared();
  const cliName = "@amerged/ohmyhost-cli";
  const everywhere = new Set(NAMES.filter((name) => name !== cliName));
  const publishes = [];
  const runSlow = async (_command, args) => {
    if (args[0] === "whoami") return "amerged\n";
    publishes.push(args[1]);
    return "";
  };
  const options = {
    directory: slow.directory,
    token: TOKEN,
    fetch: registry(slow.packages, { published: everywhere }),
    verifyCommit: async () => 1,
    run: runSlow,
    wait: async () => {},
    attempts: 2,
  };
  const first = await publishNpmClients(options);
  assert.deepEqual(first.pending, [cliName]);
  assert.equal(publishes.length, 1);
  const ledger = JSON.parse(await readFile(join(slow.directory, "published.json"), "utf8"));
  assert.equal(ledger.packages.find((item) => item.name === cliName).state, "submitted");
  const second = await publishNpmClients(options);
  assert.deepEqual(second.pending, [cliName]);
  assert.equal(publishes.length, 1, "a submitted package is never published twice");
  everywhere.add(cliName);
  const third = await publishNpmClients(options);
  assert.deepEqual(third.pending, []);
  assert.equal(third.verified.length, 5);
  assert.equal(publishes.length, 1);
});
