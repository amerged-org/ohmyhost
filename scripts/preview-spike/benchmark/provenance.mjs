/* global process, URL */
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { FIXTURE_NAMES } from "../worker/provenance.mjs";
import { directoryTreeSha256, hashFileEntry, matchesFileInventory } from "./source.mjs";
import { fixtures } from "./statistics.mjs";
import { readOnlyJson } from "../deployment/read-only-json.mjs";
import { HMR_OVERLAY_FIXTURES, hmrOverlaySha256 } from "../worker/container/hmr-probe.mjs";

const execFile = promisify(execFileCallback);
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ACCOUNT = "00000000000000000000000000000001";
const NAME = "ohmyho-preview-spike-development";
const PREFIX = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;

/** Strictly read-only, injectable for tests. A provider message is an operator claim, not a signature. */
export async function verifyReadback(pin, { read, localSource, fixture }) {
  if (
    !pin ||
    pin.accountId !== ACCOUNT ||
    !/^[a-f0-9]{40}$/u.test(pin.sourceRevision ?? "") ||
    !/^[a-f0-9]{40}$/u.test(pin.fixtureSourceRevision ?? "") ||
    !/^[a-f0-9]{64}$/u.test(pin.fixtureTreeSha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(pin.fixtureArchiveSha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(pin.imageSha256 ?? "") ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/u.test(
      pin.containerApplicationId ?? "",
    ) ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(pin.workerVersionId ?? "") ||
    !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(pin.sandboxSdkVersion ?? "")
  )
    return false;
  if (
    !fixtures.includes(fixture) ||
    !Object.hasOwn(pin, "hmrOverlaySha256") ||
    pin.hmrOverlaySha256 !== hmrOverlaySha256(fixture) ||
    (await localSource(pin, { fixture })) !== true
  )
    return false;
  const script = `/workers/scripts/${NAME}`;
  const deployments = await read(`${script}/deployments`);
  const deploymentId = deployments?.deployments?.[0]?.id;
  const live = deployments?.deployments?.[0]?.versions;
  if (
    !Array.isArray(live) ||
    live.length !== 1 ||
    typeof deploymentId !== "string" ||
    deploymentId.length === 0 ||
    live[0]?.percentage !== 100 ||
    live[0].version_id !== pin.workerVersionId
  )
    return false;
  const version = await read(`${script}/versions/${pin.workerVersionId}`);
  const message = version?.annotations?.["workers/message"];
  if (
    version?.id !== pin.workerVersionId ||
    typeof message !== "string" ||
    !["source ", "origin/main "].some((prefix) =>
      message.startsWith(`${prefix}${pin.sourceRevision};`),
    )
  )
    return false;
  const bindings = version?.resources?.bindings;
  const namespaces = Array.isArray(bindings)
    ? bindings.filter(
        (item) =>
          item?.type === "durable_object_namespace" &&
          item.name === "SANDBOX" &&
          item.class_name === "PreviewSpike" &&
          (item.script_name === undefined || item.script_name === NAME),
      )
    : [];
  if (namespaces.length !== 1 || !/^[a-f0-9]{32}$/u.test(namespaces[0].namespace_id ?? ""))
    return false;
  if (
    bindings.filter(
      (item) => item?.type === "version_metadata" && item.name === "CF_VERSION_METADATA",
    ).length !== 1 ||
    bindings.filter(
      (item) =>
        item?.type === "plain_text" &&
        item.name === "SPIKE_SOURCE_REVISION" &&
        item.text === pin.sourceRevision,
    ).length !== 1
  )
    return false;
  // SDK 1.x named images belong to the immutable Worker version. Durable
  // Object-managed applications do not have scheduled-application rollouts.
  const containers = version?.resources?.script_runtime?.containers;
  if (!Array.isArray(containers) || containers.length !== 1) return false;
  const container = containers[0];
  const image = container?.images?.fixture;
  if (
    container?.class_name !== "PreviewSpike" ||
    container.name !== NAME ||
    Object.keys(container.images ?? {}).length !== 1 ||
    typeof image !== "string" ||
    !image.startsWith(`registry.cloudflare.com/${ACCOUNT}/`) ||
    !image.endsWith(`@sha256:${pin.imageSha256}`) ||
    /\s/u.test(image)
  )
    return false;
  const appPath = `/containers/applications/${pin.containerApplicationId}`;
  const app = await read(appPath);
  if (
    app?.id !== pin.containerApplicationId ||
    app.account_id !== ACCOUNT ||
    app.name !== NAME ||
    app.durable_objects?.namespace_id !== namespaces[0].namespace_id ||
    app.scheduling_policy !== "durable_object"
  )
    return false;
  const after = await read(`${script}/deployments`);
  const current = after?.deployments?.[0];
  return (
    current?.id === deploymentId &&
    current?.versions?.length === 1 &&
    current.versions[0]?.percentage === 100 &&
    current.versions[0].version_id === pin.workerVersionId
  );
}

/** Reconstruct every generated context input from the pinned archive and checked-out source. */
export async function expectedBuildContext(pin, { fixture, root = ROOT, signal } = {}) {
  try {
    if (
      !fixtures.includes(fixture) ||
      !Object.hasOwn(pin ?? {}, "hmrOverlaySha256") ||
      pin.hmrOverlaySha256 !== hmrOverlaySha256(fixture) ||
      !/^[a-f0-9]{40}$/u.test(pin?.fixtureSourceRevision ?? "") ||
      !/^[a-f0-9]{64}$/u.test(pin.fixtureArchiveSha256 ?? "") ||
      !/^[a-f0-9]{64}$/u.test(pin.fixtureTreeSha256 ?? "")
    )
      return null;
    const options = {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 30 * 1024 * 1024,
      timeout: 15000,
      signal,
    };
    const prefix = "fixtures/cloudflare-preview/";
    const archive = await execFile(
      "git",
      ["archive", "--format=tar", pin.fixtureSourceRevision, prefix.slice(0, -1)],
      { ...options, encoding: "buffer" },
    );
    if (createHash("sha256").update(archive.stdout).digest("hex") !== pin.fixtureArchiveSha256)
      return null;
    const entries = await execFile(
      "git",
      ["ls-tree", "-r", "-z", pin.fixtureSourceRevision, "--", prefix],
      options,
    );
    const files = entries.stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(entry);
        if (!match || !match[3].startsWith(prefix)) throw new Error("fixture_archive_invalid");
        return {
          executable: match[1] === "100755",
          relative: match[3].slice(prefix.length),
          object: match[2],
        };
      })
      .sort((a, b) => {
        const left = a.relative.replaceAll("/", "\0"),
          right = b.relative.replaceAll("/", "\0");
        return left < right ? -1 : left > right ? 1 : 0;
      });
    const all = createHash("sha256");
    const fixtureHashes = new Map(FIXTURE_NAMES.map((name) => [name, createHash("sha256")]));
    const counts = new Map(FIXTURE_NAMES.map((name) => [name, 0]));
    const expected = new Map();
    const add = (path, value) => {
      if (expected.has(path)) throw new Error("fixture_archive_invalid");
      expected.set(path, value);
    };
    for (const file of files) {
      const [name] = file.relative.split("/");
      const hash = fixtureHashes.get(name);
      if (!hash || !file.relative.startsWith(`${name}/`))
        throw new Error("fixture_archive_invalid");
      const { stdout: bytes } = await execFile("git", ["cat-file", "blob", file.object], {
        ...options,
        encoding: "buffer",
      });
      hashFileEntry(all, file.relative, file.executable, bytes);
      hashFileEntry(hash, file.relative.slice(name.length + 1), file.executable, bytes);
      counts.set(name, counts.get(name) + 1);
      const value = { bytes, executable: file.executable };
      add(`${prefix}${file.relative}`, value);
      const lock = name === "astro-edge" ? "package-lock.json" : "pnpm-lock.yaml";
      if (file.relative === `${name}/package.json` || file.relative === `${name}/${lock}`)
        add(`seed-fixtures/${file.relative}`, value);
    }
    if (FIXTURE_NAMES.some((name) => !counts.get(name))) return null;
    const fixtureTrees = Object.fromEntries(
      FIXTURE_NAMES.map((name) => [name, fixtureHashes.get(name).digest("hex")]),
    );
    if (
      fixtureTrees[fixture] !== pin.fixtureTreeSha256 ||
      (await directoryTreeSha256(join(root, prefix))) !== all.digest("hex") ||
      FIXTURE_NAMES.some((name) => {
        const lock = name === "astro-edge" ? "package-lock.json" : "pnpm-lock.yaml";
        return (
          !expected.has(`seed-fixtures/${name}/package.json`) ||
          !expected.has(`seed-fixtures/${name}/${lock}`)
        );
      })
    )
      return null;

    const worker = join(root, "scripts/preview-spike/worker");
    async function sourceFile(path) {
      const status = await lstat(path);
      if (!status.isFile()) throw new Error("fixture_file_invalid");
      return { bytes: await readFile(path), executable: Boolean(status.mode & 0o111) };
    }
    const helpers = new Map();
    for (const name of [
      "driver.mjs",
      "write-file.c",
      "next-request-hook.mjs",
      "bindings-worker.mjs",
      "hmr-probe.mjs",
    ]) {
      const value = await sourceFile(join(worker, "container", name));
      helpers.set(name, value);
      add(`container/${name}`, value);
    }
    if (!(await matchesFileInventory(join(worker, "container"), helpers))) return null;
    for (const name of ["guest-binding.mjs", "transport.mjs", "wire.mjs"])
      add(
        `container/capabilities/${name}`,
        await sourceFile(join(root, "scripts/preview-spike/capabilities", name)),
      );
    for (const name of ["package.json", "package-lock.json"])
      add(`tooling/${name}`, await sourceFile(join(worker, name)));
    const generated = (value) => ({ bytes: Buffer.from(value), executable: false });
    add(".preview-spike-context", generated("preview-spike-generated-context\n"));
    add("fixture-commit.txt", generated(`${pin.fixtureSourceRevision}\n`));
    add(
      "fixture-provenance.json",
      generated(
        `${JSON.stringify(
          {
            fixtureSourceRevision: pin.fixtureSourceRevision,
            fixtureArchiveSha256: pin.fixtureArchiveSha256,
            fixtureTrees,
            hmrOverlays: Object.fromEntries(
              HMR_OVERLAY_FIXTURES.map((name) => [name, hmrOverlaySha256(name)]),
            ),
          },
          null,
          2,
        )}\n`,
      ),
    );
    return expected;
  } catch {
    return null;
  }
}

/** Compare prepared local inputs; this cannot attest how a provider built an image. */
export async function verifyBuildContext(pin, { fixture, root = ROOT, context, signal } = {}) {
  const expected = await expectedBuildContext(pin, { fixture, root, signal });
  if (!expected) return false;
  return matchesFileInventory(
    context ?? join(root, "scripts/preview-spike/worker/build-context"),
    expected,
  );
}

/** Source/context identity only: this cannot attest how a provider built an image. */
export async function verifyLocalSource(pin, { fixture, root = ROOT, signal } = {}) {
  try {
    if (
      !fixtures.includes(fixture) ||
      !/^[a-f0-9]{40}$/u.test(pin?.sourceRevision ?? "") ||
      !/^[a-f0-9]{40}$/u.test(pin.fixtureSourceRevision ?? "")
    )
      return false;
    const options = {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 30 * 1024 * 1024,
      timeout: 15000,
      signal,
    };
    const head = await execFile("git", ["rev-parse", "HEAD"], options);
    if (head.stdout.trim() !== pin.sourceRevision) return false;
    const status = await execFile(
      "git",
      [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        "scripts/preview-spike",
        "fixtures/cloudflare-preview",
      ],
      options,
    );
    if (status.stdout !== "") return false;
    const lock = JSON.parse(
      await readFile(join(root, "scripts/preview-spike/worker/package-lock.json"), "utf8"),
    );
    if (lock?.packages?.["node_modules/@cloudflare/sandbox"]?.version !== pin.sandboxSdkVersion)
      return false;
    return await verifyBuildContext(pin, { fixture, root, signal });
  } catch {
    return false;
  }
}

export async function verify(
  pin,
  {
    fixture,
    signal,
    now = () => performance.now(),
    deadlineAt = now() + 47000,
    observe = () => {},
  } = {},
) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (typeof token !== "string" || !token) return false;
  const read = async (path) => {
    try {
      const label = path.includes("/containers/")
        ? "cf-container"
        : path.includes("/versions/")
          ? "cf-version"
          : "cf-deployments";
      const result = await readOnlyJson(`${PREFIX}${path}`, {
        label,
        headers: { authorization: `Bearer ${token}` },
        signal,
        deadlineAt,
        now,
        observe,
      });
      if (result?.success !== true || result.result === undefined) return null;
      return result.result;
    } catch {
      return null;
    }
  };
  try {
    return await verifyReadback(pin, {
      read,
      localSource: (candidate, context) => verifyLocalSource(candidate, { ...context, signal }),
      fixture,
    });
  } catch {
    return false;
  }
}
