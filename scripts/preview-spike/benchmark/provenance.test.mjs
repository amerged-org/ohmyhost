/* global structuredClone, process */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import {
  verifyReadback,
  verifyLocalSource,
  verifyBuildContext,
  expectedBuildContext,
} from "./provenance.mjs";
import { directoryTreeSha256, matchesFileInventory } from "./source.mjs";
import { FIXTURE_NAMES } from "../worker/provenance.mjs";
import { createAdapter } from "./cloudflare.mjs";
import { runBenchmark } from "./runner.mjs";
import { evaluate } from "./statistics.mjs";
import { HMR_OVERLAY_FIXTURES, hmrOverlaySha256 } from "../worker/container/hmr-probe.mjs";

const pin = {
  accountId: "00000000000000000000000000000001",
  sourceRevision: "a".repeat(40),
  fixtureSourceRevision: "c".repeat(40),
  fixtureTreeSha256: "d".repeat(64),
  fixtureArchiveSha256: "e".repeat(64),
  hmrOverlaySha256: null,
  imageSha256: "b".repeat(64),
  containerApplicationId: "12345678-1234-1234-1234-123456789abc",
  workerVersionId: "23456789-1234-1234-1234-123456789abc",
  sandboxSdkVersion: "1.0.1",
};
const worker = "/workers/scripts/ohmyho-preview-spike-development";
const appPath = `/containers/applications/${pin.containerApplicationId}`;
const image = `registry.cloudflare.com/${pin.accountId}/spike@sha256:${pin.imageSha256}`;
function state() {
  return {
    [`${worker}/deployments`]: {
      deployments: [
        {
          id: "34567890-1234-1234-1234-123456789abc",
          versions: [{ percentage: 100, version_id: pin.workerVersionId }],
        },
      ],
    },
    [`${worker}/versions/${pin.workerVersionId}`]: {
      id: pin.workerVersionId,
      annotations: { "workers/message": `source ${pin.sourceRevision}; image verified` },
      resources: {
        bindings: [
          { type: "version_metadata", name: "CF_VERSION_METADATA" },
          { type: "plain_text", name: "SPIKE_SOURCE_REVISION", text: pin.sourceRevision },
          {
            type: "durable_object_namespace",
            name: "SANDBOX",
            class_name: "PreviewSpike",
            namespace_id: "d".repeat(32),
          },
        ],
        script_runtime: {
          containers: [
            {
              name: "ohmyho-preview-spike-development",
              class_name: "PreviewSpike",
              images: { fixture: image },
            },
          ],
        },
      },
    },
    [appPath]: {
      id: pin.containerApplicationId,
      account_id: pin.accountId,
      name: "ohmyho-preview-spike-development",
      durable_objects: { namespace_id: "d".repeat(32) },
      scheduling_policy: "durable_object",
    },
  };
}
const readFrom = (values) => async (path) => values[path];
const localSource = async (candidate, { fixture }) =>
  candidate.sourceRevision === pin.sourceRevision &&
  candidate.sandboxSdkVersion === "1.0.1" &&
  fixture === "next-edge";
const context = { fixture: "next-edge" };

test("a prepared context matches its pinned fixtures and helpers and refuses changed source fixtures", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const directory = await realpath(await mkdtemp(join(tmpdir(), "preview-real-context-")));
  const sourceWorker = join(root, "scripts/preview-spike/worker");
  const worker = join(directory, "scripts/preview-spike/worker");
  try {
    // Use the checked-out public fixture commit without depending on earlier repository history.
    // Only the disposable clone receives checked-out fixtures and helper inputs.
    execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", root, directory], {
      env: { PATH: process.env.PATH },
    });
    await mkdir(worker, { recursive: true });
    for (const file of [
      "prepare-context.mjs",
      "provenance.mjs",
      "package.json",
      "package-lock.json",
    ])
      await cp(join(sourceWorker, file), join(worker, file));
    await cp(join(sourceWorker, "container"), join(worker, "container"), { recursive: true });
    await mkdir(join(directory, "scripts/preview-spike/capabilities"));
    for (const file of ["guest-binding.mjs", "transport.mjs", "wire.mjs"])
      await cp(
        join(root, "scripts/preview-spike/capabilities", file),
        join(directory, "scripts/preview-spike/capabilities", file),
      );
    const git = (...args) =>
      execFileSync("git", args, { cwd: directory, env: { PATH: process.env.PATH } });
    const revision = git("rev-parse", "HEAD").toString().trim();
    const { prepareContext } = await import(
      pathToFileURL(join(worker, "prepare-context.mjs")).href
    );
    await prepareContext(revision);
    const generated = join(worker, "build-context");
    const manifest = JSON.parse(await readFile(join(generated, "fixture-provenance.json"), "utf8"));
    assert.equal(manifest.fixtureSourceRevision, revision);
    git("checkout", revision, "--", "fixtures/cloudflare-preview");
    const actualPin = {
      fixtureSourceRevision: manifest.fixtureSourceRevision,
      fixtureArchiveSha256: manifest.fixtureArchiveSha256,
      fixtureTreeSha256: manifest.fixtureTrees["next-edge"],
      hmrOverlaySha256: null,
    };
    assert.equal(
      await verifyBuildContext(actualPin, {
        fixture: "next-edge",
        root: directory,
        context: generated,
      }),
      true,
    );
    const checkedOutFixture = join(
      directory,
      "fixtures/cloudflare-preview/react-vite/src/main.tsx",
    );
    const pinnedBytes = await readFile(checkedOutFixture);
    await writeFile(checkedOutFixture, "synthetic fixture change\n");
    assert.equal(
      await verifyBuildContext(actualPin, {
        fixture: "next-edge",
        root: directory,
        context: generated,
      }),
      false,
    );
    await writeFile(checkedOutFixture, pinnedBytes);
    const expected = await expectedBuildContext(actualPin, {
      fixture: "next-edge",
      root: directory,
    });
    assert.ok(expected instanceof Map);
    for (const relative of [
      "fixtures/cloudflare-preview/react-vite/src/main.tsx",
      ...FIXTURE_NAMES.flatMap((name) => [
        `seed-fixtures/${name}/package.json`,
        `seed-fixtures/${name}/${name === "astro-edge" ? "package-lock.json" : "pnpm-lock.yaml"}`,
      ]),
      "container/driver.mjs",
      "container/write-file.c",
      "container/next-request-hook.mjs",
      "container/bindings-worker.mjs",
      "container/hmr-probe.mjs",
      "container/capabilities/guest-binding.mjs",
      "container/capabilities/transport.mjs",
      "container/capabilities/wire.mjs",
      "tooling/package.json",
      "tooling/package-lock.json",
      "fixture-commit.txt",
      "fixture-provenance.json",
      ".preview-spike-context",
    ]) {
      const file = join(generated, relative);
      const original = await readFile(file);
      await writeFile(file, "synthetic tampering\n");
      assert.equal(await matchesFileInventory(generated, expected), false, relative);
      await writeFile(file, original);
    }
    for (const relative of [
      "container/unexpected.mjs",
      "container/capabilities/unexpected.mjs",
      "tooling/unexpected.json",
      "seed-fixtures/react-vite/unexpected.yaml",
      "fixtures/cloudflare-preview/react-vite/src/unexpected.ts",
      ".env.local",
    ]) {
      const file = join(generated, relative);
      await writeFile(file, "synthetic excluded canary\n");
      assert.equal(await matchesFileInventory(generated, expected), false, relative);
      if (relative === "container/unexpected.mjs")
        assert.equal(
          await verifyBuildContext(actualPin, {
            fixture: "next-edge",
            root: directory,
            context: generated,
          }),
          false,
        );
      await rm(file);
    }
    const emptyDirectory = join(generated, "container/unexpected-empty");
    await mkdir(emptyDirectory);
    assert.equal(await matchesFileInventory(generated, expected), false);
    await rm(emptyDirectory, { recursive: true });

    const target = join(generated, "container/capabilities/transport.mjs");
    const saved = join(directory, "saved-transport.mjs");
    await rename(target, saved);
    assert.equal(await matchesFileInventory(generated, expected), false, "missing file");
    await symlink(saved, target);
    assert.equal(await matchesFileInventory(generated, expected), false, "linked file");
    await rm(target);
    await link(saved, target);
    assert.equal(await matchesFileInventory(generated, expected), false, "hard-linked file");
    await rm(target);
    execFileSync("mkfifo", [target]);
    assert.equal(await matchesFileInventory(generated, expected), false, "special file");
    await rm(target);
    await rename(saved, target);
    const mode = (await lstat(target)).mode & 0o777;
    await chmod(target, mode ^ 0o100);
    assert.equal(await matchesFileInventory(generated, expected), false, "executable bit changed");
    await chmod(target, mode);
    assert.equal(await matchesFileInventory(generated, expected), true);
    const linkedContext = join(directory, "linked-context");
    await symlink(generated, linkedContext);
    assert.equal(await matchesFileInventory(linkedContext, expected), false, "linked context root");
    assert.equal(
      await verifyBuildContext(
        { ...actualPin, fixtureTreeSha256: "0".repeat(64) },
        { fixture: "next-edge", root: directory, context: generated },
      ),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires matching archive, build context, version-bound image and repeated independent readback", async () => {
  const base = state();
  assert.equal(await verifyReadback(pin, { read: readFrom(base), localSource, ...context }), true);
  for (const mutate of [
    (v) => {
      v[`${worker}/deployments`].deployments[0].versions[0].percentage = 50;
    },
    (v) => {
      v[`${worker}/versions/${pin.workerVersionId}`].annotations["workers/message"] = "wrong";
    },
    (v) => {
      v[
        `${worker}/versions/${pin.workerVersionId}`
      ].resources.script_runtime.containers[0].images.fixture = image.replace(
        pin.imageSha256,
        "c".repeat(64),
      );
    },
    (v) => {
      v[appPath].durable_objects.namespace_id = "e".repeat(32);
    },
    (v) => {
      v[`${worker}/versions/${pin.workerVersionId}`].resources.bindings[1].text = "f".repeat(40);
    },
    (v) => {
      v[`${worker}/versions/${pin.workerVersionId}`].resources.script_runtime.containers.push({
        class_name: "PreviewSpike",
        images: { fixture: image },
      });
    },
  ]) {
    const changed = structuredClone(base);
    mutate(changed);
    assert.equal(
      await verifyReadback(pin, { read: readFrom(changed), localSource, ...context }),
      false,
    );
  }
  assert.equal(
    await verifyReadback(pin, { read: readFrom(base), localSource: async () => false, ...context }),
    false,
  );
  assert.equal(
    await verifyReadback(
      { ...pin, accountId: "f".repeat(32) },
      { read: readFrom(base), localSource, ...context },
    ),
    false,
  );
  let deploymentReads = 0;
  assert.equal(
    await verifyReadback(pin, {
      ...context,
      localSource,
      read: async (path) => {
        if (path.endsWith("/deployments") && ++deploymentReads === 2)
          return {
            deployments: [
              {
                id: "45678901-1234-1234-1234-123456789abc",
                versions: [{ percentage: 100, version_id: pin.workerVersionId }],
              },
            ],
          };
        return base[path];
      },
    }),
    false,
  );

  const directory = await mkdtemp(join(tmpdir(), "preview-provenance-test-"));
  try {
    const fixture = join(directory, "fixtures/cloudflare-preview/next-edge");
    const workerRoot = join(directory, "scripts/preview-spike/worker");
    for (const name of FIXTURE_NAMES) {
      const fixtureRoot = join(directory, "fixtures/cloudflare-preview", name);
      await mkdir(fixtureRoot, { recursive: true });
      await writeFile(join(fixtureRoot, "package.json"), `synthetic ${name} package\n`);
      await writeFile(
        join(fixtureRoot, name === "astro-edge" ? "package-lock.json" : "pnpm-lock.yaml"),
        `synthetic ${name} lock\n`,
      );
    }
    await mkdir(join(fixture, "src"));
    await mkdir(join(workerRoot, "container"), { recursive: true });
    await writeFile(join(fixture, "src/main.ts"), "public fixture\n");
    await writeFile(join(fixture, "src.ts"), "public adjacent file\n");
    await writeFile(join(workerRoot, "container/driver.mjs"), "public driver\n");
    await writeFile(join(workerRoot, "container/write-file.c"), "public helper\n");
    await writeFile(join(workerRoot, "container/next-request-hook.mjs"), "public hook\n");
    await writeFile(join(workerRoot, "container/bindings-worker.mjs"), "public bindings\n");
    await writeFile(join(workerRoot, "container/hmr-probe.mjs"), "public probe\n");
    const capabilities = join(directory, "scripts/preview-spike/capabilities");
    await mkdir(capabilities, { recursive: true });
    for (const name of ["guest-binding.mjs", "transport.mjs", "wire.mjs"])
      await writeFile(join(capabilities, name), `synthetic ${name}\n`);
    await writeFile(join(workerRoot, "package.json"), "{}\n");
    await writeFile(
      join(workerRoot, "package-lock.json"),
      JSON.stringify({ packages: { "node_modules/@cloudflare/sandbox": { version: "1.0.1" } } }),
    );
    await writeFile(join(directory, ".gitignore"), "scripts/preview-spike/worker/build-context/\n");
    const git = (...args) => execFileSync("git", args, { cwd: directory });
    git("init", "--quiet");
    git("add", ".");
    git(
      "-c",
      "user.name=Preview test",
      "-c",
      "user.email=preview@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Public fixture",
    );
    const revision = git("rev-parse", "HEAD").toString().trim();
    const archive = git("archive", "--format=tar", revision, "fixtures/cloudflare-preview");
    const fixtureTreeSha256 = await directoryTreeSha256(fixture);
    const candidate = {
      ...pin,
      sourceRevision: revision,
      fixtureSourceRevision: revision,
      fixtureArchiveSha256: createHash("sha256").update(archive).digest("hex"),
      fixtureTreeSha256,
    };
    const buildContext = join(workerRoot, "build-context");
    await cp(join(directory, "fixtures"), join(buildContext, "fixtures"), { recursive: true });
    await cp(join(workerRoot, "container"), join(buildContext, "container"), { recursive: true });
    await mkdir(join(buildContext, "container/capabilities"));
    for (const name of ["guest-binding.mjs", "transport.mjs", "wire.mjs"])
      await cp(join(capabilities, name), join(buildContext, "container/capabilities", name));
    await mkdir(join(buildContext, "tooling"));
    for (const name of ["package.json", "package-lock.json"])
      await cp(join(workerRoot, name), join(buildContext, "tooling", name));
    for (const name of FIXTURE_NAMES) {
      const source = join(directory, "fixtures/cloudflare-preview", name);
      const seed = join(buildContext, "seed-fixtures", name);
      await mkdir(seed, { recursive: true });
      for (const file of [
        "package.json",
        name === "astro-edge" ? "package-lock.json" : "pnpm-lock.yaml",
      ])
        await cp(join(source, file), join(seed, file));
    }
    const fixtureTrees = Object.fromEntries(
      await Promise.all(
        FIXTURE_NAMES.map(async (name) => [
          name,
          await directoryTreeSha256(join(directory, "fixtures/cloudflare-preview", name)),
        ]),
      ),
    );
    await writeFile(
      join(buildContext, ".preview-spike-context"),
      "preview-spike-generated-context\n",
    );
    await writeFile(join(buildContext, "fixture-commit.txt"), `${revision}\n`);
    await writeFile(
      join(buildContext, "fixture-provenance.json"),
      `${JSON.stringify(
        {
          fixtureSourceRevision: revision,
          fixtureArchiveSha256: candidate.fixtureArchiveSha256,
          fixtureTrees,
          hmrOverlays: Object.fromEntries(
            HMR_OVERLAY_FIXTURES.map((name) => [name, hmrOverlaySha256(name)]),
          ),
        },
        null,
        2,
      )}\n`,
    );
    assert.equal(await verifyLocalSource(candidate, { ...context, root: directory }), true);
    assert.equal(
      await verifyLocalSource(
        { ...candidate, fixtureArchiveSha256: "f".repeat(64) },
        { ...context, root: directory },
      ),
      false,
    );
    await writeFile(
      join(buildContext, "fixtures/cloudflare-preview/next-edge/src/main.ts"),
      "stale image fixture\n",
    );
    assert.equal(await verifyLocalSource(candidate, { ...context, root: directory }), false);
    await cp(fixture, join(buildContext, "fixtures/cloudflare-preview/next-edge"), {
      recursive: true,
    });
    await writeFile(join(buildContext, "container/driver.mjs"), "stale driver\n");
    assert.equal(await verifyLocalSource(candidate, { ...context, root: directory }), false);
    await cp(join(workerRoot, "container"), join(buildContext, "container"), { recursive: true });
    await writeFile(join(fixture, "src/main.ts"), "uncommitted fixture\n");
    assert.equal(await verifyLocalSource(candidate, { ...context, root: directory }), false);
    git("add", "fixtures");
    git(
      "-c",
      "user.name=Preview test",
      "-c",
      "user.email=preview@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Different committed fixture",
    );
    const changedRevision = git("rev-parse", "HEAD").toString().trim();
    assert.equal(
      await verifyLocalSource(
        { ...candidate, sourceRevision: changedRevision },
        { ...context, root: directory },
      ),
      false,
    );
    assert.doesNotMatch(
      await readFile(join(buildContext, "fixture-provenance.json"), "utf8"),
      /token|secret/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const previous = process.env.PREVIEW_SPIKE_PROVENANCE_DRIVER;
  try {
    process.env.PREVIEW_SPIKE_PROVENANCE_DRIVER = "/unreviewed-always-true.mjs";
    await assert.rejects(createAdapter({}, {}), /external_provenance_driver_unsupported/);
  } finally {
    if (previous === undefined) delete process.env.PREVIEW_SPIKE_PROVENANCE_DRIVER;
    else process.env.PREVIEW_SPIKE_PROVENANCE_DRIVER = previous;
  }
  let drifted = false,
    mutations = 0,
    clock = 0;
  const events = [];
  const testConfig = {
    fixture: "react-vite",
    instance: "standard-2",
    samples: 20,
    inactivityMs: 5000,
    passiveObservationMs: 1000,
    deadlineMs: 100,
    provenance: {
      ...pin,
      hmrOverlaySha256: hmrOverlaySha256("react-vite"),
      packageCache: "seeded",
    },
  };
  const adapter = {
    verifyScope: async () => {
      clock += 500;
      return { identityReadbackMatched: !drifted };
    },
    setup: async () => ({ ready: true, backupVerified: true, identityReadbackMatched: true }),
    capabilityBefore: async () => ({ databaseCrud: true }),
    checkIdleTab: async () => {
      clock += 6000;
      return {
        socketConnectedBefore: true,
        idleSleepObserved: true,
        noPassiveWake: true,
        userWakeObserved: true,
        hmrAfterWake: true,
        sleepWaitMs: 5000,
        passiveWaitMs: 1000,
      };
    },
    prepareWake: async () => ({
      sleepVerified: true,
      manualStopVerified: true,
      backupVerified: true,
      sleepInduction: "manual",
    }),
    wake: async () => {
      mutations += 1;
      clock += 123;
      drifted = true;
      return { usable: true, sameUrl: true };
    },
    verifyWake: async () => ({
      restored: true,
      newGeneration: true,
      phases: { containerStartMs: 1, restoreMs: 1, serverStartMs: 1 },
    }),
    prepareHmr: async () => {
      throw new Error("unexpected later operation");
    },
    finishRun: async () => {
      throw new Error("unexpected cleanup after drift");
    },
  };
  assert.deepEqual(
    await runBenchmark({
      adapter,
      config: testConfig,
      now: () => clock,
      journal: { append: async (event) => events.push(event) },
    }),
    { completed: false },
  );
  assert.equal(mutations, 1);
  const changed = events.find((event) => event.event === "sample_result");
  assert.equal(changed.outcome, "error");
  assert.equal(changed.stage, "provenance_after");
  assert.equal(changed.elapsedMs, 123);
  assert.equal(changed.evidence.identityReadbackAfter, false);
  assert.equal(events.filter((event) => event.event === "sample_start").length, 1);
  assert.equal(evaluate(events).frameworkTargets, "failed");
});
