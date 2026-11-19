import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, test } from "node:test";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

import { parse as parseJavaScript } from "acorn";
import { parse as parseModule } from "@babel/parser";
import { normalizeBrowserPolicy } from "../../../../packages/contracts/src/browser-capabilities.ts";
import { FRAMEWORK_VERSION_POLICY } from "../../../../packages/contracts/src/framework-build-script.mjs";
import {
  FrameworkVersionRefusal,
  createBuildArtifactArchive,
  createBuildFailureExcerpt,
  createDependencyInventory,
  createOpenNextPlatformConfig,
  createNextPlatformConfig,
  createTanStackPlatformConfig,
  createAstroPlatformConfig,
  validateAstroBuildOutput,
  createViteCompanionConfig,
  createFunctionsWorkerConfig,
  cleanupTanStackPlatformConfig,
  cleanupOpenNextPlatformConfig,
  finalizeFunctionsWorkerOutput,
  finalizeViteCompanionOutput,
  copyBuildOutputFile,
  packageBuildArtifact,
  packagingFailureLine,
  populateNextStaticCache,
  PackagingLimitError,
  inspectPackageManager,
  readBuildFailureExcerpt,
  readFrameworkBuildArguments,
  readPackageManagerReceipt,
  resolveApplicationRoot,
  snapshotDatabaseMigrations,
  validateCustomerAuthRequirementJson,
  validateFunctionsRequirementJson,
  validateNextWorkerConfig,
  validateNextWorkerMetafile,
  validateNextCacheSupport,
  validateNextStaticCache,
  validateTanStackBuildOutput,
  validateRuntimePolicyJson,
  validateStorageRequirementJson,
  validateSourceArchive,
  validateSourceArchiveBytes,
  writePackageManagerReceipt,
  writeRootPackageScript,
  writeUserBuildScript,
} from "../build-runtime.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ohmyhost-build-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

function tarEntry(entryPath, type = "0", body = Buffer.from("x")) {
  const header = Buffer.alloc(512);
  header.write(entryPath, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(32, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

test("keeps the G005 build runtime custody, Next overlay, and package-manager defects in one table", () => {
  fs.mkdirSync("/tmp/ohmyho", { recursive: true });
  const output = "/tmp/ohmyho/user-build.sh";
  fs.rmSync(output, { force: true });
  writeUserBuildScript(output);
  const body = fs.readFileSync(output, "utf8");
  assert.equal(fs.statSync(output).mode & 0o777, 0o555);
  for (const command of [
    "bun install --frozen-lockfile --ignore-scripts",
    "npm ci --ignore-scripts",
    "pnpm install --frozen-lockfile --ignore-scripts",
    "yarn install --immutable --mode=skip-build",
  ]) {
    assert.ok(body.includes(command));
  }
  // Every package manager leaves node_modules for the installed framework version check.
  assert.match(
    body,
    /\nexport YARN_NODE_LINKER=node-modules\n(?:#[^\n]*\n)*case "\$package_manager:\$INSTALL_COMMAND" in\n/u,
  );
  assert.match(body, /NEXT_PRIVATE_STANDALONE=true/u);
  assert.match(body, /next-open-next-config \.ohmyhost-open-next\.config\.ts/u);
  assert.match(body, /cleanup-next-platform-config/u);
  assert.match(body, /opennextjs-cloudflare build/u);
  assert.match(body, /next-cache-validate/u);
  assert.match(body, /next-cache-populate/u);
  assert.match(
    body,
    /test "\$\(stat -c %s \.ohmyhost-next-worker\.js\.gz\)" -le 10485760 \|\| \{ echo 'ohmyho\.st packaging: the Next\.js Worker is more than 10485760 bytes gzip-compressed; it may be at most 10485760 bytes'; exit 1; \}/u,
  );
  // OpenNext reads only the platform's config, never a customer's open-next.config.ts.
  assert.match(
    body,
    /build --skipNextBuild --config=\.ohmyhost-next-wrangler\.jsonc --openNextConfigPath=\.ohmyhost-open-next\.config\.ts\n/u,
  );
  assert.match(body, /\/opt\/ohmyhost-platform\/bin\/wrangler/u);
  assert.match(body, /\/opt\/ohmyhost-platform\/bin\/corepack/u);
  assert.match(
    body,
    /pnpm_config_package_import_method=copy \/opt\/ohmyhost-platform\/bin\/corepack "pnpm@\$package_manager_version" install --frozen-lockfile --ignore-scripts --config\.package-import-method=copy/u,
  );
  assert.doesNotMatch(body, /\s--package-import-method(?:=|\s)/u);
  assert.match(
    body,
    /\/opt\/ohmyhost-platform\/bin\/bun install --frozen-lockfile --ignore-scripts/u,
  );
  assert.match(body, /\/opt\/ohmyhost-platform\/bin\/bun run build/u);
  assert.match(body, /if test "\$FRAMEWORK_RUNTIME" != "functions"; then/u);
  // Every non-functions adapter checks its installed framework versions after the frozen install
  // and before the customer's build script runs.
  const versionCheck = body.indexOf(
    'framework_build_argument="$(node /opt/ohmyho/build-runtime.mjs framework-build-argument)"',
  );
  assert.ok(versionCheck > body.indexOf('if test "$FRAMEWORK_RUNTIME" != "functions"; then'));
  assert.ok(versionCheck > body.lastIndexOf("--mode=skip-build ;;"));
  assert.ok(versionCheck < body.indexOf('case "$package_manager:$BUILD_COMMAND" in'));
  assert.equal(body.split("framework-build-argument").length, 2);
  assert.match(
    body,
    /if test -n "\$framework_build_argument"; then build_arguments=\("\$framework_build_argument"\); fi/u,
  );
  assert.doesNotMatch(body, /next-build-argument|startsWith/u);
  assert.match(body, /functions-config \.ohmyhost-functions-wrangler\.jsonc/u);
  assert.match(
    body,
    /--outdir \.ohmyhost\/functions --config \.ohmyhost-functions-wrangler\.jsonc/u,
  );
  assert.match(body, /finalize-functions/u);
  assert.match(body, /rm \.ohmyhost-functions-wrangler\.jsonc \.ohmyhost-functions-entry\.ts/u);
  assert.doesNotMatch(body, /customer-runtime|scheduled/u);
  assert.doesNotMatch(body, /\/opt\/ohmyhost-platform\/node_modules\/\.bin/u);
  assert.doesNotMatch(
    body,
    /npm exec[^\n]*bun@|eval|corepack prepare|pnpm exec wrangler|build:cloudflare/u,
  );
  assert.doesNotMatch(body, /SOURCE_GET_URL|OUTPUT_PUT_URL/u);
  assert.doesNotMatch(body, /\/tmp\/ohmyho\/build-runtime\.mjs|runuser|curl/u);
  const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /bun@1\.2\.22/u);
  assert.doesNotMatch(dockerfile, /bun@1\.2\.22[^\n]*--ignore-scripts/u);
  assert.match(
    dockerfile,
    /^FROM --platform=linux\/amd64 node:24\.15\.0-bookworm-slim@sha256:[0-9a-f]{64}$/mu,
  );
  assert.match(
    dockerfile,
    /--prefix \/opt\/ohmyhost-platform --ignore-scripts --no-audit --no-fund \\\n\s+corepack@0\.35\.0 wrangler@4\.125\.0 @opennextjs\/cloudflare@1\.20\.9 \\/u,
  );
  // The image receives exactly the static relative import closure of its entry points, each at
  // the absolute path its importer resolves, and the build context admits exactly those sources.
  const copies = new Map();
  for (const instruction of dockerfile.replace(/\\\n/gu, " ").split("\n")) {
    assert.doesNotMatch(instruction, /^\s*ADD\b/iu);
    if (!/^\s*COPY\b/iu.test(instruction)) continue;
    const [, mode, ...operands] = instruction.trim().split(/\s+/u);
    assert.equal(mode, "--chmod=0644", instruction);
    assert.ok(operands.every((operand) => !operand.startsWith("-") && !operand.startsWith("[")));
    const destination = operands.pop();
    assert.ok(operands.length === 1 || destination.endsWith("/"), instruction);
    for (const source of operands) {
      const imagePath = destination.endsWith("/")
        ? path.posix.join(destination, path.posix.basename(source))
        : destination;
      assert.equal(copies.has(imagePath), false, imagePath);
      copies.set(imagePath, source);
    }
  }
  // The reviewed OpenNext fixes rewrite the installed package before anything else uses it.
  const openNextPatch =
    "COPY --chmod=0644 apps/build-runner/sandbox/open-next-patch.mjs /opt/ohmyho/open-next-patch.mjs\nRUN node /opt/ohmyho/open-next-patch.mjs /opt/ohmyhost-platform/lib/node_modules/@opennextjs/cloudflare\n";
  assert.ok(
    dockerfile.indexOf(openNextPatch) > dockerfile.indexOf("@opennextjs/cloudflare@1.20.9"),
  );
  assert.ok(dockerfile.indexOf(openNextPatch) < dockerfile.indexOf("RUN useradd "));
  const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const closure = new Map();
  const pending = [
    JSON.parse(/^CMD (\[.*\])$/mu.exec(dockerfile)[1]).at(-1),
    "/opt/ohmyho/build-runtime.mjs",
    // A platform-generated OpenNext config imports this opt-in runtime override.
    "/opt/ohmyho/next-writable-cache.mjs",
    // A script the image build runs is an entry point as well.
    ...[...dockerfile.matchAll(/^RUN node (\/opt\/ohmyho\/\S+\.mjs) /gmu)].map(
      ([, script]) => script,
    ),
  ];
  while (pending.length > 0) {
    const imagePath = pending.pop();
    if (closure.has(imagePath)) continue;
    const source = copies.get(imagePath);
    assert.equal(typeof source, "string", `${imagePath} is not copied into the image`);
    closure.set(imagePath, source);
    const tree = parseModule(fs.readFileSync(path.join(repositoryRoot, source), "utf8"), {
      sourceType: "module",
      plugins: source.endsWith(".ts") ? ["typescript"] : [],
    });
    for (const statement of tree.program.body) {
      const specifier =
        /^(?:ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration)$/u.test(
          statement.type,
        ) &&
        statement.importKind !== "type" &&
        statement.exportKind !== "type"
          ? statement.source?.value
          : undefined;
      if (specifier?.startsWith("./") || specifier?.startsWith("../")) {
        const imported = path.posix.resolve(path.posix.dirname(imagePath), specifier);
        assert.equal(
          copies.get(imported),
          path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier)),
          `${source} imports ${specifier}`,
        );
        pending.push(imported);
      }
    }
  }
  const copiedSources = [...copies.values()].sort();
  assert.deepEqual([...closure.values()].sort(), copiedSources);
  assert.ok(copiedSources.includes("packages/contracts/src/framework-build-script.mjs"));
  const dockerignore = fs
    .readFileSync(new URL("../Dockerfile.dockerignore", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"));
  assert.equal(dockerignore[0], "**");
  // A directory exception would admit its whole tree, so every exception names one file.
  assert.ok(dockerignore.slice(1).every((line) => line.startsWith("!") && !line.endsWith("/")));
  assert.deepEqual(
    dockerignore
      .slice(1)
      .map((line) => line.slice(1))
      .sort(),
    copiedSources,
  );
  assert.match(dockerfile, /useradd --create-home --uid 10001 /u);
  assert.match(dockerfile, / procps .* util-linux /u);
  assert.doesNotMatch(dockerfile, /^(?:ARG|ENV|USER)\b|corepack (?:enable|prepare)/imu);
  const rootPackage = JSON.parse(
    fs.readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
  );
  for (const name of ["acorn", "es-module-lexer", "@babel/parser"]) {
    const version = rootPackage.devDependencies[name] ?? rootPackage.dependencies[name];
    assert.match(version, /^\d+\.\d+\.\d+$/u);
    assert.ok(
      dockerfile.includes(` ${name}@${version}`),
      `${name} pin differs from the repository`,
    );
  }

  const nextRoot = temporaryDirectory();
  const nextEnvironment = {
    FRAMEWORK_ADAPTER: "nextjs",
    FRAMEWORK_RUNTIME: "edge",
    BUILD_OUTPUT_DIRECTORY: ".open-next/assets",
    SERVER_OUTPUT_DIRECTORY: ".ohmyhost-worker",
    SERVER_ENTRYPOINT: ".ohmyhost-worker/worker.js",
    COMPATIBILITY_DATE: "2026-08-21",
    COMPATIBILITY_FLAGS: "nodejs_compat",
  };
  const openNextConfigPath = path.join(nextRoot, ".ohmyhost-open-next.config.ts");
  // The configuration follows the built server files, which OpenNext then bundles unchanged.
  const requiredServerFiles = '{"config":{"cacheComponents":false,"experimental":{}}}';
  fs.mkdirSync(path.join(nextRoot, ".next"));
  fs.writeFileSync(path.join(nextRoot, ".next", "required-server-files.json"), requiredServerFiles);
  assert.equal(
    createOpenNextPlatformConfig({
      applicationRoot: nextRoot,
      outputPath: openNextConfigPath,
      environment: nextEnvironment,
    }),
    fs.realpathSync(openNextConfigPath),
  );
  const openNextConfig = fs.readFileSync(openNextConfigPath, "utf8");
  assert.match(
    openNextConfig,
    /\/opt\/ohmyhost-platform\/lib\/node_modules\/@opennextjs\/cloudflare\/dist\/api\/index\.js/u,
  );
  assert.match(openNextConfig, /static-assets-incremental-cache\.js/u);
  assert.match(
    openNextConfig,
    /\nexport default defineCloudflareConfig\(\{ incrementalCache, enableCacheInterception: true \}\);\n$/u,
  );
  assert.equal(
    fs.readFileSync(path.join(nextRoot, ".next", "required-server-files.json"), "utf8"),
    requiredServerFiles,
  );
  assert.doesNotMatch(openNextConfig, /(?:r2|kv|d1|token|secret)/iu);
  assert.equal(cleanupOpenNextPlatformConfig({ applicationRoot: nextRoot }), true);
  fs.writeFileSync(openNextConfigPath, "customer collision");
  assert.throws(
    () =>
      createOpenNextPlatformConfig({
        applicationRoot: nextRoot,
        outputPath: openNextConfigPath,
        environment: nextEnvironment,
      }),
    /input is invalid/u,
  );

  const scannerForms = [
    ["customer password", 'const password = "customer-password-value";'],
    ["customer token", 'const access_token = "customer-token-value";'],
    ["customer PEM", "-----BEGIN PRIVATE KEY-----\\ncustomer-owned\\n-----END PRIVATE KEY-----"],
    ["customer AWS-looking label", "AKIAABCDEFGHIJKLMNOP"],
  ];
  for (const [, customerContent] of scannerForms) {
    const fixture = staticPackageFixture();
    fs.writeFileSync(path.join(fixture.site, "dist", "index.html"), customerContent);
    fs.writeFileSync(path.join(fixture.site, "dist", "[customer-route].js"), "export {};");
    const manifest = packageBuildArtifact({
      applicationRoot: fixture.site,
      bundleRoot: fixture.bundle,
      dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
      packageManagerReceiptPath: fixture.packageManagerReceiptPath,
      compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
      environment: fixture.environment,
    });
    const custody = manifest.lifecycleEvidence.credentialScan;
    assert.equal(custody.findingsCount, 0);
    assert.match(custody.scannerSha256, /^[0-9a-f]{64}$/u);
    assert.match(custody.rulesSha256, /^[0-9a-f]{64}$/u);
    assert.notEqual(custody.scannerSha256, custody.rulesSha256);
    assert.equal(JSON.stringify(manifest).includes(customerContent), false);
    assert.equal(
      manifest.assets.some(({ path: assetPath }) => assetPath === "/[customer-route].js"),
      true,
    );
  }
  assert.doesNotThrow(() => execFileSync("bash", ["-n", output]));
  assert.throws(() => writeUserBuildScript(output), /output is invalid/u);
  fs.rmSync(output, { force: true });
});

test("writes one root-only bounded packaging script", () => {
  fs.mkdirSync("/tmp/ohmyho", { recursive: true });
  const output = "/tmp/ohmyho/root-package.sh";
  fs.rmSync(output, { force: true });
  writeRootPackageScript(output);
  const body = fs.readFileSync(output, "utf8");
  assert.equal(fs.statSync(output).mode & 0o777, 0o555);
  assert.match(body, /build-runtime\.mjs package \.ohmyhost-next-worker\.js\.gz/u);
  assert.match(
    body,
    /bundle\/manifest\.json\)" -le 1048576 \|\| \{ echo 'ohmyho\.st packaging: the deployment manifest is more than 1048576 bytes; fewer static files and Worker modules keep it smaller'; exit 1; \}/u,
  );
  assert.match(
    body,
    /bundle\/sbom\.cdx\.json\)" -le 4194304 \|\| \{ echo 'ohmyho\.st packaging: the dependency inventory \(SBOM\) is more than 4194304 bytes; fewer installed packages keep it smaller'; exit 1; \}/u,
  );
  assert.doesNotMatch(body, /container|rootfs/u);
  assert.doesNotMatch(body, /SOURCE_GET_URL|OUTPUT_PUT_URL/u);
  assert.doesNotThrow(() => execFileSync("bash", ["-n", output]));
  const probe = temporaryDirectory();
  const calls = path.join(probe, "calls");
  const script = path.join(probe, "root-package.sh");
  const metafile = path.join(probe, ".ohmyhost-next-metafile.json");
  fs.writeFileSync(metafile, "invalid evidence");
  fs.writeFileSync(
    script,
    body.replace('cd "$(cat /tmp/ohmyho/application-root)"', 'cd "$PACKAGING_PROBE_ROOT"'),
  );
  assert.throws(
    () =>
      execFileSync(
        "bash",
        [
          "-c",
          `node() {
  printf '%s\\n' "$2" >> "$PACKAGING_PROBE_CALLS"
  if test "$2" = validate-next-metafile; then return 23; fi
  return 0
}
export -f node
bash "$PACKAGING_PROBE_SCRIPT"`,
        ],
        {
          env: {
            PATH: process.env.PATH,
            FRAMEWORK_ADAPTER: "nextjs",
            FRAMEWORK_RUNTIME: "edge",
            PACKAGING_PROBE_ROOT: probe,
            PACKAGING_PROBE_CALLS: calls,
            PACKAGING_PROBE_SCRIPT: script,
          },
          stdio: "pipe",
        },
      ),
    (error) => error.status === 23,
  );
  assert.equal(fs.readFileSync(calls, "utf8"), "validate-next-metafile\n");
  assert.equal(fs.readFileSync(metafile, "utf8"), "invalid evidence");
  assert.throws(() => writeRootPackageScript(output), /output is invalid/u);
  fs.rmSync(output, { force: true });
});

test("dispatches the agent's commands and none of the retired upload commands", () => {
  const runtime = fileURLToPath(new URL("../build-runtime.mjs", import.meta.url));
  assert.equal(
    execFileSync(process.execPath, [runtime, "validate-root", "apps/site"], { encoding: "utf8" }),
    "apps/site",
  );
  for (const command of [
    "write-post-build-script",
    "build-failure-excerpt",
    "next-build-argument",
    "unknown",
  ]) {
    assert.throws(
      () =>
        execFileSync(process.execPath, [runtime, command, "/tmp/ohmyho/post-build.sh"], {
          stdio: "pipe",
        }),
      /build runtime command is invalid/u,
    );
  }
});

test("sanitizes terminal noise out of the build failure excerpt", () => {
  const noisy = Buffer.from(
    "\u001b[32mvite v6 building\u001b[0m\r\n" +
      "progress 10%\rprogress 50%\rprogress 100%\n" +
      "\u001b]0;title\u0007src/main.ts(3,1): error TS2304: Cannot find name 'foo'.   \n" +
      "\u0007bell\u0000null\ttab\u009f\n\n\n",
  );
  assert.deepEqual(createBuildFailureExcerpt(noisy, noisy.byteLength), {
    excerpt:
      "vite v6 building\nprogress 100%\nsrc/main.ts(3,1): error TS2304: Cannot find name 'foo'.\nbellnull\ttab",
    truncated: false,
  });
  const silent = Buffer.from("\u001b[0m\n\n");
  assert.throws(() => createBuildFailureExcerpt(silent, silent.byteLength), /no printable output/u);
  assert.throws(() => createBuildFailureExcerpt(silent, 2), /tail is invalid/u);
});

test("keeps only the newest lines of a long build log within the excerpt bounds", () => {
  const lines = Array.from({ length: 500 }, (_, index) => `line ${index}`.padEnd(100, "x"));
  const log = Buffer.from(`${lines.join("\n")}\n`);
  const bounded = createBuildFailureExcerpt(log, log.byteLength);
  const kept = bounded.excerpt.split("\n");
  assert.equal(bounded.truncated, true);
  assert.ok(kept.length <= 200);
  assert.ok(bounded.excerpt.length <= 16384);
  assert.equal(kept.at(-1), lines.at(-1));
  assert.ok(kept.every((line) => /^line \d+x+$/u.test(line)));
  const partial = Buffer.concat([Buffer.from([0xa4]), Buffer.from("tail\n")]);
  assert.deepEqual(createBuildFailureExcerpt(partial, 70000), { excerpt: "tail", truncated: true });
});

test("reads the build failure excerpt document from the log tail", () => {
  const logPath = path.join(temporaryDirectory(), "user-build.log");
  fs.writeFileSync(logPath, `${"earlier\n".repeat(20000)}npm ERR! missing script: build\n`);
  const document = readBuildFailureExcerpt({
    logPath,
    operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  assert.deepEqual(Object.keys(document), [
    "schemaVersion",
    "operationId",
    "excerpt",
    "truncated",
    "logBytes",
  ]);
  assert.equal(document.schemaVersion, "ohmyhost.build-failure/v1");
  assert.equal(document.operationId, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
  assert.equal(document.truncated, true);
  assert.equal(document.logBytes, 160031);
  assert.ok(document.excerpt.endsWith("earlier\nnpm ERR! missing script: build"));
  assert.ok(document.excerpt.split("\n").length <= 200);
  assert.equal(Object.isFrozen(document), true);

  const captured = "\u001b[31mfailed\u001b[0m\r\nsrc/main.ts(1,1): error TS2304\n";
  fs.writeFileSync(logPath, captured);
  assert.deepEqual(
    readBuildFailureExcerpt({ logPath, operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
    {
      schemaVersion: "ohmyhost.build-failure/v1",
      operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      excerpt: "failed\nsrc/main.ts(1,1): error TS2304",
      truncated: false,
      logBytes: Buffer.byteLength(captured),
    },
  );
  assert.throws(
    () => readBuildFailureExcerpt({ logPath, operationId: "not-a-ulid" }),
    /operation ID/u,
  );
  fs.writeFileSync(logPath, "");
  assert.throws(
    () => readBuildFailureExcerpt({ logPath, operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }),
    /no printable output/u,
  );
  assert.throws(
    () =>
      readBuildFailureExcerpt({
        logPath: path.join(path.dirname(logPath), "missing.log"),
        operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }),
    /ENOENT/u,
  );
});

test("accepts only SourceFetcher's optional first GitHub commit-comment PAX header", () => {
  const comment = Buffer.from(`52 comment=${"a".repeat(40)}\n`);
  const archive = zlib.gzipSync(
    Buffer.concat([
      tarEntry("pax_global_header", "g", comment),
      tarEntry("repository/package.json"),
      Buffer.alloc(1024),
    ]),
  );
  assert.deepEqual(validateSourceArchiveBytes(archive), {
    root: "repository",
    entries: 2,
    totalBytes: 1,
  });
  for (const invalidComment of [
    Buffer.from(`51 path=${"a".repeat(40)}\n`),
    Buffer.from(`52 comment=${"z".repeat(40)}\n`),
    Buffer.from(`53 comment=${"a".repeat(40)}\n`),
  ]) {
    const invalidArchive = zlib.gzipSync(
      Buffer.concat([
        tarEntry("pax_global_header", "g", invalidComment),
        tarEntry("repository/package.json"),
        Buffer.alloc(1024),
      ]),
    );
    assert.throws(() => validateSourceArchiveBytes(invalidArchive));
  }
});

test("root resolution admits exactly one lockfile matching an exact package manager", () => {
  const repository = temporaryDirectory();
  const site = path.join(repository, "site");
  fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, "package.json"), '{"packageManager":"pnpm@10.28.2"}\n');
  fs.writeFileSync(path.join(site, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  assert.equal(resolveApplicationRoot(repository, "site"), fs.realpathSync(site));
  assert.deepEqual(inspectPackageManager(site), {
    manager: "pnpm",
    version: "10.28.2",
    lockfile: "pnpm-lock.yaml",
    installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
    buildCommand: "pnpm run build",
  });
  // A committed OpenNext config is the customer's own; only the platform's config name is reserved.
  fs.writeFileSync(path.join(site, "open-next.config.ts"), "export default {};\n");
  assert.equal(resolveApplicationRoot(repository, "site"), fs.realpathSync(site));
  fs.writeFileSync(path.join(site, ".ohmyhost-open-next.config.ts"), "export default {};\n");
  assert.throws(() => resolveApplicationRoot(repository, "site"), /reserved platform build path/u);
  fs.rmSync(path.join(site, ".ohmyhost-open-next.config.ts"));

  fs.writeFileSync(path.join(site, "package-lock.json"), "{}\n");
  assert.throws(() => resolveApplicationRoot(repository, "site"), /lockfile is invalid/u);
  fs.rmSync(path.join(site, "package-lock.json"));
  fs.writeFileSync(path.join(site, "package.json"), '{"packageManager":"npm@10"}\n');
  assert.throws(() => resolveApplicationRoot(repository, "site"), /package manager is invalid/u);
  fs.writeFileSync(path.join(site, "package.json"), '{"packageManager":"npm@10.9.3"}\n');
  assert.throws(() => resolveApplicationRoot(repository, "site"), /lockfile is invalid/u);

  const outside = temporaryDirectory();
  fs.mkdirSync(path.join(outside, "web"));
  fs.symlinkSync(path.join(outside, "web"), path.join(repository, "linked"));
  assert.throws(() => resolveApplicationRoot(repository, "linked"), /ancestry is unsafe/u);

  fs.linkSync(path.join(site, "package.json"), path.join(repository, "package-copy.json"));
  assert.throws(() => resolveApplicationRoot(repository, "site"), /package.json is unsafe/u);
});

test("binds all supported managers to their exact plan commands in a root-owned receipt", () => {
  const fixtures = [
    ["bun@1.2.22", "bun.lock", "bun install --frozen-lockfile --ignore-scripts", "bun run build"],
    ["npm@10.9.3", "package-lock.json", "npm ci --ignore-scripts", "npm run build"],
    [
      "pnpm@10.28.2",
      "pnpm-lock.yaml",
      "pnpm install --frozen-lockfile --ignore-scripts",
      "pnpm run build",
    ],
    ["yarn@4.9.2", "yarn.lock", "yarn install --immutable --mode=skip-build", "yarn run build"],
  ];
  for (const [declaration, lockfile, installCommand, buildCommand] of fixtures) {
    const root = temporaryDirectory();
    const outputPath = path.join(root, "receipt.json");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ packageManager: declaration }),
    );
    fs.writeFileSync(path.join(root, lockfile), "lock");
    const receipt = writePackageManagerReceipt({
      applicationRoot: root,
      installCommand,
      buildCommand,
      outputPath,
    });
    assert.equal(receipt.manager, declaration.split("@")[0]);
    assert.deepEqual(readPackageManagerReceipt(outputPath), receipt);
    assert.throws(
      () => inspectPackageManager(root, { installCommand: `${installCommand}; id`, buildCommand }),
      /build command is invalid/u,
    );
  }
});

test("refuses a package-manager receipt whose version is an array instead of a string", () => {
  const root = temporaryDirectory();
  const outputPath = path.join(root, "receipt.json");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ packageManager: "npm@10.9.3" }),
  );
  fs.writeFileSync(path.join(root, "package-lock.json"), "lock");
  const receipt = writePackageManagerReceipt({
    applicationRoot: root,
    installCommand: "npm ci --ignore-scripts",
    buildCommand: "npm run build",
    outputPath,
  });
  // An array would pass the declaration test as its single string, so the receipt must name a string version.
  const forged = path.join(root, "forged-receipt.json");
  fs.writeFileSync(forged, JSON.stringify({ ...receipt, version: [receipt.version] }));
  assert.throws(() => readPackageManagerReceipt(forged), /package manager receipt is invalid/u);
});

test("rechecks the shared framework build script and executed Bun pin before user code", () => {
  for (const script of [
    "vite build && tsc --noEmit",
    "tsc -b && vite build",
    "vite build && curl https://example.com",
  ]) {
    const root = temporaryDirectory();
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.28.2", scripts: { build: script } }),
    );
    fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lock");
    const run = () =>
      writePackageManagerReceipt({
        applicationRoot: root,
        installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
        buildCommand: "pnpm run build",
        outputPath: path.join(root, "verified-receipt.json"),
        environment: { FRAMEWORK_ADAPTER: "vite-static", FRAMEWORK_RUNTIME: "edge" },
      });
    if (script.includes("curl")) assert.throws(run, /framework build script is invalid/u);
    else assert.doesNotThrow(run);
  }
  const root = temporaryDirectory();
  fs.writeFileSync(path.join(root, "package.json"), '{"packageManager":"bun@1.2.21"}');
  fs.writeFileSync(path.join(root, "bun.lock"), "lock");
  assert.throws(() => inspectPackageManager(root), /Bun version must be 1\.2\.22/u);
  const yarnRoot = temporaryDirectory();
  fs.writeFileSync(path.join(yarnRoot, "package.json"), '{"packageManager":"yarn@1.22.22"}');
  fs.writeFileSync(path.join(yarnRoot, "yarn.lock"), "lock");
  assert.throws(() => inspectPackageManager(yarnRoot), /Yarn version must be 3\.0\.0 or later/u);
});

test("runtime policy packaging accepts only canonical public HTTPS origins", () => {
  assert.deepEqual(
    validateRuntimePolicyJson(
      '{"healthCheckPath":"/ready","egressAllowedOrigins":["https://api.example.test","https://mail.example.test"]}',
    ),
    {
      healthCheckPath: "/ready",
      egressAllowedOrigins: ["https://api.example.test", "https://mail.example.test"],
    },
  );
  for (const policy of [
    '{"healthCheckPath":"ready","egressAllowedOrigins":[]}',
    '{"healthCheckPath":"/","egressAllowedOrigins":["http://api.example.test"]}',
    '{"healthCheckPath":"/","egressAllowedOrigins":["https://127.0.0.1"]}',
    '{"healthCheckPath":"/","egressAllowedOrigins":["https://mail.example.test:8443"]}',
    '{"healthCheckPath":"/","egressAllowedOrigins":["https://203.0.113.10"]}',
    '{"healthCheckPath":"/","egressAllowedOrigins":["https://ohmyho-storage-gateway-decoy.test.workers.dev"]}',
    '{"healthCheckPath":"/","egressAllowedOrigins":["https://s1-01arz3ndektsv4rrffq69g5fav.01arz3ndektsv4rrffq69g5faw-01arz3ndektsv4rrffq69g5fax.ohmyho-storage-gateway-production.your-omh-account.workers.dev"]}',
    '{"healthCheckPath":"/","egressAllowedOrigins":["https://bad.prefix.ohmyho-storage-gateway-production.your-omh-account.workers.dev"]}',
    '{"healthCheckPath":"/","egressAllowedOrigins":["https://bad.prefix.ohmyho-mail-gateway-production.your-omh-account.workers.dev"]}',
    '{"healthCheckPath":"/","egressAllowedOrigins":["https://my_api.example.test"]}',
    '{"healthCheckPath":"/","egressAllowedOrigins":["https://example.test."]}',
    '{"healthCheckPath":"/","egressAllowedOrigins":["https://intranet"]}',
    `{"healthCheckPath":"/","egressAllowedOrigins":["https://${"a".repeat(64)}.example.test"]}`,
    '{"healthCheckPath":"/","egressAllowedOrigins":["https://a.-b.example.test"]}',
    '{"healthCheckPath":"/","egressAllowedOrigins":["https://b.example.test","https://a.example.test"]}',
    '{"healthCheckPath":"/","egressAllowedOrigins":[],"extra":true}',
  ]) {
    assert.throws(() => validateRuntimePolicyJson(policy), /runtime policy is invalid/u);
  }
});

test("preserves the complete browser policy separately from server egress in the artifact", () => {
  const browser = normalizeBrowserPolicy({
    connect: ["https://browser.example.test"],
    workers: { self: true },
    cors: { origins: ["https://consumer.example.test"], credentials: true },
  });
  const policy = {
    healthCheckPath: "/",
    egressAllowedOrigins: ["https://server.example.test"],
    browser,
  };
  assert.deepEqual(validateRuntimePolicyJson(JSON.stringify(policy)), policy);
  assert.throws(
    () => validateRuntimePolicyJson(JSON.stringify({ ...policy, browser: { connect: ["*"] } })),
    /policy/u,
  );
  const fixture = viteCompanionPackageFixture();
  fixture.environment.RUNTIME_POLICY_JSON = JSON.stringify(policy);
  const manifest = packageBuildArtifact({
    applicationRoot: fixture.site,
    bundleRoot: fixture.bundle,
    dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
    packageManagerReceiptPath: fixture.packageManagerReceiptPath,
    compressedWorkerPath: ".unused.gz",
    migrationSnapshotRoot: path.join(fixture.site, "migrations"),
    environment: fixture.environment,
  });
  assert.deepEqual(manifest.runtimePolicy, policy);
});

test("customer auth packaging accepts only the canonical project-local contract", () => {
  assert.deepEqual(validateCustomerAuthRequirementJson('{"provider":"none"}'), {
    provider: "none",
  });
  const native =
    '{"provider":"omh-native","routePath":"/api/auth/v1","bindingName":"OHMYHOST_AUTH"}';
  assert.deepEqual(validateCustomerAuthRequirementJson(native), JSON.parse(native));
  const enabled =
    '{"provider":"better-auth","version":"1.7.7","deployment":"embedded","routePath":"/api/auth","databaseSchema":"auth","databaseBindingName":"OHMYHOST_DATABASE","authSecretName":"BETTER_AUTH_SECRET"}';
  assert.deepEqual(validateCustomerAuthRequirementJson(enabled), JSON.parse(enabled));
  for (const invalid of [
    '{"provider":"better-auth","version":"latest"}',
    '{"provider":"better-auth","version":"1.7.7","deployment":"embedded","routePath":"/api/auth","databaseSchema":"auth","databaseBindingName":"HYPERDRIVE","authSecretName":"BETTER_AUTH_SECRET"}',
    '{"provider":"none","secret":"forbidden"}',
    '{ "provider": "none" }',
    '{"provider":"omh-native"}',
    '{"provider":"omh-native","routePath":"/api/auth","bindingName":"OHMYHOST_AUTH"}',
    '{"provider":"omh-native","routePath":"/api/auth/v1","bindingName":"OTHER"}',
    '{"provider":"omh-native","routePath":"/api/auth/v1","bindingName":"OHMYHOST_AUTH","extra":true}',
    '{"bindingName":"OHMYHOST_AUTH","provider":"omh-native","routePath":"/api/auth/v1"}',
    '{ "provider":"omh-native","routePath":"/api/auth/v1","bindingName":"OHMYHOST_AUTH"}',
  ]) {
    assert.throws(() => validateCustomerAuthRequirementJson(invalid), /customer auth requirement/u);
  }
});

test("storage packaging accepts only the canonical private R2 contract", () => {
  assert.deepEqual(validateStorageRequirementJson('{"enabled":false}'), { enabled: false });
  const enabled = '{"enabled":true,"provider":"r2","jurisdiction":"us","public":false}';
  assert.deepEqual(validateStorageRequirementJson(enabled), JSON.parse(enabled));
  for (const invalid of [
    '{"enabled":true,"provider":"s3","jurisdiction":"eu","public":false}',
    '{"enabled":true,"provider":"r2","jurisdiction":"default","public":false}',
    '{"enabled":true,"provider":"r2","jurisdiction":"eu","public":true}',
    '{ "enabled": false }',
  ]) {
    assert.throws(() => validateStorageRequirementJson(invalid), /storage requirement/u);
  }
});

test("declared crons accept only one to eight unique ascending five-field UTC schedules", () => {
  const value = '{"crons":["*/5 * * * *","0 3 * * *"]}';
  assert.deepEqual(validateFunctionsRequirementJson(value), {
    crons: ["*/5 * * * *", "0 3 * * *"],
  });
  for (const invalid of [
    '{"crons":[]}',
    '{"crons":["0 3 * * *","*/5 * * * *"]}',
    '{"crons":["0 3 * * *","0 3 * * *"]}',
    '{"crons":["*/4 * * * *"]}',
    '{"crons":["* * * * *"]}',
    '{"crons":["0 24 * * *"]}',
    '{"crons":["0 3 * * *"],"extra":true}',
    '{ "crons":["0 3 * * *"]}',
    `{"crons":[${Array.from({ length: 9 }, (_, index) => `"${index} * * * *"`).join(",")}]}`,
    '{"delivery":"at-least-once","timeoutSeconds":120,"maxAttempts":3,"scheduled":[]}',
  ]) {
    assert.throws(
      () => validateFunctionsRequirementJson(invalid),
      /functions requirement is invalid/u,
    );
  }
});

test("rejects hardlinked Next.js and TanStack framework configuration before consumption", () => {
  const nextRoot = temporaryDirectory();
  const nextConfig = path.join(nextRoot, "wrangler.jsonc");
  fs.writeFileSync(nextConfig, "{}\n");
  fs.linkSync(nextConfig, path.join(nextRoot, "wrangler-copy.jsonc"));
  assert.throws(
    () =>
      validateNextWorkerConfig({
        applicationRoot: nextRoot,
        configPath: "wrangler.jsonc",
        environment: { COMPATIBILITY_DATE: "2026-08-21" },
      }),
    /Next.js Worker config is unsafe/u,
  );

  const repository = temporaryDirectory();
  const applicationRoot = path.join(repository, "site");
  const bundleRoot = path.join(repository, "bundle");
  fs.mkdirSync(path.join(applicationRoot, "dist", "client"), { recursive: true });
  fs.mkdirSync(path.join(applicationRoot, "dist", "server"), { recursive: true });
  fs.mkdirSync(path.join(bundleRoot, "assets"), { recursive: true });
  fs.mkdirSync(path.join(bundleRoot, "worker"), { recursive: true });
  fs.writeFileSync(path.join(repository, "ohmyhost.yaml"), "applicationRoot: site\n");
  fs.writeFileSync(
    path.join(applicationRoot, "package.json"),
    '{"name":"edge","packageManager":"pnpm@10.28.2"}\n',
  );
  fs.writeFileSync(path.join(applicationRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const packageManagerReceiptPath = path.join(repository, "package-manager.json");
  writePackageManagerReceipt({
    applicationRoot,
    installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
    buildCommand: "pnpm run build",
    outputPath: packageManagerReceiptPath,
  });
  fs.writeFileSync(path.join(applicationRoot, ".ohmyhost-resolved-dependencies.json"), "[]\n");
  fs.writeFileSync(
    path.join(applicationRoot, "dist", "client", ".assetsignore"),
    "wrangler.json\n.dev.vars\n",
  );
  fs.writeFileSync(
    path.join(applicationRoot, "dist", "client", "index.html"),
    "<!doctype html><title>root origin</title>",
  );
  fs.writeFileSync(path.join(applicationRoot, "dist", "server", "index.js"), "export default {}\n");
  const generatedConfig = path.join(applicationRoot, "dist", "server", "wrangler.json");
  fs.writeFileSync(generatedConfig, "{}\n");
  fs.linkSync(generatedConfig, path.join(repository, "generated-config-copy.json"));
  assert.throws(
    () =>
      packageBuildArtifact({
        applicationRoot,
        bundleRoot,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath,
        compressedWorkerPath: ".unused.gz",
        environment: {
          APPLICATION_ROOT: "site",
          RUNTIME_POLICY_JSON: '{"healthCheckPath":"/","egressAllowedOrigins":[]}',
          DATABASE_REQUIREMENT_JSON: '{"enabled":false}',
          AUTH_REQUIREMENT_JSON: '{"provider":"none"}',
          MAIL_REQUIREMENT_JSON: '{"enabled":false}',
          STORAGE_REQUIREMENT_JSON: '{"enabled":false}',
          BUILD_OUTPUT_DIRECTORY: "dist/client",
          FRAMEWORK_ADAPTER: "tanstack-start",
          FRAMEWORK_RUNTIME: "edge",
          SERVER_OUTPUT_DIRECTORY: "dist/server",
          SERVER_ENTRYPOINT: "dist/server/index.js",
          SERVER_CONFIG_PATH: "dist/server/wrangler.json",
          COMPATIBILITY_DATE: "2026-08-21",
          COMPATIBILITY_FLAGS: "nodejs_compat",
          PROJECT_ID: "01J00000000000000000000001",
          ENVIRONMENT_ID: "01J00000000000000000000002",
          DEPLOYMENT_ID: "01J00000000000000000000004",
          OPERATION_ID: "01J00000000000000000000003",
          BUILD_ID: "ohmyho-sandbox-vite:12345678-1234-1234-1234-123456789abc",
          BUILD_INPUT_FINGERPRINT: `sha256:${"d".repeat(64)}`,
          INSTALL_COMMAND: "pnpm install --frozen-lockfile --ignore-scripts",
          BUILD_COMMAND: "pnpm run build",
          SOURCE_COMMIT_SHA: "c".repeat(40),
          EXPECTED_SOURCE_SHA256: "a".repeat(64),
          BUILD_PLAN_SHA256: "b".repeat(64),
        },
      }),
    /generated Worker config is unsafe/u,
  );
});

test("accepts comment-free Next.js JSONC trailing commas and rejects comments", () => {
  const root = temporaryDirectory();
  const configPath = path.join(root, "wrangler.jsonc");
  const config = `{
    "$schema": "./node_modules/wrangler/config-schema.json",
    "name": "thomas-restaurant-next",
    "main": ".open-next/worker.js",
    "compatibility_date": "2026-08-21",
    "compatibility_flags": ["nodejs_compat"],
    "assets": {
      "directory": ".open-next/assets",
      "binding": "ASSETS",
      "run_worker_first": true,
    },
  }`;
  fs.writeFileSync(configPath, config);

  assert.equal(
    validateNextWorkerConfig({
      applicationRoot: root,
      configPath: "wrangler.jsonc",
      environment: { COMPATIBILITY_DATE: "2026-08-21" },
    }).name,
    "thomas-restaurant-next",
  );
  fs.writeFileSync(configPath, config.replace("{\n", "{\n    // forbidden\n"));
  assert.throws(
    () =>
      validateNextWorkerConfig({
        applicationRoot: root,
        configPath: "wrangler.jsonc",
        environment: { COMPATIBILITY_DATE: "2026-08-21" },
      }),
    /comment/u,
  );
});

test("refuses a platform Next.js config that still declares the Images binding", () => {
  const root = temporaryDirectory();
  const configPath = path.join(root, "wrangler.jsonc");
  fs.writeFileSync(
    configPath,
    `{
    "$schema": "./node_modules/wrangler/config-schema.json",
    "name": "thomas-restaurant-next",
    "main": ".open-next/worker.js",
    "compatibility_date": "2026-08-21",
    "compatibility_flags": ["nodejs_compat"],
    "assets": { "directory": ".open-next/assets", "binding": "ASSETS", "run_worker_first": true },
    "images": { "binding": "IMAGES" },
  }`,
  );
  assert.throws(
    () =>
      validateNextWorkerConfig({
        applicationRoot: root,
        configPath: "wrangler.jsonc",
        environment: { COMPATIBILITY_DATE: "2026-08-21" },
      }),
    /shape is invalid/u,
  );
});

test("generates the fixed platform-owned Next.js Wrangler config and rejects collisions", () => {
  const root = temporaryDirectory();
  const outputPath = path.join(root, ".ohmyhost-next-wrangler.jsonc");
  const environment = {
    FRAMEWORK_ADAPTER: "nextjs",
    FRAMEWORK_RUNTIME: "edge",
    BUILD_OUTPUT_DIRECTORY: ".open-next/assets",
    SERVER_OUTPUT_DIRECTORY: ".ohmyhost-worker",
    SERVER_ENTRYPOINT: ".ohmyhost-worker/worker.js",
    COMPATIBILITY_DATE: "2026-08-21",
    COMPATIBILITY_FLAGS: "nodejs_compat",
  };
  assert.deepEqual(createNextPlatformConfig({ applicationRoot: root, outputPath, environment }), {
    name: "ohmyhost-platform-next-build",
    main: ".open-next/worker.js",
    compatibility_date: "2026-08-21",
    compatibility_flags: ["nodejs_compat"],
    keep_names: false,
    assets: { directory: ".open-next/assets", binding: "ASSETS", run_worker_first: true },
  });
  assert.throws(
    () => createNextPlatformConfig({ applicationRoot: root, outputPath, environment }),
    /input is invalid/u,
  );
});

function nextCacheFixture() {
  const applicationRoot = temporaryDirectory();
  fs.mkdirSync(path.join(applicationRoot, ".next"), { recursive: true });
  fs.mkdirSync(path.join(applicationRoot, "src", "app", "notes", "[slug]"), { recursive: true });
  fs.mkdirSync(path.join(applicationRoot, "src", "lib"), { recursive: true });
  fs.mkdirSync(path.join(applicationRoot, ".open-next", "cache", "build-id", "notes"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(applicationRoot, ".open-next", "assets"), { recursive: true });
  const manifest = {
    version: 4,
    routes: { "/notes/known": { initialRevalidateSeconds: false, srcRoute: "/notes/[slug]" } },
    dynamicRoutes: { "/notes/[slug]": { fallback: false } },
  };
  fs.writeFileSync(
    path.join(applicationRoot, ".next", "prerender-manifest.json"),
    JSON.stringify(manifest),
  );
  fs.writeFileSync(
    path.join(applicationRoot, ".next", "required-server-files.json"),
    '{"config":{"cacheComponents":false}}',
  );
  fs.writeFileSync(
    path.join(applicationRoot, "tsconfig.json"),
    '{/* JSONC */ "compilerOptions":{"paths":{"@/*":["./src/*"]}}}',
  );
  fs.writeFileSync(
    path.join(applicationRoot, "src", "app", "notes", "[slug]", "page.tsx"),
    'import { read } from "@/lib/content"; export const dynamicParams = false; export const revalidate = 0; export default function Page() { return <p>{read()}</p>; }',
  );
  fs.writeFileSync(
    path.join(applicationRoot, "src", "lib", "content.ts"),
    'import { unstable_noStore } from "next/cache"; export function read(): string { unstable_noStore(); return "known"; }',
  );
  const entry = {
    type: "app",
    html: "<!doctype html><p>known</p>",
    rsc: "known-flight",
    meta: { status: 200, headers: {} },
  };
  fs.writeFileSync(
    path.join(applicationRoot, ".open-next", "cache", "build-id", "notes", "known.cache"),
    JSON.stringify(entry),
  );
  return { applicationRoot, manifest, entry };
}

const NEXT_REVALIDATION_LINE =
  "ohmyho.st packaging: Next.js on-demand or time-based revalidation is not supported by this read-only hosting cache. Import functions from next/cache by name and leave out revalidateTag, revalidatePath, updateTag, unstable_expireTag, unstable_expirePath and unstable_cache, remove res.revalidate and fetch next.revalidate values other than 0 or false, then commit, push and deploy the new commit.";
const NEXT_PRERENDER_REVALIDATION_LINE =
  "ohmyho.st packaging: Next.js time-based revalidation of prerendered pages and route handlers is not supported by this read-only hosting cache. Keep build-time static pages or ordinary request-time rendering: remove revalidate values other than 0 or false from route segment config, getStaticProps and fetch next options, then commit, push and deploy the new commit.";
const NEXT_SHELL_REVALIDATION_LINE =
  'ohmyho.st packaging: Next.js time-based revalidation of prerendered pages and route handlers is not supported by this read-only hosting cache: a revalidate setting or a "use cache" value in a Cache Components static shell would stay frozen until the next deployment. Call cached functions inside a Suspense boundary after reading request data (for example await connection()), give build-time values cacheLife({ revalidate: Infinity, expire: Infinity }), or remove the revalidation, then commit, push and deploy the new commit.';
const NEXT_BLOCKING_PRERENDER_LINE =
  "ohmyho.st packaging: Next.js Cache Components pages that are prerendered while a visitor waits are not supported by this hosting: Workers stop such a request and later requests for the same page. Give each dynamic page a static shell by reading params inside a Suspense boundary, without ensureStatic and without a root layout inside a dynamic segment; with partialPrefetching: true, also remove generateStaticParams from dynamic pages, then commit, push and deploy the new commit.";

test("admits Cache Components shells and request-time use cache while rejecting revalidation and pages prerendered while a visitor waits", () => {
  const fixture = nextCacheFixture();
  assert.deepEqual(validateNextCacheSupport(fixture), { routes: 2, sourceFiles: 2 });
  const failureLine = () => {
    try {
      validateNextCacheSupport(fixture);
    } catch (error) {
      return packagingFailureLine(error);
    }
    return null;
  };
  const supportSource = path.join(fixture.applicationRoot, "src", "lib", "content.ts");
  const invalidSources = [
    'import { revalidatePath as refresh } from "next/cache"; export function read(){refresh("/notes/known");}',
    'export { revalidateTag } from "next/cache";',
    'export async function read(){const cache = await import("next/cache"); cache.updateTag("note");}',
    'const cache = require("next/cache"); export function read(){cache.revalidatePath("/");}',
    'import { cacheLife, updateTag } from "next/cache"; export async function save(){"use server"; updateTag("note");}',
    'import { unstable_cache } from "next/cache"; export const read = unstable_cache(async () => "data");',
    'import { unstable_expireTag } from "next/cache"; export function read(){unstable_expireTag("note");}',
    'import * as cache from "next/cache"; export function read(){cache.cacheLife("hours");}',
    'import cache, { cacheLife } from "next/cache"; export function read(){cacheLife("hours"); cache.revalidateTag("note");}',
    'export * from "next/cache";',
    'export * as cache from "next/cache";',
    'export { cacheLife, unstable_expirePath as expire } from "next/cache";',
    'import type { NextApiResponse } from "next"; export function read(res: NextApiResponse){return res.revalidate("/notes/known");}',
    'export async function read(){return fetch("https://example.com", {next:{revalidate:60}});}',
  ];
  for (const source of invalidSources) {
    fs.writeFileSync(supportSource, source);
    assert.equal(failureLine(), NEXT_REVALIDATION_LINE, source);
  }
  // Cache Components' "use cache" directives, cacheLife and cacheTag are request-time or build-time
  // caches the deployment never refreshes; the prerendered routes below decide whether one is frozen.
  // io, navigation and prefetch only place rendering, and refresh only refreshes a client router.
  for (const source of [
    '/* revalidatePath("/") */ const example = "next/cache"; export function read(){return example;}',
    'import { cacheLife, cacheTag, unstable_noStore } from "next/cache"; export async function read(){"use cache"; cacheLife("hours"); cacheTag("notes"); return "cached";}',
    'import { unstable_cacheLife as life, unstable_cacheTag } from "next/cache"; export async function read(){"use cache: remote"; life("max"); unstable_cacheTag("notes"); return "cached";}',
    'import { cookies } from "next/headers"; export async function read(){"use cache: private"; return (await cookies()).get("note")?.value;}',
    'import { io, navigation, prefetch, refresh } from "next/cache"; export async function read(){await io(); await navigation(); await prefetch(); return "data";} export async function save(){"use server"; refresh();}',
    'export { cacheLife, cacheTag as tag, type CacheHandler, unstable_noStore } from "next/cache";',
  ]) {
    fs.writeFileSync(supportSource, source);
    assert.equal(failureLine(), null, source);
  }
  const writeManifest = () =>
    fs.writeFileSync(
      path.join(fixture.applicationRoot, ".next", "prerender-manifest.json"),
      JSON.stringify(fixture.manifest),
    );
  const known = fixture.manifest.routes["/notes/known"];
  const dynamic = fixture.manifest.dynamicRoutes["/notes/[slug]"];
  for (const [route, field, value] of [
    [known, "initialRevalidateSeconds", 0],
    [known, "initialRevalidateSeconds", 60],
    [known, "initialExpireSeconds", 86400],
    [dynamic, "fallbackRevalidate", 60],
    [dynamic, "fallbackExpire", 86400],
  ]) {
    route[field] = value;
    writeManifest();
    assert.equal(failureLine(), NEXT_PRERENDER_REVALIDATION_LINE, `${field} ${String(value)}`);
    Reflect.deleteProperty(route, field);
  }
  // The runtime CLI writes exactly the packaging line to the stderr the build log keeps, no stack.
  known.initialRevalidateSeconds = 900;
  known.initialExpireSeconds = 31536000;
  writeManifest();
  const validate = () =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../build-runtime.mjs", import.meta.url)), "next-cache-validate"],
      { cwd: fixture.applicationRoot, env: { PATH: process.env.PATH }, encoding: "utf8" },
    );
  const cli = validate();
  assert.deepEqual(
    [cli.status, cli.stdout, cli.stderr],
    [1, "", `${NEXT_PRERENDER_REVALIDATION_LINE}\n`],
  );
  assert.doesNotMatch(cli.stderr, /\/tmp\/|example\.com|notes\/known/u);

  // A Cache Components build marks every page partially static, and Next.js 16.3 also sets the
  // automatic experimental.ppr flag; shells without time-based revalidation are admitted.
  const required = path.join(fixture.applicationRoot, ".next", "required-server-files.json");
  fs.writeFileSync(required, '{"config":{"cacheComponents":true,"experimental":{"ppr":true}}}');
  Object.assign(known, {
    renderingMode: "PARTIALLY_STATIC",
    experimentalPPR: true,
    initialRevalidateSeconds: false,
  });
  delete known.initialExpireSeconds;
  Object.assign(dynamic, { fallbackRevalidate: false, experimentalPPR: true });
  writeManifest();
  assert.deepEqual(validateNextCacheSupport(fixture), { routes: 2, sourceFiles: 2 });
  const admitted = validate();
  assert.deepEqual([admitted.status, admitted.stderr], [0, ""]);
  known.initialRevalidateSeconds = 3600;
  writeManifest();
  assert.equal(failureLine(), NEXT_SHELL_REVALIDATION_LINE);
  known.initialRevalidateSeconds = false;

  // Workers stop a Cache Components page that Next.js prerenders while the visitor waits, and later
  // requests for that page wait on it. Next.js does so for new params of an open page without a
  // static shell and, with Partial Prefetching, of an open page with generated params; a route
  // handler, a page with closed params or a shell without generated params never blocks.
  const page = (route) => ({
    renderingMode: "PARTIALLY_STATIC",
    experimentalPPR: true,
    fallbackRootParams: [],
    ...route,
  });
  const generated = [{ paramName: "slug", paramType: "dynamic" }];
  fixture.manifest.dynamicRoutes["/api/items/[id]"] = { renderingMode: "STATIC", fallback: null };
  for (const [config, route, accepted] of [
    ["{}", { fallback: null, remainingPrerenderableParams: generated }, false],
    ["{}", { fallback: null, fallbackRootParams: ["lang"] }, false],
    ["{}", { fallback: "/posts/[slug]", remainingPrerenderableParams: generated }, true],
    ["{}", { fallback: false, remainingPrerenderableParams: generated }, true],
    ['{"partialPrefetching":true}', { fallback: null }, false],
    ['{"partialPrefetching":true}', { fallback: "/posts/[slug]" }, true],
    [
      '{"partialPrefetching":true}',
      { fallback: "/posts/[slug]", remainingPrerenderableParams: [] },
      true,
    ],
    [
      '{"partialPrefetching":true}',
      { fallback: "/posts/[slug]", remainingPrerenderableParams: generated },
      false,
    ],
    [
      '{"partialPrefetching":true}',
      { fallback: "/posts/[slug]", remainingPrerenderableParams: {} },
      false,
    ],
    [
      '{"partialPrefetching":"unstable_eager"}',
      { fallback: "/posts/[slug]", remainingPrerenderableParams: generated },
      false,
    ],
    [
      '{"partialPrefetching":true}',
      { fallback: false, remainingPrerenderableParams: generated },
      true,
    ],
  ]) {
    fs.writeFileSync(
      required,
      JSON.stringify({ config: { cacheComponents: true, ...JSON.parse(config) } }),
    );
    fixture.manifest.dynamicRoutes["/posts/[slug]"] = page(route);
    writeManifest();
    assert.equal(
      failureLine(),
      accepted ? null : NEXT_BLOCKING_PRERENDER_LINE,
      `${config} ${JSON.stringify(route)}`,
    );
  }
  assert.deepEqual(validateNextCacheSupport(fixture), { routes: 4, sourceFiles: 2 });

  // Partial prerendering without Cache Components has no platform configuration and stays refused.
  for (const config of ['{"config":{"experimental":{"ppr":true}}}', '{"config":{}}']) {
    fs.writeFileSync(required, config);
    assert.throws(() => validateNextCacheSupport(fixture), /partial prerendering requires/u);
  }
  // Without Cache Components a page rendered on request for new params is built as before.
  fixture.manifest.routes["/notes/known"] = {
    initialRevalidateSeconds: false,
    srcRoute: "/notes/[slug]",
  };
  fixture.manifest.dynamicRoutes["/posts/[slug]"] = { fallback: null };
  writeManifest();
  fs.writeFileSync(required, '{"config":{"cacheComponents":false}}');
  assert.equal(failureLine(), null);
});

test("rejects cache.js invalidators while retaining cache.js noStore and ordinary revalidate app data", () => {
  const fixture = nextCacheFixture();
  const source = path.join(fixture.applicationRoot, "src", "lib", "content.ts");
  for (const body of [
    'import { revalidatePath as refresh } from "next/cache.js"; export function read(){refresh("/");}',
    'export { revalidateTag } from "next/cache.js";',
  ]) {
    fs.writeFileSync(source, body);
    assert.throws(() => validateNextCacheSupport(fixture), PackagingLimitError);
  }
  for (const body of [
    'import { unstable_noStore } from "next/cache.js"; export function read(){unstable_noStore(); return "data";}',
    'import { cacheLife } from "next/cache.js"; export async function read(){"use cache"; cacheLife("days"); return "data";}',
    'export { cacheLife } from "next/cache.js";',
    "export function read(){const payload={revalidate:60}; return payload;}",
    'export function read(){const service={revalidate(){return "data"}}; return service.revalidate();}',
    "export function read(){const options={next:{revalidate:60}}; return options;}",
    'export function read(res){return res.revalidate("ordinary business method");}',
  ]) {
    fs.writeFileSync(source, body);
    assert.doesNotThrow(() => validateNextCacheSupport(fixture));
  }
});

test("enables only revalidatePath with an explicit writable-cache plan", () => {
  const fixture = nextCacheFixture();
  const source = path.join(fixture.applicationRoot, "src", "lib", "content.ts");
  const enabled = { ...fixture, environment: { NEXT_REVALIDATE_PATH: "1" } };
  fs.writeFileSync(
    source,
    'import { revalidatePath } from "next/cache"; export function read(){ revalidatePath("/notes/known"); }',
  );
  assert.throws(() => validateNextCacheSupport(fixture), PackagingLimitError);
  assert.doesNotThrow(() => validateNextCacheSupport(enabled));
  for (const rejected of [
    'import { revalidateTag } from "next/cache"; export function read(){revalidateTag("note");}',
    'import { revalidatePath, revalidateTag } from "next/cache"; export function read(){revalidatePath("/");}',
    'export async function read(){const cache = await import("next/cache"); cache.revalidatePath("/");}',
    'export function read(){ return fetch("https://example.test",{next:{revalidate:60}}); }',
  ]) {
    fs.writeFileSync(source, rejected);
    assert.throws(() => validateNextCacheSupport(enabled), PackagingLimitError, rejected);
  }
  assert.throws(
    () => validateNextCacheSupport({ ...fixture, environment: { NEXT_REVALIDATE_PATH: "true" } }),
    /Next.js cache mode is invalid/u,
  );
  const config = path.join(fixture.applicationRoot, ".ohmyhost-open-next.config.ts");
  createOpenNextPlatformConfig({
    applicationRoot: fixture.applicationRoot,
    outputPath: config,
    environment: {
      FRAMEWORK_ADAPTER: "nextjs",
      FRAMEWORK_RUNTIME: "edge",
      BUILD_OUTPUT_DIRECTORY: ".open-next/assets",
      SERVER_OUTPUT_DIRECTORY: ".ohmyhost-worker",
      SERVER_ENTRYPOINT: ".ohmyhost-worker/worker.js",
      COMPATIBILITY_DATE: "2026-08-21",
      COMPATIBILITY_FLAGS: "nodejs_compat",
      NEXT_REVALIDATE_PATH: "1",
    },
  });
  const output = fs.readFileSync(config, "utf8");
  assert.match(output, /next-writable-cache\.mjs/u);
  assert.match(output, /tagCache/u);
  assert.match(output, /enableCacheInterception: false/u);
});

test("follows contained inherited paths and baseUrl imports with bounded config ancestry", () => {
  const fixture = nextCacheFixture();
  const config = path.join(fixture.applicationRoot, "tsconfig.json");
  fs.writeFileSync(config, '{"extends":"./config/base.json"}');
  fs.mkdirSync(path.join(fixture.applicationRoot, "config"));
  fs.writeFileSync(
    path.join(fixture.applicationRoot, "config", "base.json"),
    '{"compilerOptions":{"baseUrl":"..","paths":{"@/*":["src/*"]}}}',
  );
  assert.equal(validateNextCacheSupport(fixture).sourceFiles, 2);
  const source = path.join(fixture.applicationRoot, "src", "lib", "content.ts");
  fs.writeFileSync(
    source,
    'import { revalidatePath } from "next/cache"; export function read(){revalidatePath("/");}',
  );
  assert.throws(() => validateNextCacheSupport(fixture), PackagingLimitError);
  fs.writeFileSync(config, '{"compilerOptions":{"baseUrl":"src"}}');
  fs.writeFileSync(
    path.join(fixture.applicationRoot, "src", "app", "notes", "[slug]", "page.tsx"),
    'import {read} from "lib/content"; export default read;',
  );
  assert.throws(() => validateNextCacheSupport(fixture), PackagingLimitError);
  fs.writeFileSync(source, 'export function read(){return "data";}');
  assert.equal(validateNextCacheSupport(fixture).sourceFiles, 2);
  fs.writeFileSync(config, '{"extends":"./config/base.json"}');
  fs.writeFileSync(
    path.join(fixture.applicationRoot, "config", "base.json"),
    '{"extends":"../tsconfig.json"}',
  );
  assert.throws(() => validateNextCacheSupport(fixture), /configuration.*(?:cycle|ancestry)/u);
  fs.writeFileSync(config, '{"extends":"../outside.json"}');
  assert.throws(() => validateNextCacheSupport(fixture), /escapes root/u);
});

test("recognizes actual Next fetch options and Pages response type bindings without ordinary-method false positives", () => {
  const fixture = nextCacheFixture();
  const source = path.join(fixture.applicationRoot, "src", "lib", "content.ts");
  for (const body of [
    'export function read(){const options={next:{revalidate:60}}; return fetch("https://example.com", options);}',
    'import type {NextApiResponse as ApiResponse} from "next"; export function read(res:ApiResponse){return res["revalidate"]("/");}',
  ]) {
    fs.writeFileSync(source, body);
    assert.throws(() => validateNextCacheSupport(fixture), PackagingLimitError);
  }
  for (const body of [
    'export function read(fetch){return fetch("business",{next:{revalidate:60}});}',
    'import fetch from "ordinary-request-library"; export function read(){return fetch("business",{next:{revalidate:60}});}',
    'export function read(){return fetch("https://example.com",{next:{revalidate:0}});}',
  ]) {
    fs.writeFileSync(source, body);
    assert.doesNotThrow(() => validateNextCacheSupport(fixture));
  }
  fs.mkdirSync(path.join(fixture.applicationRoot, "pages", "api"), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.applicationRoot, "pages", "api", "refresh.js"),
    'export default function handler(req,response){return response.revalidate("/");}',
  );
  assert.throws(() => validateNextCacheSupport(fixture), PackagingLimitError);
});

test("uses the pinned official static cache population API and preserves HTML, RSC and metadata bytes", async () => {
  const fixture = nextCacheFixture();
  const platformPackageRoot = fs.realpathSync(
    new URL("../../../../fixtures/next-edge/node_modules/@opennextjs/cloudflare", import.meta.url),
  );
  // Every Next release the platform admits scopes response cache keys by source route (OpenNext
  // tests for >=15.5.27 <16 or >=16.3.8, below the security floor); the pinned OpenNext writes
  // its cache files under those keys, which the validation and population keep byte for byte.
  const { getRouteCacheKey, useRouteCacheKeys } = await import(
    pathToFileURL(
      createRequire(path.join(platformPackageRoot, "package.json")).resolve(
        "@opennextjs/aws/utils/routeCacheKey.js",
      ),
    ).href
  );
  for (const floor of FRAMEWORK_VERSION_POLICY.next.floors)
    assert.equal(useRouteCacheKeys(floor), true, `Next ${floor} uses route-scoped cache keys`);
  const routeCacheFiles = [
    [getRouteCacheKey("/", { kind: "APP_PAGE", sourceRoute: "/page" }), "<p>index</p>"],
    [
      getRouteCacheKey("/notes/known", { kind: "APP_PAGE", sourceRoute: "/notes/[slug]/page" }),
      "<p>known</p>",
    ],
  ].map(([key, html]) => {
    const relative = `build-id${key}.cache`;
    assert.match(
      relative,
      /^build-id\/route-cache\/APP_PAGE\/[0-9a-f]{64}\/\$\/(?:index|notes\/known)\.cache$/u,
    );
    const file = path.join(fixture.applicationRoot, ".open-next", "cache", ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...fixture.entry, html }));
    return relative;
  });
  const before = validateNextStaticCache(fixture);
  assert.deepEqual(
    before.map((entry) => entry.path),
    ["build-id/notes/known.cache", ...routeCacheFiles].sort(),
  );
  assert.deepEqual(
    await populateNextStaticCache({
      ...fixture,
      platformPackageRoot,
      environment: { SSG_CACHE_MAX_BYTES: "1048576" },
    }),
    {
      files: 3,
    },
  );
  const destination = path.join(
    fixture.applicationRoot,
    ".open-next",
    "assets",
    "cdn-cgi",
    "_next_cache",
    "build-id",
    "notes",
    "known.cache",
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(destination)), fixture.entry);
  for (const entry of before) {
    const copied = path.join(
      fixture.applicationRoot,
      ".open-next",
      "assets",
      "cdn-cgi",
      "_next_cache",
      ...entry.path.split("/"),
    );
    assert.equal(
      `sha256:${createHash("sha256").update(fs.readFileSync(copied)).digest("hex")}`,
      entry.digest,
    );
  }
  await assert.rejects(
    populateNextStaticCache({ ...fixture, platformPackageRoot }),
    /path is reserved/u,
  );
  // A page path that leaves its archive path no USTAR prefix/name split is the customer's to fix.
  const page = `/notes/${"x".repeat(100)}`;
  const key = getRouteCacheKey(page, { kind: "APP_PAGE", sourceRoute: "/notes/[slug]/page" });
  const file = path.join(fixture.applicationRoot, ".open-next", "cache", `build-id${key}.cache`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(fixture.entry));
  assert.throws(
    () => validateNextStaticCache(fixture),
    (error) =>
      packagingFailureLine(error) ===
      `ohmyho.st packaging: the prerendered page ${page} has a URL path too long for the deployment archive; shorten the URL or render the page on request instead of prerendering it, then commit, push and deploy the new commit`,
  );
});

test("configures Cache Components builds to resume their shells and never store request-time cache entries", async () => {
  const fixture = nextCacheFixture();
  const root = fixture.applicationRoot;
  const environment = {
    FRAMEWORK_ADAPTER: "nextjs",
    FRAMEWORK_RUNTIME: "edge",
    BUILD_OUTPUT_DIRECTORY: ".open-next/assets",
    SERVER_OUTPUT_DIRECTORY: ".ohmyhost-worker",
    SERVER_ENTRYPOINT: ".ohmyhost-worker/worker.js",
    COMPATIBILITY_DATE: "2026-08-21",
    COMPATIBILITY_FLAGS: "nodejs_compat",
  };
  const requiredPath = path.join(root, ".next", "required-server-files.json");
  const outputPath = path.join(root, ".ohmyhost-open-next.config.ts");
  // Next.js copies its server files into the standalone output; OpenNext bundles that copy as the
  // configuration Next.js reads and the build's own copy as its adapter configuration.
  const standalonePath = (relativeAppDir) =>
    path.join(root, ".next", "standalone", relativeAppDir, ".next", "required-server-files.json");
  const writeServerFiles = (required, relativeAppDir = "") => {
    fs.rmSync(path.join(root, ".next", "standalone"), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(standalonePath(relativeAppDir)), { recursive: true });
    for (const file of [requiredPath, standalonePath(relativeAppDir)])
      fs.writeFileSync(file, required);
  };
  const configure = (required, relativeAppDir = "") => {
    writeServerFiles(required, relativeAppDir);
    createOpenNextPlatformConfig({ applicationRoot: root, outputPath, environment });
    const config = fs.readFileSync(outputPath, "utf8");
    assert.equal(cleanupOpenNextPlatformConfig({ applicationRoot: root }), true);
    const [built, standalone] = [requiredPath, standalonePath(relativeAppDir)].map((file) =>
      fs.readFileSync(file, "utf8"),
    );
    assert.equal(standalone, built);
    return [config, built];
  };
  // OpenNext's cache interception would answer a shell without resuming its dynamic parts, and
  // workerd inflates at most 128 MiB: five times the postponed state limit Next.js reads.
  for (const [configured, effective] of [
    [undefined, "25 MB"],
    ["100 MB", "25 MB"],
    [26214401, "25 MB"],
    ["no size", "25 MB"],
    [0, "25 MB"],
    ["25mb", "25mb"],
    ["1 MB", "1 MB"],
    ["1000", "1000"],
    [26214400, 26214400],
  ]) {
    const server = (maxPostponedStateSize) =>
      JSON.stringify({
        version: 1,
        config: { cacheComponents: true, experimental: { ppr: false, maxPostponedStateSize } },
        relativeAppDir: "site",
        files: [".next/server/app/page.js"],
      });
    const [config, required] = configure(server(configured), "site");
    assert.match(config, /enableCacheInterception: false \}\);\n$/u);
    assert.equal(required, server(effective));
  }
  assert.equal(
    configure('{"config":{"cacheComponents":true}}')[1],
    '{"config":{"cacheComponents":true,"experimental":{"maxPostponedStateSize":"25 MB"}}}',
  );
  // Metadata that cannot carry the limit to both copies stops the build before anything changes.
  for (const [invalid, failure] of [
    ['{"config":{"cacheComponents":true,"experimental":[]}}', /cache metadata is invalid/u],
    ["{}", /cache metadata is invalid/u],
    [
      '{"config":{"cacheComponents":true},"relativeAppDir":"../site"}',
      /cache metadata is invalid/u,
    ],
    ['{"config":{"cacheComponents":true},"relativeAppDir":"other"}', /ENOENT/u],
  ]) {
    writeServerFiles(invalid);
    assert.throws(
      () => createOpenNextPlatformConfig({ applicationRoot: root, outputPath, environment }),
      failure,
    );
    assert.equal(fs.existsSync(outputPath), false);
    assert.equal(fs.readFileSync(requiredPath, "utf8"), invalid);
  }
  // Every other build keeps cache interception and its server files byte for byte.
  const plain =
    '{"config":{"cacheComponents":false,"experimental":{"maxPostponedStateSize":"1 GB"}}}';
  const [plainConfig, plainRequired] = configure(plain);
  assert.match(plainConfig, /enableCacheInterception: true \}\);\n$/u);
  assert.equal(plainRequired, plain);

  // The generated cache answers request-time "use cache" entries with a silent miss and stores
  // nothing, so no request's data can reach another; build-time entries stay read-only.
  const platformPackageRoot = fs.realpathSync(
    new URL("../../../../fixtures/next-edge/node_modules/@opennextjs/cloudflare", import.meta.url),
  );
  const [cacheComponentsConfig] = configure('{"config":{"cacheComponents":true}}');
  const modulePath = path.join(temporaryDirectory(), "open-next.config.mjs");
  fs.writeFileSync(
    modulePath,
    cacheComponentsConfig.replaceAll(
      "/opt/ohmyhost-platform/lib/node_modules/@opennextjs/cloudflare",
      platformPackageRoot,
    ),
  );
  const { default: openNextConfig } = await import(pathToFileURL(modulePath).href);
  const incrementalCache = await openNextConfig.default.override.incrementalCache();
  const context = Symbol.for("__cloudflare-context__");
  const requests = [];
  const logged = [];
  const { console } = globalThis;
  const { error: consoleError, log: consoleLog } = console;
  globalThis[context] = {
    env: {
      ASSETS: {
        async fetch(url) {
          requests.push(url);
          return globalThis.Response.json(fixture.entry);
        },
      },
    },
  };
  console.error = (...values) => logged.push(values.join(" "));
  console.log = (...values) => logged.push(values.join(" "));
  try {
    assert.equal(incrementalCache.name, "cf-static-assets-incremental-cache");
    assert.equal(await incrementalCache.get("use-cache-key", "composable"), null);
    assert.equal(
      await incrementalCache.set("use-cache-key", { value: "request data" }, "composable"),
      undefined,
    );
    assert.deepEqual([requests, logged], [[], []]);
    assert.deepEqual((await incrementalCache.get("/notes/known", "cache")).value, fixture.entry);
    assert.equal(requests.length, 1);
    assert.match(
      requests[0],
      /^http:\/\/assets\.local\/cdn-cgi\/_next_cache\/.+\/notes\/known\.cache$/u,
    );
    await incrementalCache.set("/notes/known", fixture.entry, "cache");
    assert.match(
      logged.join("\n"),
      /Failed to set to read-only cache key=\/notes\/known type=cache/u,
    );
  } finally {
    console.error = consoleError;
    console.log = consoleLog;
    Reflect.deleteProperty(globalThis, context);
  }
  // Static cache population accepts the same Cache Components build.
  assert.deepEqual(
    await populateNextStaticCache({
      ...fixture,
      platformPackageRoot,
      environment: { SSG_CACHE_MAX_BYTES: "1048576" },
    }),
    { files: 1 },
  );
});

test("packages private SSG cache within its chosen cap independently of public assets", () => {
  const create = (capacity, publicBytes = 9_879_734) => {
    const fixture = nextPackageFixture(1);
    if (capacity !== undefined)
      fixture.environment.SSG_CACHE_MAX_BYTES = String(capacity * 1024 * 1024);
    const assets = path.join(fixture.applicationRoot, ".open-next", "assets");
    fs.truncateSync(path.join(assets, "index.txt"), publicBytes);
    const cache = path.join(assets, "cdn-cgi", "_next_cache", "build-id");
    fs.mkdirSync(cache, { recursive: true });
    for (const [name, size] of [
      ["first.cache", 9_388_950],
      ["second.cache", 9_388_949],
    ]) {
      const body = Buffer.alloc(size, 32);
      body.write('{"type":"app","html":"cached page"}');
      fs.writeFileSync(path.join(cache, name), body);
    }
    return fixture;
  };
  for (const capacity of [undefined, 32, 64]) {
    const fixture = create(capacity);
    const manifest = packageNextFixture(fixture);
    assert.equal(
      manifest.assets.reduce((sum, entry) => sum + entry.size, 0),
      28_657_633,
    );
    assert.equal(manifest.runtime.ssgCacheMaxBytes, (capacity ?? 32) * 1024 * 1024);
    assert.equal(
      manifest.assets.filter((entry) => entry.path.startsWith("/cdn-cgi/_next_cache/")).length,
      2,
    );
  }
  const selectedTooSmall = create(1);
  assert.throws(() => packageNextFixture(selectedTooSmall), /build\.ssg_cache_max_mib/u);
  const publicTooLarge = create(64, 9 * 1024 * 1024);
  const publicRoot = path.join(publicTooLarge.applicationRoot, ".open-next", "assets");
  for (const name of ["another.txt", "last.txt"]) {
    fs.writeFileSync(path.join(publicRoot, name), "public");
    fs.truncateSync(path.join(publicRoot, name), 9 * 1024 * 1024);
  }
  assert.throws(() => packageNextFixture(publicTooLarge), /26214400/u);
  const enabled = nextPackageFixture(1);
  enabled.environment.NEXT_REVALIDATE_PATH = "1";
  assert.equal(packageNextFixture(enabled).runtime.nextRevalidatePath, true);
  const unenabled = nextPackageFixture(1);
  assert.equal(Object.hasOwn(packageNextFixture(unenabled).runtime, "nextRevalidatePath"), false);
  const invalid = nextPackageFixture(1);
  invalid.environment.NEXT_REVALIDATE_PATH = "true";
  assert.throws(() => packageNextFixture(invalid), /Next.js cache mode is invalid/u);
});

test("validates trusted SSG cache capacity and applies it before official cache population", async () => {
  const fixture = nextCacheFixture();
  for (const invalid of ["", "032", "0", "1048577", "68157440", "-1048576", "NaN"]) {
    assert.throws(
      () => validateNextStaticCache({ ...fixture, environment: { SSG_CACHE_MAX_BYTES: invalid } }),
      /cache limit is invalid/u,
    );
  }
  const cacheRoot = path.join(fixture.applicationRoot, ".open-next", "cache", "build-id", "notes");
  for (const name of ["first.cache", "second.cache"]) {
    const body = Buffer.alloc(600 * 1024, 32);
    body.write('{"type":"app","html":"cached page"}');
    fs.writeFileSync(path.join(cacheRoot, name), body);
  }
  const environment = { SSG_CACHE_MAX_BYTES: "1048576" };
  assert.throws(
    () => validateNextStaticCache({ ...fixture, environment }),
    /build\.ssg_cache_max_mib/u,
  );
  await assert.rejects(
    populateNextStaticCache({ ...fixture, environment }),
    /build\.ssg_cache_max_mib/u,
  );
  assert.equal(
    fs.existsSync(
      path.join(fixture.applicationRoot, ".open-next", "assets", "cdn-cgi", "_next_cache"),
    ),
    false,
  );
  assert.equal(
    validateNextStaticCache({ ...fixture, environment: { SSG_CACHE_MAX_BYTES: "2097152" } }).length,
    3,
  );
});

test("rejects cache links, escapes, mutable fetch cache, oversize files and missing build metadata", () => {
  for (const mutation of [
    (root, file) =>
      fs.symlinkSync(file, path.join(root, ".open-next", "cache", "build-id", "linked.cache")),
    (root, file) =>
      fs.linkSync(file, path.join(root, ".open-next", "cache", "build-id", "linked.cache")),
    (root) =>
      fs.writeFileSync(
        path.join(root, ".open-next", "cache", "build-id", "%2e%2e%2fescape.cache"),
        '{"type":"app"}',
      ),
    (root, file) => fs.truncateSync(file, 10_485_761),
  ]) {
    const fixture = nextCacheFixture();
    mutation(
      fixture.applicationRoot,
      path.join(fixture.applicationRoot, ".open-next", "cache", "build-id", "notes", "known.cache"),
    );
    assert.throws(() => validateNextStaticCache(fixture));
  }
  const fetchFixture = nextCacheFixture();
  const fetchPath = path.join(
    fetchFixture.applicationRoot,
    ".open-next",
    "cache",
    "__fetch",
    "build-id",
  );
  fs.mkdirSync(fetchPath, { recursive: true });
  fs.writeFileSync(path.join(fetchPath, "key"), '{"revalidate":60,"data":{"body":"private"}}');
  assert.throws(() => validateNextStaticCache(fetchFixture), PackagingLimitError);
  fs.writeFileSync(
    path.join(fetchPath, "key"),
    '{"revalidate":4294967294,"data":{"body":"private"}}',
  );
  assert.equal(validateNextStaticCache(fetchFixture).length, 2);
  fs.unlinkSync(path.join(fetchFixture.applicationRoot, ".next", "prerender-manifest.json"));
  assert.throws(() => validateNextCacheSupport(fetchFixture));
});

test("creates the fixed provider-free TanStack Wrangler input before the customer build", () => {
  const fixture = staticPackageFixture();
  const outputPath = path.join(fixture.site, ".ohmyhost-tanstack-wrangler.jsonc");
  const environment = {
    FRAMEWORK_ADAPTER: "tanstack-start",
    FRAMEWORK_RUNTIME: "edge",
    BUILD_OUTPUT_DIRECTORY: "dist/client",
    SERVER_OUTPUT_DIRECTORY: "dist/server",
    SERVER_ENTRYPOINT: "dist/server/index.js",
    SERVER_CONFIG_PATH: "dist/server/wrangler.json",
    COMPATIBILITY_DATE: "2026-08-21",
    COMPATIBILITY_FLAGS: "nodejs_compat",
  };
  const config = createTanStackPlatformConfig({
    applicationRoot: fixture.site,
    outputPath,
    environment,
  });

  assert.deepEqual(config, {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: "ohmyhost-platform-tanstack-build",
    main: "@tanstack/react-start/server-entry",
    compatibility_date: "2026-08-21",
    compatibility_flags: ["nodejs_compat"],
  });
  assert.equal(fs.readFileSync(outputPath, "utf8"), JSON.stringify(config));
  assert.equal(fs.statSync(outputPath).mode & 0o777, 0o400);
  assert.equal(fs.lstatSync(outputPath).nlink, 1);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(outputPath, "utf8"))).sort(), [
    "$schema",
    "compatibility_date",
    "compatibility_flags",
    "main",
    "name",
  ]);
  assert.throws(
    () => createTanStackPlatformConfig({ applicationRoot: fixture.site, outputPath, environment }),
    /TanStack platform config input is invalid/u,
  );

  for (const collision of ["symlink", "hardlink", "directory"]) {
    const collisionFixture = staticPackageFixture();
    const collisionPath = path.join(collisionFixture.site, ".ohmyhost-tanstack-wrangler.jsonc");
    if (collision === "symlink") {
      fs.symlinkSync(path.join(collisionFixture.repository, "outside.json"), collisionPath);
    } else if (collision === "hardlink") {
      const existing = path.join(collisionFixture.repository, "existing.json");
      fs.writeFileSync(existing, "collision");
      fs.linkSync(existing, collisionPath);
    } else {
      fs.mkdirSync(collisionPath);
    }
    assert.throws(
      () =>
        createTanStackPlatformConfig({
          applicationRoot: collisionFixture.site,
          outputPath: collisionPath,
          environment,
        }),
      /TanStack platform config input is invalid/u,
      collision,
    );
  }
});

test("passes only the exact contained TanStack input path to the unprivileged build and cleans it up", () => {
  fs.mkdirSync("/tmp/ohmyho", { recursive: true });
  const output = "/tmp/ohmyho/user-build.sh";
  fs.rmSync(output, { force: true });
  writeUserBuildScript(output);
  const body = fs.readFileSync(output, "utf8");
  assert.match(
    body,
    /export CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH="\$\(pwd\)\/\.ohmyhost-tanstack-wrangler\.jsonc"/u,
  );
  assert.doesNotMatch(
    body,
    /CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_TOKEN|SOURCE_GET_URL|OUTPUT_PUT_URL/u,
  );
  fs.rmSync(output, { force: true });
});

test("creates the TanStack input at the root-owned package-manager boundary and cleans it after validation", () => {
  const fixture = staticPackageFixture();
  fs.unlinkSync(fixture.packageManagerReceiptPath);
  fs.unlinkSync(path.join(fixture.site, ".ohmyhost-resolved-dependencies.json"));
  const environment = {
    FRAMEWORK_ADAPTER: "tanstack-start",
    FRAMEWORK_RUNTIME: "edge",
    BUILD_OUTPUT_DIRECTORY: "dist/client",
    SERVER_OUTPUT_DIRECTORY: "dist/server",
    SERVER_ENTRYPOINT: "dist/server/index.js",
    SERVER_CONFIG_PATH: "dist/server/wrangler.json",
    COMPATIBILITY_DATE: "2026-08-21",
    COMPATIBILITY_FLAGS: "nodejs_compat",
  };
  writePackageManagerReceipt({
    applicationRoot: fixture.site,
    installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
    buildCommand: "pnpm run build",
    outputPath: fixture.packageManagerReceiptPath,
    environment,
  });
  const inputPath = path.join(fixture.site, ".ohmyhost-tanstack-wrangler.jsonc");
  assert.equal(fs.existsSync(inputPath), true);
  fs.writeFileSync(path.join(fixture.site, ".ohmyhost-resolved-dependencies.json"), "[]\n");
  assert.equal(cleanupTanStackPlatformConfig({ applicationRoot: fixture.site }), true);
  assert.equal(fs.existsSync(inputPath), false);
  assert.equal(cleanupTanStackPlatformConfig({ applicationRoot: fixture.site }), false);

  fs.symlinkSync(path.join(fixture.repository, "missing-input.json"), inputPath);
  assert.throws(
    () => cleanupTanStackPlatformConfig({ applicationRoot: fixture.site }),
    /TanStack platform config cleanup is unsafe/u,
  );
  assert.equal(fs.lstatSync(inputPath).isSymbolicLink(), true);
});

test("treats the TanStack input as a non-secret untrusted handoff after chown", () => {
  const fixture = tanstackEdgePackageFixture();
  fs.unlinkSync(fixture.packageManagerReceiptPath);
  fs.unlinkSync(path.join(fixture.site, ".ohmyhost-resolved-dependencies.json"));
  writePackageManagerReceipt({
    applicationRoot: fixture.site,
    installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
    buildCommand: "pnpm run build",
    outputPath: fixture.packageManagerReceiptPath,
    environment: fixture.environment,
  });
  const inputPath = path.join(fixture.site, ".ohmyhost-tanstack-wrangler.jsonc");
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  assert.equal(fs.statSync(inputPath).mode & 0o777, 0o400);
  assert.equal(fs.lstatSync(inputPath).nlink, 1);
  assert.deepEqual(input, {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: "ohmyhost-platform-tanstack-build",
    main: "@tanstack/react-start/server-entry",
    compatibility_date: "2026-08-21",
    compatibility_flags: ["nodejs_compat"],
  });
  assert.doesNotMatch(JSON.stringify(input), /(?:account|binding|credential|secret|token|vars)/iu);

  const agent = fs.readFileSync(new URL("../agent.mjs", import.meta.url), "utf8");
  const inputIndex = agent.indexOf('"write-package-manager"');
  const chownIndex = agent.indexOf('file: "chown"');
  const unprivilegedBuildIndex = agent.indexOf('file: "setpriv"');
  assert.ok(inputIndex >= 0 && inputIndex < chownIndex && chownIndex < unprivilegedBuildIndex);

  fs.unlinkSync(inputPath);
  fs.writeFileSync(inputPath, JSON.stringify({ vars: { UNTRUSTED_BINDING: "replaced" } }));
  fs.writeFileSync(path.join(fixture.site, ".ohmyhost-resolved-dependencies.json"), "[]\n");
  const generatedPath = path.join(fixture.site, "dist", "server", "wrangler.json");
  const generated = JSON.parse(fs.readFileSync(generatedPath, "utf8"));
  generated.vars = { UNTRUSTED_BINDING: "replaced" };
  fs.writeFileSync(generatedPath, JSON.stringify(generated));

  assert.throws(
    () =>
      packageBuildArtifact({
        applicationRoot: fixture.site,
        bundleRoot: fixture.bundle,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: fixture.packageManagerReceiptPath,
        compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
        environment: fixture.environment,
      }),
    /generated Worker config capability is invalid/u,
  );
  assert.equal(cleanupTanStackPlatformConfig({ applicationRoot: fixture.site }), true);
});

test("creates a manager-neutral dependency inventory for SBOM packaging", () => {
  const root = temporaryDirectory();
  fs.mkdirSync(path.join(root, "node_modules", "alpha"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", ".pnpm", "beta@2.0.0", "node_modules", "beta"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, "node_modules", "alpha", "package.json"),
    JSON.stringify({ name: "alpha", version: "1.0.0" }),
  );
  fs.writeFileSync(
    path.join(root, "node_modules", ".pnpm", "beta@2.0.0", "node_modules", "beta", "package.json"),
    JSON.stringify({ name: "beta", version: "2.0.0" }),
  );
  const outputPath = path.join(root, ".ohmyhost-resolved-dependencies.json");
  assert.deepEqual(createDependencyInventory({ applicationRoot: root, outputPath }), {
    schemaVersion: "ohmyhost.dependencies/v1",
    components: [
      { name: "alpha", version: "1.0.0" },
      { name: "beta", version: "2.0.0" },
    ],
  });
  assert.equal(
    fs.readFileSync(outputPath, "utf8"),
    '{"schemaVersion":"ohmyhost.dependencies/v1","components":[{"name":"alpha","version":"1.0.0"},{"name":"beta","version":"2.0.0"}]}',
  );
});

test("accepts bounded Wrangler metadata and rejects bundled native addons", () => {
  const root = temporaryDirectory();
  const metafile = path.join(root, "next-meta.json");
  const write = (value) => fs.writeFileSync(metafile, JSON.stringify(value));
  const clean = {
    inputs: {
      "src/app/page.tsx": {
        bytes: 10,
        imports: [{ path: "node:crypto", kind: "import-statement", external: true }],
      },
    },
    outputs: {
      ".ohmyhost-worker/worker.js": {
        bytes: 100,
        inputs: { "src/app/page.tsx": { bytesInOutput: 10 } },
        imports: [],
        exports: ["default"],
        entryPoint: ".open-next/worker.js",
      },
    },
  };
  write(clean);
  assert.deepEqual(
    validateNextWorkerMetafile({ applicationRoot: root, metafilePath: "next-meta.json" }),
    { inputCount: 1, outputCount: 1 },
  );
  write({
    ...clean,
    inputs: {
      "node_modules/native-addon/build/Release/addon.node": { bytes: 10, imports: [] },
    },
  });
  assert.throws(
    () => validateNextWorkerMetafile({ applicationRoot: root, metafilePath: "next-meta.json" }),
    /Next\.js build bundles a native addon that does not function on Workers/u,
  );
  write({
    ...clean,
    outputs: {
      ".ohmyhost-worker/worker.js": {
        ...clean.outputs[".ohmyhost-worker/worker.js"],
        imports: [{ path: "node:worker_threads", kind: "require-call", external: true }],
      },
    },
  });
  assert.deepEqual(
    validateNextWorkerMetafile({ applicationRoot: root, metafilePath: "next-meta.json" }),
    { inputCount: 1, outputCount: 1 },
  );
});

test("archive validation rejects links, devices, FIFOs, and escape paths before extraction", () => {
  const directory = temporaryDirectory();
  for (const [name, type, entryPath] of [
    ["hardlink", "1", "repository/link"],
    ["symlink", "2", "repository/link"],
    ["device", "3", "repository/device"],
    ["fifo", "6", "repository/pipe"],
    ["pax", "g", "pax-global"],
    ["escape", "0", "repository/../escape"],
  ]) {
    const archivePath = path.join(directory, `${name}.tar.gz`);
    fs.writeFileSync(
      archivePath,
      zlib.gzipSync(Buffer.concat([tarEntry(entryPath, type), Buffer.alloc(1024)])),
    );
    assert.throws(() => validateSourceArchive(archivePath), /forbidden|unsafe|global header/u);
  }
});

function staticPackageFixture() {
  const repository = temporaryDirectory();
  const site = path.join(repository, "site");
  const bundle = path.join(repository, "bundle");
  fs.mkdirSync(path.join(site, "dist"), { recursive: true });
  fs.mkdirSync(path.join(repository, "dist"));
  fs.mkdirSync(path.join(bundle, "assets"), { recursive: true });
  fs.mkdirSync(path.join(bundle, "worker"), { recursive: true });
  fs.writeFileSync(path.join(repository, "ohmyhost.yaml"), "applicationRoot: site\n");
  fs.writeFileSync(path.join(repository, "dist", "stale.html"), "stale");
  fs.writeFileSync(
    path.join(site, "package.json"),
    '{"name":"nested-app","version":"1.0.0","packageManager":"pnpm@10.28.2","scripts":{"build":"vite build"}}\n',
  );
  fs.writeFileSync(path.join(site, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  fs.writeFileSync(path.join(site, "dist", "index.html"), "<!doctype html><title>nested</title>");
  fs.writeFileSync(path.join(site, "dist", "Z.html"), "uppercase");
  fs.writeFileSync(path.join(site, "dist", "_locale.html"), "underscore");
  const packageManagerReceiptPath = path.join(repository, "package-manager.json");
  writePackageManagerReceipt({
    applicationRoot: site,
    installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
    buildCommand: "pnpm run build",
    outputPath: packageManagerReceiptPath,
  });
  fs.writeFileSync(path.join(site, ".ohmyhost-resolved-dependencies.json"), "[]\n");
  const environment = {
    APPLICATION_ROOT: "site",
    RUNTIME_POLICY_JSON:
      '{"healthCheckPath":"/ready","egressAllowedOrigins":["https://api.example.test"]}',
    DATABASE_REQUIREMENT_JSON: '{"enabled":false}',
    AUTH_REQUIREMENT_JSON: '{"provider":"none"}',
    MAIL_REQUIREMENT_JSON: '{"enabled":false}',
    STORAGE_REQUIREMENT_JSON: '{"enabled":false}',
    FUNCTIONS_REQUIREMENT_JSON: "",
    BUILD_OUTPUT_DIRECTORY: "dist",
    FRAMEWORK_ADAPTER: "vite-static",
    FRAMEWORK_RUNTIME: "static",
    SERVER_OUTPUT_DIRECTORY: "",
    SERVER_ENTRYPOINT: "",
    SERVER_CONFIG_PATH: "",
    COMPATIBILITY_DATE: "",
    COMPATIBILITY_FLAGS: "",
    PROJECT_ID: "01J00000000000000000000001",
    ENVIRONMENT_ID: "01J00000000000000000000002",
    DEPLOYMENT_ID: "01J00000000000000000000004",
    OPERATION_ID: "01J00000000000000000000003",
    BUILD_ID: "ohmyho-sandbox-vite:12345678-1234-1234-1234-123456789abc",
    BUILD_INPUT_FINGERPRINT: `sha256:${"d".repeat(64)}`,
    INSTALL_COMMAND: "pnpm install --frozen-lockfile --ignore-scripts",
    BUILD_COMMAND: "pnpm run build",
    SOURCE_COMMIT_SHA: "c".repeat(40),
    EXPECTED_SOURCE_SHA256: "a".repeat(64),
    BUILD_PLAN_SHA256: "b".repeat(64),
  };
  return { repository, site, bundle, packageManagerReceiptPath, environment };
}

test("names a static file the archive cannot carry as a customer packaging limit", () => {
  // A percent sign that starts no escape, a 101-character name, and a 60-character name of two-byte letters.
  const names = ["100%.png", `${"w".repeat(97)}.webp`, `${"я".repeat(60)}.txt`];
  for (const name of names) {
    const fixture = staticPackageFixture();
    fs.writeFileSync(path.join(fixture.site, "dist", name), "asset");
    let line = null;
    try {
      packageBuildArtifact({
        applicationRoot: fixture.site,
        bundleRoot: fixture.bundle,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: fixture.packageManagerReceiptPath,
        compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
        environment: fixture.environment,
      });
    } catch (error) {
      assert.ok(error instanceof PackagingLimitError, name);
      line = packagingFailureLine(error);
    }
    assert.ok(line?.startsWith("ohmyho.st packaging: "), `${name} gave ${String(line)}`);
    assert.ok(line.includes(`/${name} `), `${name} is not named in ${line}`);
  }
});

function tanstackEdgePackageFixture() {
  const fixture = staticPackageFixture();
  const clientRoot = path.join(fixture.site, "dist", "client");
  const serverRoot = path.join(fixture.site, "dist", "server");
  fs.mkdirSync(clientRoot, { recursive: true });
  fs.mkdirSync(path.join(serverRoot, "assets"), { recursive: true });
  fs.writeFileSync(path.join(clientRoot, ".assetsignore"), "wrangler.json\n.dev.vars\n");
  fs.writeFileSync(path.join(clientRoot, "index.html"), "<!doctype html><title>edge</title>");
  fs.writeFileSync(path.join(serverRoot, "assets", "chunk.js"), "export const chunk = true;\n");
  fs.writeFileSync(
    path.join(serverRoot, "index.js"),
    'import "./assets/chunk.js"; export default { fetch() { return new Response("ok"); } };\n',
  );
  const workerConfigKeys = [
    "configPath",
    "userConfigPath",
    "topLevelName",
    "definedEnvironments",
    "compatibility_date",
    "compatibility_flags",
    "jsx_factory",
    "jsx_fragment",
    "rules",
    "name",
    "main",
    "triggers",
    "assets",
    "vars",
    "durable_objects",
    "workflows",
    "migrations",
    "exports",
    "kv_namespaces",
    "cloudchamber",
    "send_email",
    "queues",
    "connect",
    "r2_buckets",
    "d1_databases",
    "vectorize",
    "ai_search_namespaces",
    "ai_search",
    "agent_memory",
    "hyperdrive",
    "services",
    "analytics_engine_datasets",
    "dispatch_namespaces",
    "mtls_certificates",
    "pipelines",
    "secrets_store_secrets",
    "artifacts",
    "unsafe_hello_world",
    "flagship",
    "worker_loaders",
    "ratelimits",
    "vpc_services",
    "vpc_networks",
    "logfwdr",
    "python_modules",
    "dev",
    "no_bundle",
  ];
  const workerConfig = Object.fromEntries(workerConfigKeys.map((key) => [key, null]));
  Object.assign(workerConfig, {
    configPath: path.join(fixture.site, ".ohmyhost-tanstack-wrangler.jsonc"),
    userConfigPath: path.join(fixture.site, ".ohmyhost-tanstack-wrangler.jsonc"),
    topLevelName: "ohmyhost-platform-tanstack-build",
    definedEnvironments: [],
    compatibility_date: "2026-08-21",
    compatibility_flags: ["nodejs_compat"],
    jsx_factory: "React.createElement",
    jsx_fragment: "React.Fragment",
    rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
    name: "ohmyhost-platform-tanstack-build",
    main: "index.js",
    triggers: {},
    assets: { directory: "../client" },
    vars: {},
    durable_objects: { bindings: [] },
    workflows: [],
    migrations: [],
    exports: {},
    kv_namespaces: [],
    cloudchamber: {},
    send_email: [],
    queues: { consumers: [], producers: [] },
    connect: [],
    r2_buckets: [],
    d1_databases: [],
    vectorize: [],
    ai_search_namespaces: [],
    ai_search: [],
    agent_memory: [],
    hyperdrive: [],
    services: [],
    analytics_engine_datasets: [],
    dispatch_namespaces: [],
    mtls_certificates: [],
    pipelines: [],
    secrets_store_secrets: [],
    artifacts: [],
    unsafe_hello_world: [],
    flagship: [],
    worker_loaders: [],
    ratelimits: [],
    vpc_services: [],
    vpc_networks: [],
    logfwdr: { bindings: [] },
    python_modules: { exclude: ["**/*.pyc"] },
    dev: {
      enable_containers: true,
      generate_types: false,
      ip: "localhost",
      local_protocol: "http",
      upstream_protocol: "http",
    },
    no_bundle: true,
  });
  fs.writeFileSync(path.join(serverRoot, "wrangler.json"), JSON.stringify(workerConfig));
  fs.mkdirSync(path.join(fixture.site, ".wrangler", "deploy"), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.site, ".wrangler", "deploy", "config.json"),
    JSON.stringify({ configPath: "../../dist/server/wrangler.json", auxiliaryWorkers: [] }),
  );
  return {
    ...fixture,
    environment: {
      ...fixture.environment,
      BUILD_OUTPUT_DIRECTORY: "dist/client",
      FRAMEWORK_ADAPTER: "tanstack-start",
      FRAMEWORK_RUNTIME: "edge",
      SERVER_OUTPUT_DIRECTORY: "dist/server",
      SERVER_ENTRYPOINT: "dist/server/index.js",
      SERVER_CONFIG_PATH: "dist/server/wrangler.json",
      COMPATIBILITY_DATE: "2026-08-21",
      COMPATIBILITY_FLAGS: "nodejs_compat",
    },
  };
}

function viteCompanionPackageFixture() {
  const fixture = staticPackageFixture();
  const sourceDirectory = path.join(fixture.site, "src", "ohmyhost");
  const serverDirectory = path.join(fixture.site, ".ohmyhost", "vite-companion");
  const migrations = path.join(fixture.site, "migrations");
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.mkdirSync(serverDirectory, { recursive: true });
  fs.mkdirSync(migrations, { recursive: true });
  fs.writeFileSync(path.join(fixture.site, "dist", "index.html"), '<!doctype html><base href="/">');
  fs.writeFileSync(
    path.join(sourceDirectory, "companion.ts"),
    "export default { fetch() { return new Response('ok'); } };\n",
  );
  fs.writeFileSync(
    path.join(serverDirectory, "worker.js"),
    'const internalOrigin="https://scheduled.ohmyhost.internal"; export default {fetch(){return new Response(internalOrigin)}};\n',
  );
  fs.writeFileSync(
    path.join(serverDirectory, "wrangler.jsonc"),
    JSON.stringify({
      main: "worker.js",
      compatibility_date: "2025-01-01",
      compatibility_flags: ["nodejs_compat"],
    }),
  );
  fs.writeFileSync(
    path.join(migrations, "20260824000000_app.sql"),
    "create table app_event(id uuid);\n",
  );
  return {
    ...fixture,
    environment: {
      ...fixture.environment,
      RUNTIME_POLICY_JSON: '{"healthCheckPath":"/api/health","egressAllowedOrigins":[]}',
      DATABASE_REQUIREMENT_JSON: '{"enabled":true,"migrations":"migrations"}',
      MAIL_REQUIREMENT_JSON: '{"enabled":false}',
      AUTH_REQUIREMENT_JSON:
        '{"provider":"better-auth","version":"1.7.7","deployment":"companion","routePath":"/api/auth","databaseSchema":"auth","databaseBindingName":"OHMYHOST_DATABASE","authSecretName":"BETTER_AUTH_SECRET"}',
      STORAGE_REQUIREMENT_JSON:
        '{"enabled":true,"provider":"r2","jurisdiction":"eu","public":false}',
      FUNCTIONS_REQUIREMENT_JSON: "",
      FRAMEWORK_RUNTIME: "edge",
      SERVER_OUTPUT_DIRECTORY: ".ohmyhost/vite-companion",
      SERVER_ENTRYPOINT: ".ohmyhost/vite-companion/worker.js",
      SERVER_CONFIG_PATH: ".ohmyhost/vite-companion/wrangler.jsonc",
      COMPATIBILITY_DATE: "2025-01-01",
      COMPATIBILITY_FLAGS: "nodejs_compat",
    },
  };
}

test("creates the fixed credential-free Vite companion Wrangler input", () => {
  const fixture = viteCompanionPackageFixture();
  const outputPath = path.join(fixture.site, ".ohmyhost-vite-companion.jsonc");

  const config = createViteCompanionConfig({
    applicationRoot: fixture.site,
    outputPath,
    environment: fixture.environment,
  });

  assert.deepEqual(config, {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: "ohmyhost-vite-companion",
    main: ".ohmyhost-vite-entry.ts",
    compatibility_date: "2025-01-01",
    compatibility_flags: ["nodejs_compat"],
  });
  assert.equal(fs.readFileSync(outputPath, "utf8"), JSON.stringify(config));
  const platformEntry = fs.readFileSync(path.join(fixture.site, ".ohmyhost-vite-entry.ts"), "utf8");
  assert.match(platformEntry, /import companion from "\.\/src\/ohmyhost\/companion\.ts"/u);
  assert.match(platformEntry, /url\.pathname\.startsWith\("\/api\/"\)\) return companion\.fetch/u);
  assert.match(platformEntry, /env\.ASSETS\.fetch\(request\)/u);
  assert.doesNotMatch(platformEntry, /scheduled|customer-runtime|ohmyhost\.internal/u);
  assert.throws(
    () =>
      createViteCompanionConfig({
        applicationRoot: fixture.site,
        outputPath,
        environment: fixture.environment,
      }),
    /Vite companion config input is invalid/u,
  );
});

test("re-exports the companion scheduled handler only for declared crons", () => {
  const fixture = viteCompanionPackageFixture();
  fixture.environment.FUNCTIONS_REQUIREMENT_JSON = '{"crons":["0 3 * * *"]}';

  createViteCompanionConfig({
    applicationRoot: fixture.site,
    outputPath: path.join(fixture.site, ".ohmyhost-vite-companion.jsonc"),
    environment: fixture.environment,
  });

  const platformEntry = fs.readFileSync(path.join(fixture.site, ".ohmyhost-vite-entry.ts"), "utf8");
  assert.match(
    platformEntry,
    /scheduled\(controller, env, executionContext\) \{\n\s*return companion\.scheduled\(controller, env, executionContext\);/u,
  );
  assert.doesNotThrow(() =>
    parseJavaScript(platformEntry.replace(/\.ts"/u, '"'), {
      ecmaVersion: 2024,
      sourceType: "module",
    }),
  );
  assert.doesNotMatch(platformEntry, /customer-runtime|ohmyhost\.internal/u);
});

test("finalizes only bounded Vite companion dry-run evidence", () => {
  const fixture = viteCompanionPackageFixture();
  const serverRoot = path.join(fixture.site, ".ohmyhost", "vite-companion");
  fs.unlinkSync(path.join(serverRoot, "wrangler.jsonc"));
  fs.unlinkSync(path.join(serverRoot, "worker.js"));
  fs.writeFileSync(
    path.join(serverRoot, ".ohmyhost-vite-entry.js"),
    'const internalOrigin="https://scheduled.ohmyhost.internal"; export default {fetch(){return new Response(internalOrigin)}};\n',
  );
  fs.writeFileSync(path.join(serverRoot, "README.md"), "wrangler dry-run\n");
  fs.writeFileSync(path.join(serverRoot, "companion.js.map"), "{}\n");

  const evidence = finalizeViteCompanionOutput({
    applicationRoot: fixture.site,
    environment: fixture.environment,
  });

  assert.deepEqual(evidence, {
    moduleBytes: evidence.moduleBytes,
    readmeBytes: 17,
    sourceMapBytes: 3,
  });
  assert.deepEqual(fs.readdirSync(serverRoot).sort(), ["worker.js", "wrangler.jsonc"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(serverRoot, "wrangler.jsonc"), "utf8")), {
    main: "worker.js",
    compatibility_date: "2025-01-01",
    compatibility_flags: ["nodejs_compat"],
  });
});

test("refuses missing managed-auth database or malformed Mail metadata before packaging", () => {
  const fixture = viteCompanionPackageFixture();
  assert.throws(
    () =>
      packageBuildArtifact({
        applicationRoot: fixture.site,
        bundleRoot: fixture.bundle,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: fixture.packageManagerReceiptPath,
        compressedWorkerPath: ".unused.gz",
        migrationSnapshotRoot: path.join(fixture.site, "migrations"),
        environment: { ...fixture.environment, DATABASE_REQUIREMENT_JSON: '{"enabled":false}' },
      }),
    { code: "managed_auth_database_required" },
  );
  for (const mail of [undefined, '{"enabled":true,"key":"private"}']) {
    assert.throws(
      () =>
        packageBuildArtifact({
          applicationRoot: fixture.site,
          bundleRoot: fixture.bundle,
          dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
          packageManagerReceiptPath: fixture.packageManagerReceiptPath,
          compressedWorkerPath: ".unused.gz",
          migrationSnapshotRoot: path.join(fixture.site, "migrations"),
          environment: { ...fixture.environment, MAIL_REQUIREMENT_JSON: mail },
        }),
      /mail requirement is invalid/u,
    );
    assert.equal(fs.existsSync(path.join(fixture.bundle, "manifest.json")), false);
    assert.equal(
      fs.existsSync(path.join(fixture.site, ".ohmyhost-resolved-dependencies.json")),
      true,
    );
  }
});

test("packages declared crons beside the single Vite companion module", () => {
  const fixture = viteCompanionPackageFixture();
  fixture.environment.FUNCTIONS_REQUIREMENT_JSON = '{"crons":["*/5 * * * *"]}';

  const manifest = packageBuildArtifact({
    applicationRoot: fixture.site,
    bundleRoot: fixture.bundle,
    dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
    packageManagerReceiptPath: fixture.packageManagerReceiptPath,
    compressedWorkerPath: ".unused.gz",
    migrationSnapshotRoot: path.join(fixture.site, "migrations"),
    environment: fixture.environment,
  });

  assert.deepEqual(manifest.functions, { crons: ["*/5 * * * *"] });
  assert.deepEqual(
    manifest.modules.map(({ path: modulePath }) => modulePath),
    ["index.js"],
  );
  assert.equal(manifest.runtime.entryWrapperVersion, "vite-api-companion-v1");
});

function functionsPackageFixture() {
  const repository = temporaryDirectory();
  const site = path.join(repository, "site");
  const bundle = path.join(repository, "bundle");
  const serverDirectory = path.join(site, ".ohmyhost", "functions");
  fs.mkdirSync(path.join(site, "src", "ohmyhost"), { recursive: true });
  fs.mkdirSync(path.join(bundle, "assets"), { recursive: true });
  fs.mkdirSync(path.join(bundle, "worker"), { recursive: true });
  fs.writeFileSync(path.join(repository, "ohmyhost.yaml"), "applicationRoot: site\n");
  fs.writeFileSync(
    path.join(site, "package.json"),
    '{"name":"functions-app","version":"1.0.0","packageManager":"pnpm@10.28.2"}\n',
  );
  fs.writeFileSync(path.join(site, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  fs.writeFileSync(
    path.join(site, "src", "ohmyhost", "worker.ts"),
    "export default { fetch() { return new Response('ok'); }, async scheduled() {} };\n",
  );
  const packageManagerReceiptPath = path.join(repository, "package-manager.json");
  const receipt = writePackageManagerReceipt({
    applicationRoot: site,
    installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
    buildCommand: "",
    outputPath: packageManagerReceiptPath,
  });
  fs.mkdirSync(serverDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(serverDirectory, "worker.js"),
    "export default { fetch() { return new Response('ok'); }, async scheduled() {} };\n",
  );
  fs.writeFileSync(
    path.join(serverDirectory, "wrangler.jsonc"),
    JSON.stringify({
      main: "worker.js",
      compatibility_date: "2025-01-01",
      compatibility_flags: ["nodejs_compat"],
    }),
  );
  fs.writeFileSync(path.join(site, ".ohmyhost-resolved-dependencies.json"), "[]\n");
  return {
    repository,
    site,
    bundle,
    receipt,
    packageManagerReceiptPath,
    environment: {
      APPLICATION_ROOT: "site",
      RUNTIME_POLICY_JSON: '{"healthCheckPath":"/","egressAllowedOrigins":[]}',
      DATABASE_REQUIREMENT_JSON: '{"enabled":false}',
      AUTH_REQUIREMENT_JSON: '{"provider":"none"}',
      MAIL_REQUIREMENT_JSON: '{"enabled":false}',
      STORAGE_REQUIREMENT_JSON: '{"enabled":false}',
      FUNCTIONS_REQUIREMENT_JSON: '{"crons":["0 3 * * *"]}',
      BUILD_OUTPUT_DIRECTORY: "",
      FRAMEWORK_ADAPTER: "functions",
      FRAMEWORK_RUNTIME: "functions",
      SERVER_OUTPUT_DIRECTORY: ".ohmyhost/functions",
      SERVER_ENTRYPOINT: ".ohmyhost/functions/worker.js",
      SERVER_CONFIG_PATH: ".ohmyhost/functions/wrangler.jsonc",
      COMPATIBILITY_DATE: "2025-01-01",
      COMPATIBILITY_FLAGS: "nodejs_compat",
      PROJECT_ID: "01J00000000000000000000001",
      ENVIRONMENT_ID: "01J00000000000000000000002",
      DEPLOYMENT_ID: "01J00000000000000000000004",
      OPERATION_ID: "01J00000000000000000000003",
      BUILD_ID: "ohmyho-sandbox-vite:12345678-1234-1234-1234-123456789abc",
      BUILD_INPUT_FINGERPRINT: `sha256:${"d".repeat(64)}`,
      INSTALL_COMMAND: "pnpm install --frozen-lockfile --ignore-scripts",
      BUILD_COMMAND: "",
      SOURCE_COMMIT_SHA: "c".repeat(40),
      EXPECTED_SOURCE_SHA256: "a".repeat(64),
      BUILD_PLAN_SHA256: "b".repeat(64),
    },
  };
}

test("records an install-only receipt for the functions runtime and rejects other empty builds", () => {
  const fixture = functionsPackageFixture();
  assert.equal(fixture.receipt.buildCommand, "");
  assert.deepEqual(readPackageManagerReceipt(fixture.packageManagerReceiptPath), fixture.receipt);
  assert.throws(
    () =>
      inspectPackageManager(fixture.site, {
        installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
        buildCommand: "pnpm build",
      }),
    /build command is invalid/u,
  );
  const edge = viteCompanionPackageFixture();
  edge.environment.BUILD_COMMAND = "";
  assert.throws(
    () =>
      packageBuildArtifact({
        applicationRoot: edge.site,
        bundleRoot: edge.bundle,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: edge.packageManagerReceiptPath,
        compressedWorkerPath: ".unused.gz",
        migrationSnapshotRoot: path.join(edge.site, "migrations"),
        environment: edge.environment,
      }),
    /package manager evidence is invalid/u,
  );
});

test("creates the fixed Wrangler input for the customer's Worker module", () => {
  const fixture = functionsPackageFixture();
  fs.rmSync(path.join(fixture.site, ".ohmyhost"), { recursive: true });
  const outputPath = path.join(fixture.site, ".ohmyhost-functions-wrangler.jsonc");

  const config = createFunctionsWorkerConfig({
    applicationRoot: fixture.site,
    outputPath,
    environment: fixture.environment,
  });

  assert.deepEqual(config, {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: "ohmyhost-functions",
    main: ".ohmyhost-functions-entry.ts",
    compatibility_date: "2025-01-01",
    compatibility_flags: ["nodejs_compat"],
  });
  assert.equal(fs.readFileSync(outputPath, "utf8"), JSON.stringify(config));
  // The platform entry re-exports the customer's default export so Wrangler always bundles an ES
  // module Worker; a module without a default export fails the bundle instead of silently
  // producing a service-worker script that the runtime wrapper cannot import.
  const entryPath = path.join(fixture.site, ".ohmyhost-functions-entry.ts");
  assert.equal(
    fs.readFileSync(entryPath, "utf8"),
    'import worker from "./src/ohmyhost/worker.ts";\nexport default worker;\n',
  );
  assert.equal(fs.statSync(entryPath).mode & 0o777, 0o400);
  assert.throws(
    () =>
      createFunctionsWorkerConfig({
        applicationRoot: fixture.site,
        outputPath,
        environment: fixture.environment,
      }),
    /functions config input is invalid/u,
  );
  fs.unlinkSync(outputPath);
  assert.throws(
    () =>
      createFunctionsWorkerConfig({
        applicationRoot: fixture.site,
        outputPath,
        environment: fixture.environment,
      }),
    /functions config input is invalid/u,
  );
  assert.ok(!fs.existsSync(outputPath));
  fs.unlinkSync(entryPath);
  fs.unlinkSync(path.join(fixture.site, "src", "ohmyhost", "worker.ts"));
  assert.throws(
    () =>
      createFunctionsWorkerConfig({
        applicationRoot: fixture.site,
        outputPath,
        environment: fixture.environment,
      }),
    /Worker module source/u,
  );
  assert.throws(
    () =>
      createFunctionsWorkerConfig({
        applicationRoot: fixture.site,
        outputPath,
        environment: { ...fixture.environment, BUILD_COMMAND: "pnpm run build" },
      }),
    /functions framework plan is invalid/u,
  );
  assert.throws(
    () =>
      createFunctionsWorkerConfig({
        applicationRoot: fixture.site,
        outputPath,
        environment: {
          ...fixture.environment,
          FRAMEWORK_ADAPTER: "vite-static",
          FRAMEWORK_RUNTIME: "edge",
        },
      }),
    /functions framework plan is invalid/u,
  );
});

test("finalizes the Worker module dry-run for the functions runtime and for edge crons", () => {
  const fixture = functionsPackageFixture();
  const serverRoot = path.join(fixture.site, ".ohmyhost", "functions");
  fs.unlinkSync(path.join(serverRoot, "wrangler.jsonc"));
  fs.unlinkSync(path.join(serverRoot, "worker.js"));
  fs.writeFileSync(path.join(serverRoot, "worker.js"), "export default {};\n");
  fs.writeFileSync(path.join(serverRoot, "worker.js.map"), "{}\n");
  fs.writeFileSync(path.join(serverRoot, "README.md"), "wrangler dry-run\n");

  const evidence = finalizeFunctionsWorkerOutput({
    applicationRoot: fixture.site,
    environment: fixture.environment,
  });

  assert.deepEqual(evidence, { moduleBytes: 19, readmeBytes: 17, sourceMapBytes: 3 });
  assert.deepEqual(fs.readdirSync(serverRoot).sort(), ["worker.js", "wrangler.jsonc"]);

  const next = nextPackageFixture(1);
  next.environment.FUNCTIONS_REQUIREMENT_JSON = '{"crons":["0 3 * * *"]}';
  const nextServerRoot = path.join(next.applicationRoot, ".ohmyhost", "functions");
  fs.mkdirSync(nextServerRoot, { recursive: true });
  fs.writeFileSync(path.join(nextServerRoot, "worker.js"), "export default { scheduled() {} };\n");
  fs.writeFileSync(path.join(nextServerRoot, "worker.js.map"), "{}\n");
  fs.writeFileSync(path.join(nextServerRoot, "README.md"), "wrangler dry-run\n");
  finalizeFunctionsWorkerOutput({
    applicationRoot: next.applicationRoot,
    environment: next.environment,
  });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(nextServerRoot, "wrangler.jsonc"), "utf8")),
    {
      main: "worker.js",
      compatibility_date: "2026-08-21",
      compatibility_flags: ["nodejs_compat"],
    },
  );
  assert.throws(
    () =>
      finalizeFunctionsWorkerOutput({
        applicationRoot: next.applicationRoot,
        environment: { ...next.environment, FUNCTIONS_REQUIREMENT_JSON: "" },
      }),
    /functions framework plan is invalid/u,
  );
});

test("packages the functions runtime as one asset-free Worker module", () => {
  const fixture = functionsPackageFixture();

  const manifest = packageBuildArtifact({
    applicationRoot: fixture.site,
    bundleRoot: fixture.bundle,
    dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
    packageManagerReceiptPath: fixture.packageManagerReceiptPath,
    compressedWorkerPath: ".unused.gz",
    environment: fixture.environment,
  });

  assert.deepEqual(manifest.assets, []);
  assert.deepEqual(manifest.functions, { crons: ["0 3 * * *"] });
  assert.deepEqual(manifest.runtime, {
    kind: "cloudflare-worker",
    mainModule: "index.js",
    compatibilityDate: "2025-01-01",
    compatibilityFlags: ["nodejs_compat"],
    entryWrapperVersion: "functions-v1",
  });
  assert.deepEqual(
    manifest.modules.map(({ path: modulePath, contentType }) => ({
      path: modulePath,
      contentType,
    })),
    [{ path: "index.js", contentType: "application/javascript+module" }],
  );
  assert.equal(manifest.lifecycleEvidence.frameworkBuild.framework, "functions");
  assert.equal(manifest.lifecycleEvidence.frameworkBuild.runtime, "functions");
  assert.equal(
    manifest.lifecycleEvidence.frameworkBuild.buildCommandSha256,
    createHash("sha256").update("").digest("hex"),
  );
  assert.equal(
    fs.readFileSync(path.join(fixture.bundle, "worker", "index.js"), "utf8"),
    "export default { fetch() { return new Response('ok'); }, async scheduled() {} };\n",
  );
  assert.deepEqual(fs.readdirSync(path.join(fixture.bundle, "assets")), []);
});

test("packages canonical Native Auth in a root Functions artifact without a business database", () => {
  const fixture = functionsPackageFixture();
  fixture.environment.APPLICATION_ROOT = ".";
  fixture.environment.FUNCTIONS_REQUIREMENT_JSON = "";
  fixture.environment.AUTH_REQUIREMENT_JSON =
    '{"provider":"omh-native","routePath":"/api/auth/v1","bindingName":"OHMYHOST_AUTH"}';
  fs.writeFileSync(path.join(fixture.site, "ohmyhost.yaml"), "auth:\n  provider: omh-native\n");

  const manifest = packageBuildArtifact({
    applicationRoot: fixture.site,
    bundleRoot: fixture.bundle,
    dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
    packageManagerReceiptPath: fixture.packageManagerReceiptPath,
    compressedWorkerPath: ".unused.gz",
    environment: fixture.environment,
  });
  assert.deepEqual(manifest.auth, {
    provider: "omh-native",
    routePath: "/api/auth/v1",
    bindingName: "OHMYHOST_AUTH",
  });
  assert.deepEqual(manifest.database, { enabled: false });
  assert.equal(manifest.applicationRoot, ".");
  assert.equal(manifest.runtime.entryWrapperVersion, "functions-v1");
  assert.equal(Object.hasOwn(manifest, "functions"), false);
  const preimage = {
    applicationRoot: manifest.applicationRoot,
    frameworkPlanSchemaVersion: manifest.frameworkPlanSchemaVersion,
    runtimePolicy: manifest.runtimePolicy,
    database: manifest.database,
    auth: manifest.auth,
    storage: manifest.storage,
    runtime: manifest.runtime,
    assets: manifest.assets,
    modules: manifest.modules,
  };
  assert.equal(
    manifest.artifactDigest,
    `sha256:${createHash("sha256").update(JSON.stringify(preimage)).digest("hex")}`,
  );
  const stored = JSON.parse(fs.readFileSync(path.join(fixture.bundle, "manifest.json"), "utf8"));
  assert.deepEqual(stored, manifest);
  assert.equal(manifest.lifecycleEvidence.frameworkBuild.framework, "functions");
  assert.equal(manifest.lifecycleEvidence.buildSandbox.terminalStatus, "SUCCEEDED");
});

test("packages the functions runtime without crons and rejects assets or stray output", () => {
  const plain = functionsPackageFixture();
  plain.environment.FUNCTIONS_REQUIREMENT_JSON = "";
  const manifest = packageBuildArtifact({
    applicationRoot: plain.site,
    bundleRoot: plain.bundle,
    dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
    packageManagerReceiptPath: plain.packageManagerReceiptPath,
    compressedWorkerPath: ".unused.gz",
    environment: plain.environment,
  });
  assert.equal(Object.hasOwn(manifest, "functions"), false);
  assert.equal(manifest.runtime.entryWrapperVersion, "functions-v1");

  const withAssets = functionsPackageFixture();
  withAssets.environment.BUILD_OUTPUT_DIRECTORY = "dist";
  assert.throws(
    () =>
      packageBuildArtifact({
        applicationRoot: withAssets.site,
        bundleRoot: withAssets.bundle,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: withAssets.packageManagerReceiptPath,
        compressedWorkerPath: ".unused.gz",
        environment: withAssets.environment,
      }),
    /functions framework plan is invalid/u,
  );

  const stray = functionsPackageFixture();
  fs.writeFileSync(path.join(stray.site, ".ohmyhost", "functions", "extra.js"), "export {};\n");
  assert.throws(
    () =>
      packageBuildArtifact({
        applicationRoot: stray.site,
        bundleRoot: stray.bundle,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: stray.packageManagerReceiptPath,
        compressedWorkerPath: ".unused.gz",
        environment: stray.environment,
      }),
    /functions dry-run output is invalid/u,
  );
});

test("static packaging rejects declared crons", () => {
  const fixture = staticPackageFixture();
  fixture.environment.FUNCTIONS_REQUIREMENT_JSON = '{"crons":["0 3 * * *"]}';
  assert.throws(
    () =>
      packageBuildArtifact({
        applicationRoot: fixture.site,
        bundleRoot: fixture.bundle,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: fixture.packageManagerReceiptPath,
        compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
        environment: fixture.environment,
      }),
    /static build received functions requirement/u,
  );
});

test("packages the Vite companion module and capabilities into the artifact digest", () => {
  const fixture = viteCompanionPackageFixture();
  const manifest = packageBuildArtifact({
    applicationRoot: fixture.site,
    bundleRoot: fixture.bundle,
    dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
    packageManagerReceiptPath: fixture.packageManagerReceiptPath,
    compressedWorkerPath: ".unused.gz",
    migrationSnapshotRoot: path.join(fixture.site, "migrations"),
    environment: fixture.environment,
  });

  assert.equal(manifest.runtime.entryWrapperVersion, "vite-api-companion-v1");
  assert.deepEqual(
    manifest.modules.map(({ path, contentType }) => ({ path, contentType })),
    [{ path: "index.js", contentType: "application/javascript+module" }],
  );
  assert.deepEqual(manifest.storage, {
    enabled: true,
    provider: "r2",
    jurisdiction: "eu",
    public: false,
  });
  assert.equal(
    fs.readFileSync(path.join(fixture.bundle, "worker", "index.js"), "utf8"),
    'const internalOrigin="https://scheduled.ohmyhost.internal"; export default {fetch(){return new Response(internalOrigin)}};\n',
  );
});

function nextPackageFixture(sourceMapSize) {
  const applicationRoot = temporaryDirectory();
  const bundleRoot = path.join(applicationRoot, "bundle");
  const projectId = "01J00000000000000000000001";
  fs.writeFileSync(path.join(applicationRoot, "ohmyhost.yaml"), "applicationRoot: .\n");
  fs.writeFileSync(
    path.join(applicationRoot, "package.json"),
    '{"name":"next-app","packageManager":"pnpm@10.28.2"}\n',
  );
  fs.writeFileSync(path.join(applicationRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const packageManagerReceiptPath = path.join(applicationRoot, "package-manager.json");
  writePackageManagerReceipt({
    applicationRoot,
    installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
    buildCommand: "pnpm run build",
    outputPath: packageManagerReceiptPath,
  });
  fs.mkdirSync(path.join(applicationRoot, ".open-next", "assets"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(applicationRoot, ".ohmyhost-worker"), { recursive: true });
  fs.mkdirSync(path.join(applicationRoot, ".next", "server", "app"), { recursive: true });
  fs.writeFileSync(
    path.join(applicationRoot, ".next", "server", "app", "page.js.nft.json"),
    '{"version":1,"files":[]}',
  );
  fs.mkdirSync(path.join(bundleRoot, "assets"), { recursive: true });
  fs.mkdirSync(path.join(bundleRoot, "worker"), { recursive: true });
  fs.writeFileSync(path.join(applicationRoot, ".ohmyhost-resolved-dependencies.json"), "[]\n");
  fs.writeFileSync(path.join(applicationRoot, ".open-next", "assets", "index.txt"), "asset");
  fs.writeFileSync(path.join(applicationRoot, ".ohmyhost-worker", "README.md"), "evidence\n");
  fs.writeFileSync(
    path.join(applicationRoot, ".ohmyhost-worker", "worker.js"),
    "export default { fetch() { return new Response('ok'); } };\n",
  );
  const sourceMap = path.join(applicationRoot, ".ohmyhost-worker", "worker.js.map");
  fs.writeFileSync(sourceMap, "x");
  fs.truncateSync(sourceMap, sourceMapSize);
  fs.writeFileSync(path.join(applicationRoot, ".ohmyhost-next-worker.js.gz"), "compressed");
  return {
    applicationRoot,
    bundleRoot,
    packageManagerReceiptPath,
    environment: {
      APPLICATION_ROOT: ".",
      RUNTIME_POLICY_JSON: '{"healthCheckPath":"/","egressAllowedOrigins":[]}',
      DATABASE_REQUIREMENT_JSON: '{"enabled":false}',
      AUTH_REQUIREMENT_JSON: '{"provider":"none"}',
      MAIL_REQUIREMENT_JSON: '{"enabled":false}',
      STORAGE_REQUIREMENT_JSON: '{"enabled":false}',
      BUILD_OUTPUT_DIRECTORY: ".open-next/assets",
      FRAMEWORK_ADAPTER: "nextjs",
      FRAMEWORK_RUNTIME: "edge",
      SERVER_OUTPUT_DIRECTORY: ".ohmyhost-worker",
      SERVER_ENTRYPOINT: ".ohmyhost-worker/worker.js",
      SERVER_CONFIG_PATH: "wrangler.jsonc",
      COMPATIBILITY_DATE: "2026-08-21",
      COMPATIBILITY_FLAGS: "nodejs_compat",
      PROJECT_ID: projectId,
      ENVIRONMENT_ID: "01J00000000000000000000002",
      DEPLOYMENT_ID: "01J00000000000000000000004",
      OPERATION_ID: "01J00000000000000000000003",
      BUILD_ID: "ohmyho-sandbox-vite:12345678-1234-1234-1234-123456789abc",
      BUILD_INPUT_FINGERPRINT: `sha256:${"d".repeat(64)}`,
      INSTALL_COMMAND: "pnpm install --frozen-lockfile --ignore-scripts",
      BUILD_COMMAND: "pnpm run build",
      SOURCE_COMMIT_SHA: "c".repeat(40),
      EXPECTED_SOURCE_SHA256: "a".repeat(64),
      BUILD_PLAN_SHA256: "b".repeat(64),
    },
  };
}

test("selects the build flag from bounded installed framework metadata at or above the security floors", () => {
  const nextEdge = { FRAMEWORK_ADAPTER: "nextjs", FRAMEWORK_RUNTIME: "edge" };
  const viteStatic = { FRAMEWORK_ADAPTER: "vite-static", FRAMEWORK_RUNTIME: "static" };
  const tanstackEdge = { FRAMEWORK_ADAPTER: "tanstack-start", FRAMEWORK_RUNTIME: "edge" };
  const customerLine = (packageName, version, minimum) =>
    `ohmyho.st build: installed ${version === null ? packageName : `${packageName} ${version}`} is not admitted; use ${packageName} ${minimum} or a later stable release in package.json and the lockfile, commit and push the change, then plan the new commit.`;
  const platformLine = (packageName, version) =>
    `ohmyho.st platform: the build image refused ${packageName} ${version}, which planning admitted. The platform admission policy is inconsistent; report the operation ID and plan the same commit again later.`;
  const missingLine = (packageName) =>
    `ohmyho.st build: the frozen install left no readable node_modules/${packageName}/package.json; declare ${packageName} in package.json, commit the lockfile, then plan the new commit.`;
  const pathVersionLine =
    "ohmyho.st build: build.next_revalidate_path currently requires Next.js 16.4.5; pin next to 16.4.5 or disable this option, update the lockfile, then commit and deploy the new commit.";
  // The node_modules layout of npm, Bun and Yarn's node-modules linker.
  const install = (root, packageName, metadata) => {
    const directory = path.join(root, "node_modules", ...packageName.split("/"));
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "package.json"),
      typeof metadata === "string" ? metadata : JSON.stringify(metadata),
    );
  };
  const declare = (root, declarations) =>
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ packageManager: "pnpm@10.28.2", ...declarations }),
    );
  const buildArguments = (root, environment) =>
    readFrameworkBuildArguments({ applicationRoot: root, environment });
  const refusal = (root, environment) => {
    try {
      buildArguments(root, environment);
    } catch (error) {
      assert.ok(error instanceof FrameworkVersionRefusal, error.stack);
      return error.message;
    }
    return assert.fail("the installed framework version was admitted");
  };

  const next = temporaryDirectory();
  declare(next, { dependencies: { next: "^16.4.5" } });
  for (const [version, expected] of [
    ["16.4.5", ["--webpack"]],
    ["16.4.6", ["--webpack"]],
    ["17.0.0", ["--webpack"]],
  ]) {
    install(next, "next", { name: "next", version });
    assert.deepEqual(buildArguments(next, nextEdge), expected);
    if (version === "16.4.5")
      assert.deepEqual(buildArguments(next, { ...nextEdge, NEXT_REVALIDATE_PATH: "1" }), expected);
    else assert.equal(refusal(next, { ...nextEdge, NEXT_REVALIDATE_PATH: "1" }), pathVersionLine);
  }
  for (const [metadata, line] of [
    [{ name: "next", version: "15.5.26" }, customerLine("next", "15.5.26", "16.4.5")],
    [{ name: "next", version: "15.5.27" }, customerLine("next", "15.5.27", "16.4.5")],
    [{ name: "next", version: "15.5.28" }, customerLine("next", "15.5.28", "16.4.5")],
    [{ name: "next", version: "16.3.7" }, customerLine("next", "16.3.7", "16.4.5")],
    [{ name: "next", version: "16.3.8" }, customerLine("next", "16.3.8", "16.4.5")],
    [{ name: "next", version: "16.4.0" }, customerLine("next", "16.4.0", "16.4.5")],
    [{ name: "next", version: "16.4.1" }, customerLine("next", "16.4.1", "16.4.5")],
    [{ name: "next", version: "16.4.4" }, customerLine("next", "16.4.4", "16.4.5")],
    [{ name: "next", version: "14.2.35" }, customerLine("next", "14.2.35", "16.4.5")],
    [{ name: "next", version: "16.5.0-canary.5" }, customerLine("next", null, "16.4.5")],
    [{ name: "next", version: "^16.4.1" }, customerLine("next", null, "16.4.5")],
    [{ name: "next", version: "16.4.1\n--eval" }, customerLine("next", null, "16.4.5")],
    [{ name: "next", version: 16 }, customerLine("next", null, "16.4.5")],
    [{ name: "other", version: "16.4.1" }, customerLine("next", null, "16.4.5")],
    [" ".repeat(65_537), missingLine("next")],
    ["{", missingLine("next")],
  ]) {
    install(next, "next", metadata);
    assert.equal(refusal(next, nextEdge), line);
  }
  // Only an exact first declaration of the refused version proves that planning admitted it.
  install(next, "next", { name: "next", version: "16.4.0" });
  for (const [declarations, line] of [
    [{ dependencies: { next: "16.4.0" } }, platformLine("next", "16.4.0")],
    [{ devDependencies: { next: "16.4.0" } }, platformLine("next", "16.4.0")],
    [{ dependencies: { next: "16.3.6" } }, customerLine("next", "16.4.0", "16.4.5")],
    [
      { dependencies: { next: "^16.4.0" }, devDependencies: { next: "16.4.0" } },
      customerLine("next", "16.4.0", "16.4.5"),
    ],
  ]) {
    declare(next, declarations);
    assert.equal(refusal(next, nextEdge), line);
  }
  // pnpm links each package into its virtual store inside the application.
  const store = path.join(next, "node_modules", ".pnpm", "next@16.4.5", "node_modules", "next");
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, "package.json"), '{"name":"next","version":"16.4.5"}');
  fs.rmSync(path.join(next, "node_modules", "next"), { recursive: true });
  fs.symlinkSync(store, path.join(next, "node_modules", "next"));
  assert.deepEqual(buildArguments(next, nextEdge), ["--webpack"]);
  const outside = temporaryDirectory();
  fs.writeFileSync(path.join(outside, "package.json"), '{"name":"next","version":"16.4.5"}');
  fs.unlinkSync(path.join(next, "node_modules", "next"));
  fs.symlinkSync(outside, path.join(next, "node_modules", "next"));
  assert.equal(refusal(next, nextEdge), missingLine("next"));
  fs.rmSync(path.join(next, "node_modules"), { recursive: true });
  assert.equal(refusal(next, nextEdge), missingLine("next"));

  const vite = temporaryDirectory();
  declare(vite, { devDependencies: { vite: "^5.4.0" } });
  assert.equal(refusal(vite, viteStatic), missingLine("vite"));
  for (const version of ["5.4.6", "8.3.4", "9.0.0"]) {
    install(vite, "vite", { name: "vite", version });
    assert.deepEqual(buildArguments(vite, { ...viteStatic, FRAMEWORK_RUNTIME: "edge" }), []);
  }
  install(vite, "vite", { name: "vite", version: "5.4.5" });
  assert.equal(refusal(vite, viteStatic), customerLine("vite", "5.4.5", "5.4.6"));
  declare(vite, { devDependencies: { vite: "5.4.5" } });
  assert.equal(refusal(vite, viteStatic), platformLine("vite", "5.4.5"));
  install(vite, "vite", { name: "vite", version: "8.3.0-beta.1" });
  assert.equal(refusal(vite, viteStatic), customerLine("vite", null, "5.4.6"));

  const tanstack = temporaryDirectory();
  declare(tanstack, {
    dependencies: { "@tanstack/react-start": "1.168.59" },
    devDependencies: { vite: "8.2.2" },
  });
  assert.equal(refusal(tanstack, tanstackEdge), missingLine("@tanstack/react-start"));
  install(tanstack, "vite", { name: "vite", version: "8.2.2" });
  install(tanstack, "@tanstack/react-start", {
    name: "@tanstack/react-start",
    version: "1.168.59",
  });
  assert.equal(refusal(tanstack, tanstackEdge), platformLine("@tanstack/react-start", "1.168.59"));
  for (const version of ["1.168.60", "1.169.0", "2.0.0"]) {
    install(tanstack, "@tanstack/react-start", { name: "@tanstack/react-start", version });
    assert.deepEqual(
      buildArguments(tanstack, { ...tanstackEdge, FRAMEWORK_RUNTIME: "static" }),
      [],
    );
  }
  install(tanstack, "vite", { name: "vite", version: "5.4.5" });
  assert.equal(refusal(tanstack, tanstackEdge), customerLine("vite", "5.4.5", "5.4.6"));
  install(tanstack, "@tanstack/react-start", {
    name: "@tanstack/react-start-client",
    version: "1.168.60",
  });
  assert.equal(
    refusal(tanstack, tanstackEdge),
    customerLine("@tanstack/react-start", null, "1.168.60"),
  );

  for (const environment of [
    { FRAMEWORK_ADAPTER: "functions", FRAMEWORK_RUNTIME: "functions" },
    { FRAMEWORK_ADAPTER: "vite-static", FRAMEWORK_RUNTIME: "functions" },
    { FRAMEWORK_ADAPTER: "nextjs", FRAMEWORK_RUNTIME: "static" },
    { FRAMEWORK_ADAPTER: "constructor", FRAMEWORK_RUNTIME: "edge" },
    undefined,
  ]) {
    assert.throws(
      () => buildArguments(vite, environment),
      (error) =>
        !(error instanceof FrameworkVersionRefusal) &&
        error.message === "framework plan is invalid",
    );
  }

  // The runtime CLI prints the build argument, or exactly one line on the stderr the customer's log
  // keeps: no stack frame and no platform path reach the bounded failure excerpt.
  const runtime = fileURLToPath(new URL("../build-runtime.mjs", import.meta.url));
  const cli = (root, environment) =>
    spawnSync(process.execPath, [runtime, "framework-build-argument"], {
      cwd: root,
      env: { PATH: process.env.PATH, ...environment },
      encoding: "utf8",
    });
  declare(next, { dependencies: { next: "16.4.5" } });
  install(next, "next", { name: "next", version: "16.4.5" });
  const admitted = cli(next, nextEdge);
  assert.deepEqual([admitted.status, admitted.stdout, admitted.stderr], [0, "--webpack", ""]);
  install(next, "next", { name: "next", version: "16.4.6" });
  const unqualified = cli(next, { ...nextEdge, NEXT_REVALIDATE_PATH: "1" });
  assert.deepEqual(
    [unqualified.status, unqualified.stdout, unqualified.stderr],
    [1, "", `${pathVersionLine}\n`],
  );
  for (const [root, environment, line] of [
    [vite, viteStatic, customerLine("vite", null, "5.4.6")],
    [tanstack, tanstackEdge, customerLine("@tanstack/react-start", null, "1.168.60")],
  ]) {
    const refused = cli(root, environment);
    assert.deepEqual([refused.status, refused.stdout, refused.stderr], [1, "", `${line}\n`]);
    const logPath = path.join(temporaryDirectory(), "user-build.log");
    fs.writeFileSync(logPath, `Lockfile is up to date\n${refused.stderr}`);
    const { excerpt } = readBuildFailureExcerpt({
      logPath,
      operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    assert.equal(excerpt, `Lockfile is up to date\n${line}`);
  }
  install(next, "next", { name: "next", version: "16.4.0" });
  declare(next, { dependencies: { next: "16.4.0" } });
  const inconsistent = cli(next, nextEdge);
  assert.deepEqual(
    [inconsistent.status, inconsistent.stdout, inconsistent.stderr],
    [1, "", `${platformLine("next", "16.4.0")}\n`],
  );
  const invalidPlan = cli(next, { FRAMEWORK_ADAPTER: "functions", FRAMEWORK_RUNTIME: "functions" });
  assert.equal(invalidPlan.status, 1);
  assert.match(invalidPlan.stderr, /framework plan is invalid/u);
});

test("accepts measured Wrangler source-map evidence through 24 MiB and rejects larger output", () => {
  const measured = nextPackageFixture(21_950_844);
  measured.environment.STORAGE_REQUIREMENT_JSON =
    '{"enabled":true,"provider":"r2","jurisdiction":"eu","public":false}';
  const manifest = packageBuildArtifact({
    applicationRoot: measured.applicationRoot,
    bundleRoot: measured.bundleRoot,
    dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
    packageManagerReceiptPath: measured.packageManagerReceiptPath,
    compressedWorkerPath: ".ohmyhost-next-worker.js.gz",
    environment: measured.environment,
  });
  assert.deepEqual(manifest.storage, {
    enabled: true,
    provider: "r2",
    jurisdiction: "eu",
    public: false,
  });

  const oversized = nextPackageFixture(25_165_825);
  assert.throws(
    () =>
      packageBuildArtifact({
        applicationRoot: oversized.applicationRoot,
        bundleRoot: oversized.bundleRoot,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: oversized.packageManagerReceiptPath,
        compressedWorkerPath: ".ohmyhost-next-worker.js.gz",
        environment: oversized.environment,
      }),
    /Wrangler evidence exceeds limit/u,
  );
});

test("preserves compiled WASM modules in Next.js artifacts", () => {
  const fixture = nextPackageFixture(1);
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  fs.writeFileSync(path.join(fixture.applicationRoot, ".ohmyhost-worker", "codec.wasm"), wasm);
  const manifest = packageBuildArtifact({
    applicationRoot: fixture.applicationRoot,
    bundleRoot: fixture.bundleRoot,
    dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
    packageManagerReceiptPath: fixture.packageManagerReceiptPath,
    compressedWorkerPath: ".ohmyhost-next-worker.js.gz",
    environment: fixture.environment,
  });
  assert.equal(
    manifest.modules.find((module) => module.path === "codec.wasm").contentType,
    "application/wasm",
  );
  assert.deepEqual(fs.readFileSync(path.join(fixture.bundleRoot, "worker", "codec.wasm")), wasm);
});

function packageNextFixture(fixture) {
  return packageBuildArtifact({
    ...fixture,
    dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
    compressedWorkerPath: ".ohmyhost-next-worker.js.gz",
  });
}

function writeNextTrace(fixture, files) {
  fs.writeFileSync(
    path.join(fixture.applicationRoot, ".next", "server", "app", "page.js.nft.json"),
    JSON.stringify({ version: 1, files }),
  );
}

test("preserves only Next-traced non-code runtime files as private Data modules", () => {
  const fixture = nextPackageFixture(1);
  const data = Buffer.from([0, 255, 16, 128]);
  for (const [name, body] of [
    ["content/catalog.json", '{"title":"runtime content"}'],
    ["templates/email.md", "export default 'text, not executable';"],
    ["node_modules/@scope/package+variant/data.bin", data],
    ["content/empty.txt", ""],
    ["content/untraced.txt", "must not enter the bundle"],
    ["content/bundled.js", "export default 42;"],
    [".next/server/app/projects/[slug]/page_client-reference-manifest.js", "export default {};"],
  ]) {
    const target = path.join(fixture.applicationRoot, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  writeNextTrace(fixture, [
    "../../../content/catalog.json",
    "../../../content/./catalog.json",
    "../../../templates/email.md",
    "../../../node_modules/@scope/package+variant/data.bin",
    "../../../content/empty.txt",
    "../../../content/bundled.js",
    "./projects/[slug]/page_client-reference-manifest.js",
    "../../../node_modules/linked-package",
    "../../../content",
  ]);
  fs.symlinkSync(
    "@scope/package+variant",
    path.join(fixture.applicationRoot, "node_modules", "linked-package"),
  );
  const manifest = packageNextFixture(fixture);
  const runtimeFiles = manifest.modules.filter(
    ({ contentType }) => contentType === "application/octet-stream",
  );
  assert.deepEqual(
    runtimeFiles.map(({ path: name }) => name),
    [
      "content/catalog.json",
      "content/empty.txt",
      "node_modules/@scope/package+variant/data.bin",
      "templates/email.md",
    ],
  );
  for (const module of runtimeFiles) {
    const source = fs.readFileSync(path.join(fixture.applicationRoot, module.path));
    assert.deepEqual(fs.readFileSync(path.join(fixture.bundleRoot, "worker", module.path)), source);
    assert.equal(module.size, source.length);
    assert.equal(module.digest, `sha256:${createHash("sha256").update(source).digest("hex")}`);
    assert.ok(!manifest.assets.some(({ path: name }) => name === `/${module.path}`));
  }
  assert.ok(!manifest.modules.some(({ path: name }) => name === "content/untraced.txt"));
  assert.ok(!manifest.modules.some(({ path: name }) => name === "content/bundled.js"));
});

test("rejects unsafe, absent, native and oversized Next traced runtime files", () => {
  const cases = [
    ["outside", "../../../../outside.json"],
    ["outside executable", "../../../../outside.js"],
    ["absolute", "/tmp/outside.json"],
    ["backslash", "..\\..\\..\\content.json"],
    ["missing", "../../../missing.json"],
    ["native", "../../../addon.node"],
    ["symlink", "../../../linked.json"],
    ["symlink parent", "../../../linked/data.json"],
    ["hardlinked dependency", "../../../node_modules/dependency/package.json"],
    ["hardlinked customer file", "../../../customer-linked.json"],
    ["external dependency directory", "../../../node_modules/external"],
    ["oversized", "../../../large.bin"],
  ];
  for (const [label, traced] of cases) {
    const fixture = nextPackageFixture(1);
    fs.writeFileSync(path.join(fixture.applicationRoot, "addon.node"), "native");
    fs.writeFileSync(path.join(fixture.applicationRoot, "data.json"), "{}");
    fs.symlinkSync("data.json", path.join(fixture.applicationRoot, "linked.json"));
    fs.mkdirSync(path.join(fixture.applicationRoot, "directory"));
    fs.writeFileSync(path.join(fixture.applicationRoot, "directory", "data.json"), "{}");
    fs.symlinkSync("directory", path.join(fixture.applicationRoot, "linked"));
    fs.mkdirSync(path.join(fixture.applicationRoot, "node_modules"));
    fs.mkdirSync(path.join(fixture.applicationRoot, "node_modules", "dependency"));
    fs.linkSync(
      path.join(fixture.applicationRoot, "data.json"),
      path.join(fixture.applicationRoot, "node_modules", "dependency", "package.json"),
    );
    // Import-by-copy does not authorize hardlinks created by application code or local dependencies.
    fs.linkSync(
      path.join(fixture.applicationRoot, "data.json"),
      path.join(fixture.applicationRoot, "customer-linked.json"),
    );
    fs.symlinkSync(os.tmpdir(), path.join(fixture.applicationRoot, "node_modules", "external"));
    fs.writeFileSync(path.join(fixture.applicationRoot, "large.bin"), "x");
    fs.truncateSync(path.join(fixture.applicationRoot, "large.bin"), 5_242_881);
    writeNextTrace(fixture, [traced]);
    assert.throws(() => packageNextFixture(fixture), undefined, label);
  }
});

test("refuses Next traced runtime files named like the upload metadata part", () => {
  for (const name of ["content/metadata", "content/Metadata", "METADATA"]) {
    const fixture = nextPackageFixture(1);
    const target = path.join(fixture.applicationRoot, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{}");
    writeNextTrace(fixture, [`../../../${name}`]);
    assert.throws(() => packageNextFixture(fixture), PackagingLimitError, name);
  }
});

test("requires bounded valid Next trace evidence and retains the Worker aggregate budget", () => {
  for (const trace of ["not json", '{"version":2,"files":[]}', '{"version":1,"files":[1]}']) {
    const fixture = nextPackageFixture(1);
    fs.writeFileSync(
      path.join(fixture.applicationRoot, ".next", "server", "app", "page.js.nft.json"),
      trace,
    );
    assert.throws(() => packageNextFixture(fixture), /Next.js runtime trace/u);
  }
  const missing = nextPackageFixture(1);
  fs.unlinkSync(path.join(missing.applicationRoot, ".next", "server", "app", "page.js.nft.json"));
  assert.throws(() => packageNextFixture(missing), /Next.js runtime trace/u);
  const overBudget = nextPackageFixture(1);
  fs.writeFileSync(path.join(overBudget.applicationRoot, "runtime.bin"), Buffer.alloc(5_242_880));
  writeNextTrace(overBudget, ["../../../runtime.bin"]);
  fs.writeFileSync(
    path.join(overBudget.applicationRoot, ".ohmyhost-worker", "worker.js"),
    " ".repeat(10_485_761),
  );
  assert.throws(() => packageNextFixture(overBudget), /Worker modules exceed/u);
  const traceLimit = nextPackageFixture(1);
  fs.writeFileSync(
    path.join(traceLimit.applicationRoot, ".next", "server", "app", "page.js.nft.json"),
    " ".repeat(8_388_609),
  );
  assert.throws(() => packageNextFixture(traceLimit), /runtime trace evidence exceeds limit/u);
  const countLimit = nextPackageFixture(1);
  fs.mkdirSync(path.join(countLimit.applicationRoot, "inputs"));
  const inputs = Array.from({ length: 1000 }, (_, index) => `../../../inputs/${index}.txt`);
  for (let index = 0; index < 1000; index += 1) {
    fs.writeFileSync(path.join(countLimit.applicationRoot, "inputs", `${index}.txt`), "");
  }
  writeNextTrace(countLimit, inputs);
  assert.throws(() => packageNextFixture(countLimit), /more than 1000 modules/u);
  const compressedLimit = nextPackageFixture(1);
  const binaryInputs = ["one.bin", "two.bin", "three.bin"];
  for (const name of binaryInputs) {
    fs.writeFileSync(path.join(compressedLimit.applicationRoot, name), randomBytes(4_000_000));
  }
  writeNextTrace(
    compressedLimit,
    binaryInputs.map((name) => `../../../${name}`),
  );
  assert.throws(() => packageNextFixture(compressedLimit), /gzip-compressed bytes together/u);
});

test("preserves reachable JavaScript, ESM and WASM modules for every Worker runtime", () => {
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  for (const kind of ["functions", "vite", "tanstack", "next"]) {
    const fixture =
      kind === "functions"
        ? functionsPackageFixture()
        : kind === "vite"
          ? viteCompanionPackageFixture()
          : kind === "tanstack"
            ? tanstackEdgePackageFixture()
            : nextPackageFixture(1);
    const applicationRoot = fixture.site ?? fixture.applicationRoot;
    const bundleRoot = fixture.bundle ?? fixture.bundleRoot;
    const serverRoot = path.join(applicationRoot, fixture.environment.SERVER_OUTPUT_DIRECTORY);
    const entrypoint = path.join(applicationRoot, fixture.environment.SERVER_ENTRYPOINT);
    fs.mkdirSync(path.join(serverRoot, "codec"), { recursive: true });
    fs.writeFileSync(
      entrypoint,
      'import "./codec/loader.mjs"; export default {fetch(){return new Response("ok")}};\n',
    );
    fs.writeFileSync(
      path.join(serverRoot, "codec", "loader.mjs"),
      `import "../${path.basename(entrypoint)}"; import wasm from "./codec.wasm"; export const main = () => import("../${path.basename(entrypoint)}"); export default wasm;\n`,
    );
    fs.writeFileSync(path.join(serverRoot, "codec", "codec.wasm"), wasm);
    if (kind === "functions" || kind === "vite") {
      fs.unlinkSync(path.join(serverRoot, "wrangler.jsonc"));
      fs.writeFileSync(path.join(serverRoot, "README.md"), "wrangler dry-run\n");
      fs.writeFileSync(path.join(serverRoot, "worker.js.map"), "{}\n");
      const finalize =
        kind === "functions" ? finalizeFunctionsWorkerOutput : finalizeViteCompanionOutput;
      finalize({ applicationRoot, environment: fixture.environment });
    }
    const manifest = packageBuildArtifact({
      applicationRoot,
      bundleRoot,
      dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
      packageManagerReceiptPath: fixture.packageManagerReceiptPath,
      compressedWorkerPath: kind === "next" ? ".ohmyhost-next-worker.js.gz" : ".unused.gz",
      migrationSnapshotRoot: kind === "vite" ? path.join(applicationRoot, "migrations") : undefined,
      environment: fixture.environment,
    });
    assert.ok(
      manifest.modules.some(({ path: modulePath }) => modulePath === "codec/loader.mjs"),
      kind,
    );
    assert.equal(
      manifest.modules.find(({ path: modulePath }) => modulePath === "codec/codec.wasm")
        ?.contentType,
      "application/wasm",
      kind,
    );
    assert.match(
      fs.readFileSync(path.join(bundleRoot, "worker", "codec", "loader.mjs"), "utf8"),
      /\.\.\/index\.js/u,
      kind,
    );
    const bytes = fs.readFileSync(path.join(bundleRoot, "worker", "codec", "codec.wasm"));
    assert.deepEqual(bytes, wasm, kind);
    assert.doesNotThrow(
      () => new globalThis.WebAssembly.Instance(new globalThis.WebAssembly.Module(bytes)),
      kind,
    );
  }
});

test("keeps scheduled auxiliary modules in their own relative namespace", () => {
  const fixture = nextPackageFixture(1);
  fixture.environment.FUNCTIONS_REQUIREMENT_JSON = '{"crons":["0 3 * * *"]}';
  const serverRoot = path.join(fixture.applicationRoot, ".ohmyhost", "functions");
  fs.mkdirSync(serverRoot, { recursive: true });
  fs.writeFileSync(
    path.join(serverRoot, "worker.js"),
    'import "./cleanup.mjs"; export default {scheduled(){}};\n',
  );
  fs.writeFileSync(path.join(serverRoot, "cleanup.mjs"), "export const cleanup = true;\n");
  fs.writeFileSync(path.join(serverRoot, "worker.js.map"), "{}\n");
  fs.writeFileSync(path.join(serverRoot, "README.md"), "wrangler dry-run\n");
  finalizeFunctionsWorkerOutput({
    applicationRoot: fixture.applicationRoot,
    environment: fixture.environment,
  });
  const manifest = packageBuildArtifact({
    ...fixture,
    dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
    compressedWorkerPath: ".ohmyhost-next-worker.js.gz",
  });
  assert.ok(
    manifest.modules.some(
      ({ path: modulePath }) => modulePath === "ohmyhost-functions/cleanup.mjs",
    ),
  );
  assert.match(
    fs.readFileSync(path.join(fixture.bundleRoot, "worker", "ohmyhost-worker.js"), "utf8"),
    /\.\/ohmyhost-functions\/worker\.js/u,
  );
  assert.match(
    fs.readFileSync(
      path.join(fixture.bundleRoot, "worker", "ohmyhost-functions", "worker.js"),
      "utf8",
    ),
    /\.\/cleanup\.mjs/u,
  );
});

test("packages the bundled Worker module of declared crons beside the Next.js module", () => {
  const fixture = nextPackageFixture(1);
  fixture.environment.FUNCTIONS_REQUIREMENT_JSON = '{"crons":["0 3 * * *"]}';
  const serverRoot = path.join(fixture.applicationRoot, ".ohmyhost", "functions");
  fs.mkdirSync(serverRoot, { recursive: true });
  fs.writeFileSync(path.join(serverRoot, "worker.js"), "export default { scheduled() {} };\n");
  fs.writeFileSync(
    path.join(serverRoot, "wrangler.jsonc"),
    JSON.stringify({
      main: "worker.js",
      compatibility_date: "2026-08-21",
      compatibility_flags: ["nodejs_compat"],
    }),
  );

  const manifest = packageBuildArtifact({
    applicationRoot: fixture.applicationRoot,
    bundleRoot: fixture.bundleRoot,
    dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
    packageManagerReceiptPath: fixture.packageManagerReceiptPath,
    compressedWorkerPath: ".ohmyhost-next-worker.js.gz",
    environment: fixture.environment,
  });

  assert.deepEqual(manifest.functions, { crons: ["0 3 * * *"] });
  assert.deepEqual(
    manifest.modules.map(({ path: modulePath }) => modulePath),
    ["index.js", "ohmyhost-worker.js"],
  );
  assert.equal(
    fs.readFileSync(path.join(fixture.bundleRoot, "worker", "ohmyhost-worker.js"), "utf8"),
    "export default { scheduled() {} };\n",
  );
  assert.equal(manifest.runtime.entryWrapperVersion, "nextjs-opennext-wrapper-v1");

  const stray = nextPackageFixture(1);
  fs.mkdirSync(path.join(stray.applicationRoot, ".ohmyhost", "functions"), { recursive: true });
  assert.throws(
    () =>
      packageBuildArtifact({
        applicationRoot: stray.applicationRoot,
        bundleRoot: stray.bundleRoot,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: stray.packageManagerReceiptPath,
        compressedWorkerPath: ".ohmyhost-next-worker.js.gz",
        environment: stray.environment,
      }),
    /unexpected functions build output/u,
  );
});

test("rejects every non-root Next.js asset directory prefix", () => {
  for (const prefix of ["customer", "dev-three-word-handle", "p/not-a-project-id"]) {
    const fixture = nextPackageFixture(1);
    const prefixedRoot = path.join(
      fixture.applicationRoot,
      ".open-next",
      "assets",
      prefix,
      "_next",
    );
    fs.mkdirSync(prefixedRoot, { recursive: true });
    fs.renameSync(
      path.join(fixture.applicationRoot, ".open-next", "assets", "index.txt"),
      path.join(prefixedRoot, "index.txt"),
    );

    assert.throws(
      () =>
        packageBuildArtifact({
          applicationRoot: fixture.applicationRoot,
          bundleRoot: fixture.bundleRoot,
          dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
          packageManagerReceiptPath: fixture.packageManagerReceiptPath,
          compressedWorkerPath: ".ohmyhost-next-worker.js.gz",
          environment: fixture.environment,
        }),
      /non-root framework asset prefix/u,
    );
  }
});

test("rejects compiled non-root asset references for Next.js, Vite, and TanStack", () => {
  const nextFixture = nextPackageFixture(1);
  fs.writeFileSync(
    path.join(nextFixture.applicationRoot, ".open-next", "assets", "index.txt"),
    'self.__next = "/customer/_next/static/chunk.js";',
  );
  assert.throws(
    () =>
      packageBuildArtifact({
        applicationRoot: nextFixture.applicationRoot,
        bundleRoot: nextFixture.bundleRoot,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: nextFixture.packageManagerReceiptPath,
        compressedWorkerPath: ".ohmyhost-next-worker.js.gz",
        environment: nextFixture.environment,
      }),
    /non-root framework asset prefix/u,
  );

  const nextRuntimeFixture = nextPackageFixture(1);
  fs.writeFileSync(
    path.join(nextRuntimeFixture.applicationRoot, ".ohmyhost-worker", "worker.js"),
    'export default { prefix: "https://cdn.example.com/_next/static/chunk.js" };',
  );
  assert.throws(
    () =>
      packageBuildArtifact({
        applicationRoot: nextRuntimeFixture.applicationRoot,
        bundleRoot: nextRuntimeFixture.bundleRoot,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: nextRuntimeFixture.packageManagerReceiptPath,
        compressedWorkerPath: ".ohmyhost-next-worker.js.gz",
        environment: nextRuntimeFixture.environment,
      }),
    /non-root framework asset prefix/u,
  );

  for (const adapter of ["vite-static", "tanstack-start"]) {
    for (const assetReference of ["/customer/assets/app.js", "./assets/app.js"]) {
      const fixture = staticPackageFixture();
      fixture.environment.FRAMEWORK_ADAPTER = adapter;
      fs.writeFileSync(
        path.join(fixture.site, "dist", "index.html"),
        `<!doctype html><script src="${assetReference}"></script>`,
      );
      assert.throws(
        () =>
          packageBuildArtifact({
            applicationRoot: fixture.site,
            bundleRoot: fixture.bundle,
            dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
            packageManagerReceiptPath: fixture.packageManagerReceiptPath,
            compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
            environment: fixture.environment,
          }),
        /non-root framework asset prefix/u,
      );
    }
  }
});

test("accepts relative TanStack Worker chunk imports while rejecting public non-root assets", () => {
  for (const moduleSpecifier of [
    'import "./assets/chunk.js";',
    'import "./assets/chunk.js" with { type: "json" };',
    'import /* comment */ "./assets/chunk.js";',
    'import chunk from "./assets/chunk.js"; void chunk;',
    'import { chunk } from "./assets/chunk.js"; void chunk;',
    'import defaultChunk, { chunk } from "./assets/chunk.js"; void defaultChunk;',
    'export { chunk } from "./assets/chunk.js";',
    'void import("./assets/chunk.js");',
    'void import(/* comment */ "./assets/chunk.js");',
    'void import("./assets/chunk.js", { with: { type: "json" } });',
  ]) {
    const fixture = tanstackEdgePackageFixture();
    fs.writeFileSync(
      path.join(fixture.site, "dist", "server", "index.js"),
      `${moduleSpecifier} export default { fetch() { return new Response("ok"); } };\n`,
    );
    let manifest;
    assert.doesNotThrow(() => {
      manifest = packageBuildArtifact({
        applicationRoot: fixture.site,
        bundleRoot: fixture.bundle,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: fixture.packageManagerReceiptPath,
        compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
        environment: fixture.environment,
      });
    }, moduleSpecifier);
    assert.equal(manifest.runtime.entryWrapperVersion, "tanstack-edge-wrapper-v1");
    assert.deepEqual(
      manifest.modules.map(({ path: modulePath }) => modulePath),
      ["assets/chunk.js", "index.js"],
    );
  }

  // A full HTML document can use an external content image, whether served as a page or sent as
  // transactional mail. The image URL is not the Vite asset base used by the application.
  const emailFixture = tanstackEdgePackageFixture();
  fs.writeFileSync(
    path.join(emailFixture.site, "dist", "server", "index.js"),
    'function email(x){return `<!doctype html><html lang="${x}"><body><img src="https://brand.example.test/brand/assets/logo.png" width="194"></body></html>`;} export default { fetch() { return new Response(email("en")); } };\n',
  );
  assert.doesNotThrow(() =>
    packageBuildArtifact({
      applicationRoot: emailFixture.site,
      bundleRoot: emailFixture.bundle,
      dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
      packageManagerReceiptPath: emailFixture.packageManagerReceiptPath,
      compressedWorkerPath: path.join(emailFixture.repository, "unused.gz"),
      environment: emailFixture.environment,
    }),
  );

  const exactRegexRuntimeFixture = tanstackEdgePackageFixture();
  fs.writeFileSync(
    path.join(exactRegexRuntimeFixture.site, "dist", "server", "index.js"),
    'export default { fetch() { if (true) {} /[import("./assets/app.js")]/.source.slice(9, -3).split().forEach((url) => fetch(url)); return new Response("ok"); } };\n',
  );
  assert.throws(
    () =>
      packageBuildArtifact({
        applicationRoot: exactRegexRuntimeFixture.site,
        bundleRoot: exactRegexRuntimeFixture.bundle,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: exactRegexRuntimeFixture.packageManagerReceiptPath,
        compressedWorkerPath: path.join(exactRegexRuntimeFixture.repository, "unused.gz"),
        environment: exactRegexRuntimeFixture.environment,
      }),
    /non-root framework asset prefix/u,
  );

  for (const publicAssetReference of [
    'return new Response("/customer/assets/app.js")',
    'return new Response("https://cdn.example.com/assets/app.js")',
    'return `<!doctype html><html><body><script src="https://cdn.example.com/assets/app.js"></script></body></html>`',
    'return `<!doctype html><html><head><link rel="stylesheet" href="https://cdn.example.com/assets/site.css"></head><body></body></html>`',
    'return `<!doctype html><html><head><base href="https://cdn.example.com/assets/"></head><body></body></html>`',
    'return new URL("https://cdn.example.com/assets/logo.png", request.url)',
    'const asset = `<!doctype html><html><body><img src="https://cdn.example.com/assets/app.js"></body></html>`; return fetch(asset)',
    'return `<img src="https://cdn.example.com/assets/app.js">`',
    'return new Response("customer/assets/app.js")',
    'return fetch("./assets/app.js")',
    'return fetch("../assets/app.js")',
    'return new URL("./assets/app.js", request.url)',
    'return new Response("./assets/app.js")',
    '// import "./assets/app.js"',
    'const source = "import ./assets/app.js"',
    "const source = './assets/app.js",
    "const source = `./assets/app.js`",
    'import chunk extra from "./assets/app.js"',
    'import { chunk; } from "./assets/app.js"',
    'void import("./" + "assets/app.js")',
    'void import("./assets/app.js"',
    'if (true) {} /[import("./assets/app.js")]/.source.slice(9, -3).split().forEach((url) => fetch(url));',
    'if (true) {} /[import(/* comment */ "./assets/app.js")]/.source;',
    'if (true) /[import("./assets/app.js")]/.source;',
    'const value = {}; /[import("./assets/app.js")]/.source;',
    'const value = []; /[import("./assets/app.js")]/.source;',
  ]) {
    const adversarialFixture = tanstackEdgePackageFixture();
    fs.writeFileSync(
      path.join(adversarialFixture.site, "dist", "server", "index.js"),
      `export default { fetch() { ${publicAssetReference}; } };\n`,
    );
    assert.throws(
      () =>
        packageBuildArtifact({
          applicationRoot: adversarialFixture.site,
          bundleRoot: adversarialFixture.bundle,
          dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
          packageManagerReceiptPath: adversarialFixture.packageManagerReceiptPath,
          compressedWorkerPath: path.join(adversarialFixture.repository, "unused.gz"),
          environment: adversarialFixture.environment,
        }),
      /non-root framework asset prefix/u,
      publicAssetReference,
    );
  }
});

test("accepts the two exact TanStack generated metadata forms", () => {
  const clientFixture = staticPackageFixture();
  fs.writeFileSync(
    path.join(clientFixture.site, "dist", "index.js"),
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/routes-index.js","assets/vendor-chunk.js"])))=>i.map(i=>d[i]);\n',
  );
  assert.doesNotThrow(() =>
    packageBuildArtifact({
      applicationRoot: clientFixture.site,
      bundleRoot: clientFixture.bundle,
      dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
      packageManagerReceiptPath: clientFixture.packageManagerReceiptPath,
      compressedWorkerPath: path.join(clientFixture.repository, "unused.gz"),
      environment: clientFixture.environment,
    }),
  );

  const workerFixture = tanstackEdgePackageFixture();
  fs.writeFileSync(
    path.join(workerFixture.site, "dist", "server", "index.js"),
    '//#region src/assets/hero-maasstudio.jpg\nexport const hero = "/assets/hero-maasstudio.jpg";\nexport default { fetch() { return new Response("ok"); } };\n',
  );
  assert.doesNotThrow(() =>
    packageBuildArtifact({
      applicationRoot: workerFixture.site,
      bundleRoot: workerFixture.bundle,
      dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
      packageManagerReceiptPath: workerFixture.packageManagerReceiptPath,
      compressedWorkerPath: path.join(workerFixture.repository, "unused.gz"),
      environment: workerFixture.environment,
    }),
  );
});

test("accepts only the canonical TanStack Wrangler redirect and the standard index entry", () => {
  const fixture = tanstackEdgePackageFixture();
  assert.equal(fs.statSync(path.join(fixture.site, ".wrangler", "deploy", "config.json")).size, 70);
  assert.doesNotThrow(() =>
    validateTanStackBuildOutput({
      applicationRoot: fixture.site,
      environment: fixture.environment,
    }),
  );
  const inputPath = path.join(fixture.site, ".ohmyhost-tanstack-wrangler.jsonc");
  createTanStackPlatformConfig({
    applicationRoot: fixture.site,
    outputPath: inputPath,
    environment: fixture.environment,
  });
  assert.doesNotThrow(() =>
    packageBuildArtifact({
      applicationRoot: fixture.site,
      bundleRoot: fixture.bundle,
      dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
      packageManagerReceiptPath: fixture.packageManagerReceiptPath,
      compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
      environment: fixture.environment,
    }),
  );
  assert.equal(fs.existsSync(inputPath), false);

  for (const redirect of [
    "../../dist/client/wrangler.json",
    "../../../outside/wrangler.json",
    "/tmp/wrangler.json",
    "../../dist/server/../client/wrangler.json",
  ]) {
    const invalid = tanstackEdgePackageFixture();
    fs.writeFileSync(
      path.join(invalid.site, ".wrangler", "deploy", "config.json"),
      JSON.stringify({ configPath: redirect, auxiliaryWorkers: [] }),
    );
    assert.throws(
      () =>
        validateTanStackBuildOutput({
          applicationRoot: invalid.site,
          environment: invalid.environment,
        }),
      /TanStack Worker (?:output is invalid|redirect is unsafe)/u,
    );
  }

  const extraKey = tanstackEdgePackageFixture();
  fs.writeFileSync(
    path.join(extraKey.site, ".wrangler", "deploy", "config.json"),
    JSON.stringify({
      configPath: "../../dist/server/wrangler.json",
      auxiliaryWorkers: [],
      worker: "auxiliary",
    }),
  );
  assert.throws(
    () =>
      validateTanStackBuildOutput({
        applicationRoot: extraKey.site,
        environment: extraKey.environment,
      }),
    /TanStack Worker output is invalid/u,
  );

  for (const field of ["auxiliaryWorkers", "prerenderWorkerConfigPath"]) {
    const invalid = tanstackEdgePackageFixture();
    const redirectPath = path.join(invalid.site, ".wrangler", "deploy", "config.json");
    const redirect = { configPath: "../../dist/server/wrangler.json", auxiliaryWorkers: [] };
    if (field === "auxiliaryWorkers")
      redirect.auxiliaryWorkers = [{ configPath: "../../dist/auxiliary/wrangler.json" }];
    else redirect.prerenderWorkerConfigPath = "../../dist/prerender/wrangler.json";
    fs.writeFileSync(redirectPath, JSON.stringify(redirect));
    assert.throws(
      () =>
        validateTanStackBuildOutput({
          applicationRoot: invalid.site,
          environment: invalid.environment,
        }),
      /TanStack Worker output is invalid/u,
      field,
    );
  }

  const nonCanonical = tanstackEdgePackageFixture();
  fs.writeFileSync(
    path.join(nonCanonical.site, ".wrangler", "deploy", "config.json"),
    `${JSON.stringify({ configPath: "../../dist/server/wrangler.json", auxiliaryWorkers: [] })}\n`,
  );
  assert.throws(
    () =>
      validateTanStackBuildOutput({
        applicationRoot: nonCanonical.site,
        environment: nonCanonical.environment,
      }),
    /TanStack Worker output is invalid/u,
  );

  const auxiliary = tanstackEdgePackageFixture();
  fs.writeFileSync(path.join(auxiliary.site, ".wrangler", "deploy", "auxiliary.js"), "worker");
  assert.throws(
    () =>
      validateTanStackBuildOutput({
        applicationRoot: auxiliary.site,
        environment: auxiliary.environment,
      }),
    /TanStack Worker output is invalid/u,
  );

  for (const custody of ["symlink", "hardlink"]) {
    const invalid = tanstackEdgePackageFixture();
    const redirectPath = path.join(invalid.site, ".wrangler", "deploy", "config.json");
    const original = fs.readFileSync(redirectPath);
    fs.unlinkSync(redirectPath);
    if (custody === "symlink") {
      fs.symlinkSync(path.join(invalid.repository, "redirect-target.json"), redirectPath);
    } else {
      const target = path.join(invalid.repository, "redirect-target.json");
      fs.writeFileSync(target, original);
      fs.linkSync(target, redirectPath);
    }
    assert.throws(
      () =>
        validateTanStackBuildOutput({
          applicationRoot: invalid.site,
          environment: invalid.environment,
        }),
      /TanStack Worker (?:output is invalid|redirect is unsafe)/u,
      custody,
    );
  }

  for (const mode of ["neither", "server-only", "both"]) {
    const invalid = tanstackEdgePackageFixture();
    const indexPath = path.join(invalid.site, "dist", "server", "index.js");
    const serverPath = path.join(invalid.site, "dist", "server", "server.js");
    fs.rmSync(indexPath);
    if (mode !== "neither") fs.writeFileSync(serverPath, "export default {}\n");
    if (mode === "both") fs.writeFileSync(indexPath, "export default {}\n");
    assert.throws(
      () =>
        validateTanStackBuildOutput({
          applicationRoot: invalid.site,
          environment: invalid.environment,
        }),
      /TanStack Worker output is invalid/u,
      mode,
    );
  }
});

test("regresses the f644 assets-only TanStack output to a hard failure", () => {
  const fixture = tanstackEdgePackageFixture();
  const serverRoot = path.join(fixture.site, "dist", "server");
  fs.rmSync(path.join(serverRoot, "index.js"));
  fs.rmSync(path.join(serverRoot, "wrangler.json"));
  fs.writeFileSync(path.join(serverRoot, "server.js"), "export default {}\n");
  fs.writeFileSync(
    path.join(fixture.site, "dist", "client", "wrangler.json"),
    JSON.stringify({ assets: { directory: "." } }),
  );
  fs.writeFileSync(
    path.join(fixture.site, ".wrangler", "deploy", "config.json"),
    JSON.stringify({ configPath: "../../dist/client/wrangler.json", auxiliaryWorkers: [] }),
  );
  assert.throws(
    () =>
      packageBuildArtifact({
        applicationRoot: fixture.site,
        bundleRoot: fixture.bundle,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: fixture.packageManagerReceiptPath,
        compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
        environment: fixture.environment,
      }),
    /generated Worker config is unsafe|TanStack Worker output is invalid/u,
  );
});

test("accepts the exact empty TanStack metadata generated by Wrangler", () => {
  const fixture = tanstackEdgePackageFixture();
  const configPath = path.join(fixture.site, "dist", "server", "wrangler.json");
  const generated = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.deepEqual(generated.definedEnvironments, []);
  assert.deepEqual(generated.dev, {
    enable_containers: true,
    generate_types: false,
    ip: "localhost",
    local_protocol: "http",
    upstream_protocol: "http",
  });
  assert.doesNotThrow(() =>
    validateTanStackBuildOutput({
      applicationRoot: fixture.site,
      environment: fixture.environment,
    }),
  );
  // Cloudflare Vite plugin 1.64 adds this optional, empty generated field. A populated field
  // or an unrecognized capability still cannot enter the platform-owned Worker.
  generated.k2 = [];
  fs.writeFileSync(configPath, JSON.stringify(generated));
  assert.doesNotThrow(() =>
    validateTanStackBuildOutput({
      applicationRoot: fixture.site,
      environment: fixture.environment,
    }),
  );
  for (const invalid of [null, {}, ["binding"]]) {
    generated.k2 = invalid;
    fs.writeFileSync(configPath, JSON.stringify(generated));
    assert.throws(() =>
      validateTanStackBuildOutput({
        applicationRoot: fixture.site,
        environment: fixture.environment,
      }),
    );
  }
  generated.k2 = [];
  generated.unrecognized = [];
  fs.writeFileSync(configPath, JSON.stringify(generated));
  assert.throws(() =>
    validateTanStackBuildOutput({
      applicationRoot: fixture.site,
      environment: fixture.environment,
    }),
  );
  delete generated.unrecognized;
  generated.upload_source_maps = true;
  fs.writeFileSync(configPath, JSON.stringify(generated));
  assert.throws(
    () =>
      validateTanStackBuildOutput({
        applicationRoot: fixture.site,
        environment: fixture.environment,
      }),
    (error) => packagingFailureLine(error)?.includes("contains source maps") === true,
  );
  delete generated.upload_source_maps;
  fs.writeFileSync(configPath, JSON.stringify(generated));
  fs.writeFileSync(path.join(fixture.site, "dist", "server", "index.js.map"), "{}");
  assert.throws(
    () =>
      validateTanStackBuildOutput({
        applicationRoot: fixture.site,
        environment: fixture.environment,
      }),
    (error) =>
      packagingFailureLine(error) ===
      "ohmyho.st packaging: the TanStack Worker output contains source maps; set environments.ssr.build.sourcemap to false in the Vite configuration and deploy again",
  );
});

test("rejects every nonempty generated TanStack provider capability", () => {
  const nonemptyCapabilities = {
    triggers: { crons: ["* * * * *"] },
    vars: { PLATFORM_SECRET: "must-reject" },
    durable_objects: { bindings: [{ class_name: "State", name: "STATE" }] },
    workflows: [{ binding: "WORKFLOW", name: "workflow" }],
    migrations: [{ tag: "v1" }],
    exports: { handler: "must-reject" },
    kv_namespaces: [{ binding: "KV", id: "must-reject" }],
    cloudchamber: { image: "must-reject" },
    send_email: [{ name: "MAIL" }],
    queues: { consumers: [{ queue: "must-reject" }], producers: [] },
    connect: [{ host: "must-reject.example" }],
    r2_buckets: [{ binding: "BUCKET", bucket_name: "must-reject" }],
    d1_databases: [{ binding: "DATABASE", database_id: "must-reject" }],
    vectorize: [{ binding: "INDEX", index_name: "must-reject" }],
    ai_search_namespaces: [{ binding: "SEARCH", index_name: "must-reject" }],
    ai_search: [{ binding: "SEARCH", index_name: "must-reject" }],
    agent_memory: [{ binding: "MEMORY" }],
    hyperdrive: [{ binding: "HYPERDRIVE", id: "must-reject" }],
    services: [{ binding: "SERVICE", service: "must-reject" }],
    analytics_engine_datasets: [{ binding: "ANALYTICS", dataset: "must-reject" }],
    dispatch_namespaces: [{ binding: "DISPATCH", namespace: "must-reject" }],
    mtls_certificates: [{ binding: "MTLS", certificate_id: "must-reject" }],
    pipelines: [{ binding: "PIPELINE", pipeline: "must-reject" }],
    secrets_store_secrets: [{ binding: "SECRET", secret_name: "must-reject" }],
    artifacts: [{ binding: "ARTIFACT", id: "must-reject" }],
    unsafe_hello_world: [{ binding: "UNSAFE" }],
    flagship: [{ binding: "FLAGSHIP" }],
    worker_loaders: [{ binding: "LOADER" }],
    ratelimits: [{ binding: "RATE_LIMIT" }],
    vpc_services: [{ binding: "VPC_SERVICE", service_id: "must-reject" }],
    vpc_networks: [{ binding: "VPC_NETWORK", network_id: "must-reject" }],
    logfwdr: { bindings: [{ name: "LOGFWDR" }] },
    python_modules: { exclude: ["**/*.pyc", "must-reject.py"] },
  };
  for (const [field, value] of Object.entries(nonemptyCapabilities)) {
    const fixture = tanstackEdgePackageFixture();
    const configPath = path.join(fixture.site, "dist", "server", "wrangler.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config[field] = value;
    fs.writeFileSync(configPath, JSON.stringify(config));
    assert.throws(
      () =>
        packageBuildArtifact({
          applicationRoot: fixture.site,
          bundleRoot: fixture.bundle,
          dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
          packageManagerReceiptPath: fixture.packageManagerReceiptPath,
          compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
          environment: fixture.environment,
        }),
      /generated Worker config capability is invalid/u,
      field,
    );
  }
});

test("rejects nonempty TanStack metadata and adversarial dev defaults", () => {
  const metadataFixture = tanstackEdgePackageFixture();
  const metadataPath = path.join(metadataFixture.site, "dist", "server", "wrangler.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  metadata.definedEnvironments = ["production"];
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  assert.throws(
    () =>
      validateTanStackBuildOutput({
        applicationRoot: metadataFixture.site,
        environment: metadataFixture.environment,
      }),
    /generated Worker config metadata is invalid/u,
  );

  const defaultDev = {
    enable_containers: true,
    generate_types: false,
    ip: "localhost",
    local_protocol: "http",
    upstream_protocol: "http",
  };
  const adversarialDevValues = [
    [[], "wrong shape"],
    [{ ...defaultDev, bindings: [{ name: "UNTRUSTED_BINDING" }] }, "provider binding"],
    [
      {
        enable_containers: true,
        generate_types: false,
        local_protocol: "http",
        upstream_protocol: "http",
      },
      "missing key",
    ],
    [{ ...defaultDev, enable_containers: false }, "enable_containers drift"],
    [{ ...defaultDev, generate_types: true }, "generate_types drift"],
    [{ ...defaultDev, ip: "0.0.0.0" }, "ip drift"],
    [{ ...defaultDev, local_protocol: "https" }, "local_protocol drift"],
    [{ ...defaultDev, upstream_protocol: "https" }, "upstream_protocol drift"],
  ];
  for (const [dev, description] of adversarialDevValues) {
    const fixture = tanstackEdgePackageFixture();
    const configPath = path.join(fixture.site, "dist", "server", "wrangler.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.dev = dev;
    fs.writeFileSync(configPath, JSON.stringify(config));
    assert.throws(
      () =>
        validateTanStackBuildOutput({
          applicationRoot: fixture.site,
          environment: fixture.environment,
        }),
      /generated Worker config metadata is invalid/u,
      description,
    );
  }
});

test("rejects lookalike TanStack generated metadata", () => {
  const invalidMapTables = [
    'const __vite__mapDeps = (i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/routes-index.js"])))=>i.map(i=>d[i]);\n',
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["/assets/routes-index.js"])))=>i.map(i=>d[i]);\n',
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/../routes-index.js"])))=>i.map(i=>d[i]);\n',
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/routes-index.js"],evil)))=>i.map(i=>d[i]);\n',
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets\\/routes-index.js"])))=>i.map(i=>d[i]);\n',
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["https://cdn.example.com/assets/routes-index.js"])))=>i.map(i=>d[i]);\n',
    '/*\nconst __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/routes-index.js"])))=>i.map(i=>d[i]);\n*/\n',
    'const value = `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/routes-index.js"])))=>i.map(i=>d[i]);`;\n',
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/routes-index.js"])))=>i.map(i=>d[i]);\nconst __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/other.js"])))=>i.map(i=>d[i]);\n',
  ];
  for (const body of invalidMapTables) {
    const fixture = staticPackageFixture();
    fs.writeFileSync(path.join(fixture.site, "dist", "index.js"), body);
    assert.throws(
      () =>
        packageBuildArtifact({
          applicationRoot: fixture.site,
          bundleRoot: fixture.bundle,
          dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
          packageManagerReceiptPath: fixture.packageManagerReceiptPath,
          compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
          environment: fixture.environment,
        }),
      /non-root framework asset prefix/u,
      body,
    );
  }

  const nextFixture = nextPackageFixture(1);
  fs.writeFileSync(
    path.join(nextFixture.applicationRoot, ".ohmyhost-worker", "worker.js"),
    'const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/routes-index.js"])))=>i.map(i=>d[i]);\n',
  );
  assert.throws(
    () =>
      packageBuildArtifact({
        applicationRoot: nextFixture.applicationRoot,
        bundleRoot: nextFixture.bundleRoot,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: nextFixture.packageManagerReceiptPath,
        compressedWorkerPath: ".ohmyhost-next-worker.js.gz",
        environment: nextFixture.environment,
      }),
    /non-root framework asset prefix/u,
  );

  const invalidSourceRegions = [
    "//#region src/assets/../hero-maasstudio.jpg\n",
    "//#region src/assets/hero-maasstudio.jpg extra\n",
    "/*\n//#region src/assets/hero-maasstudio.jpg\n*/\n",
    "const comment = `\n//#region src/assets/hero-maasstudio.jpg\n`;\n",
    "//#region src/assets/hero-maasstudio.jpg // extra\n",
  ];
  for (const comment of invalidSourceRegions) {
    const fixture = tanstackEdgePackageFixture();
    fs.writeFileSync(
      path.join(fixture.site, "dist", "server", "index.js"),
      `${comment}export const hero = "/assets/hero-maasstudio.jpg";\nexport default { fetch() { return new Response("ok"); } };\n`,
    );
    assert.throws(
      () =>
        packageBuildArtifact({
          applicationRoot: fixture.site,
          bundleRoot: fixture.bundle,
          dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
          packageManagerReceiptPath: fixture.packageManagerReceiptPath,
          compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
          environment: fixture.environment,
        }),
      /non-root framework asset prefix/u,
      comment,
    );
  }
});

test("rejects a parse-invalid escaped template lookalike", () => {
  const fixture = tanstackEdgePackageFixture();
  const body = String.raw`const confuse = /\x60/; const runtimePath = \x60
//#region src/assets/evil.js
\x60.trim().slice(14); export default { fetch(){ return fetch(runtimePath); } };`;
  fs.writeFileSync(path.join(fixture.site, "dist", "server", "index.js"), body);
  assert.throws(
    () =>
      packageBuildArtifact({
        applicationRoot: fixture.site,
        bundleRoot: fixture.bundle,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: fixture.packageManagerReceiptPath,
        compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
        environment: fixture.environment,
      }),
    /non-root framework asset prefix/u,
  );
});

test("rejects a valid regex-template source-region lookalike", () => {
  const fixture = tanstackEdgePackageFixture();
  const tick = String.fromCharCode(96);
  const body =
    `const confuse = /${tick}/; const runtimePath = ${tick}\n` +
    `//#region src/assets/evil.js\n` +
    `${tick}.trim().slice(14); export default { fetch(){ return fetch(runtimePath); } };`;
  fs.writeFileSync(path.join(fixture.site, "dist", "server", "index.js"), body);
  assert.doesNotThrow(() => parseJavaScript(body, { ecmaVersion: "latest", sourceType: "module" }));
  assert.throws(
    () =>
      packageBuildArtifact({
        applicationRoot: fixture.site,
        bundleRoot: fixture.bundle,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: fixture.packageManagerReceiptPath,
        compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
        environment: fixture.environment,
      }),
    /non-root framework asset prefix/u,
  );
});

test("uses parser comment ranges across regex, division, template, and escape boundaries", () => {
  const acceptedCommentBodies = [
    "const confuse = /`/;\n//#region src/assets/evil.js\nexport default 1;",
    "const confuse = /[`]/;\n//#region src/assets/evil.js\nexport default 1;",
    "const confuse = /\\`/;\n//#region src/assets/evil.js\nexport default 1;",
    "const confuse = 4 / 2 / /`/;\n//#region src/assets/evil.js\nexport default 1;",
    "const confuse = /\\/\\/#region src\\/assets\\/evil\\.js/;\nexport default 1;",
  ];
  for (const body of acceptedCommentBodies) {
    const fixture = tanstackEdgePackageFixture();
    fs.writeFileSync(path.join(fixture.site, "dist", "server", "index.js"), body);
    assert.doesNotThrow(() =>
      packageBuildArtifact({
        applicationRoot: fixture.site,
        bundleRoot: fixture.bundle,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: fixture.packageManagerReceiptPath,
        compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
        environment: fixture.environment,
      }),
    );
  }

  const templateBodies = [
    "const runtimePath = `\n//#region src/assets/evil.js\n`; export default { fetch(){ return fetch(runtimePath); } };",
    "const runtimePath = `\\`\n//#region src/assets/evil.js\n`; export default { fetch(){ return fetch(runtimePath); } };",
  ];
  for (const body of templateBodies) {
    const fixture = tanstackEdgePackageFixture();
    fs.writeFileSync(path.join(fixture.site, "dist", "server", "index.js"), body);
    assert.throws(
      () =>
        packageBuildArtifact({
          applicationRoot: fixture.site,
          bundleRoot: fixture.bundle,
          dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
          packageManagerReceiptPath: fixture.packageManagerReceiptPath,
          compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
          environment: fixture.environment,
        }),
      /non-root framework asset prefix/u,
      body,
    );
  }
});

test("accepts compiled root-origin framework asset references", () => {
  const nextFixture = nextPackageFixture(1);
  fs.writeFileSync(
    path.join(nextFixture.applicationRoot, ".open-next", "assets", "index.txt"),
    'self.__next = "/_next/static/chunk.js";',
  );
  assert.equal(
    packageBuildArtifact({
      applicationRoot: nextFixture.applicationRoot,
      bundleRoot: nextFixture.bundleRoot,
      dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
      packageManagerReceiptPath: nextFixture.packageManagerReceiptPath,
      compressedWorkerPath: ".ohmyhost-next-worker.js.gz",
      environment: nextFixture.environment,
    }).runtime.entryWrapperVersion,
    "nextjs-opennext-wrapper-v1",
  );

  const viteFixture = staticPackageFixture();
  fs.writeFileSync(
    path.join(viteFixture.site, "dist", "index.html"),
    '<!doctype html><script src="/assets/app.js"></script>',
  );
  assert.deepEqual(
    packageBuildArtifact({
      applicationRoot: viteFixture.site,
      bundleRoot: viteFixture.bundle,
      dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
      packageManagerReceiptPath: viteFixture.packageManagerReceiptPath,
      compressedWorkerPath: path.join(viteFixture.repository, "unused.gz"),
      environment: viteFixture.environment,
    }).assets.map(({ path: assetPath }) => assetPath),
    ["/Z.html", "/_locale.html", "/index.html"],
  );
});

test("packaging stays below the selected root and creates deterministic root-bound archives", () => {
  const fixture = staticPackageFixture();
  const manifest = packageBuildArtifact({
    applicationRoot: fixture.site,
    bundleRoot: fixture.bundle,
    dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
    packageManagerReceiptPath: fixture.packageManagerReceiptPath,
    compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
    environment: fixture.environment,
  });
  assert.equal(manifest.applicationRoot, "site");
  assert.equal(manifest.frameworkPlanSchemaVersion, "ohmyhost.framework-plan/v5");
  assert.equal(manifest.lifecycleEvidence.buildSandbox.projectName, "ohmyho-sandbox-vite");
  assert.equal(
    manifest.lifecycleEvidence.configurationDigest,
    createHash("sha256")
      .update(fs.readFileSync(path.join(fixture.repository, "ohmyhost.yaml")))
      .digest("hex"),
  );
  assert.deepEqual(manifest.auth, { provider: "none" });
  assert.deepEqual(manifest.storage, { enabled: false });
  assert.deepEqual(
    manifest.assets.map((asset) => asset.path),
    ["/Z.html", "/_locale.html", "/index.html"],
  );
  assert.equal(
    fs.readFileSync(path.join(fixture.bundle, "assets", "index.html"), "utf8"),
    "<!doctype html><title>nested</title>",
  );

  const first = path.join(fixture.repository, "first.tar.gz");
  const second = path.join(fixture.repository, "second.tar.gz");
  const firstReceipt = createBuildArtifactArchive({
    bundleRoot: fixture.bundle,
    outputPath: first,
  });
  const secondReceipt = createBuildArtifactArchive({
    bundleRoot: fixture.bundle,
    outputPath: second,
  });
  assert.equal(firstReceipt.sha256, secondReceipt.sha256);
  assert.deepEqual(fs.readFileSync(first), fs.readFileSync(second));
});

test("names every broken build-output limit in one customer-safe packaging line", () => {
  const refusal = (fixture) => {
    try {
      packageBuildArtifact({
        applicationRoot: fixture.site,
        bundleRoot: fixture.bundle,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: fixture.packageManagerReceiptPath,
        compressedWorkerPath: ".unused.gz",
        environment: fixture.environment,
      });
    } catch (error) {
      assert.ok(error instanceof PackagingLimitError);
      return packagingFailureLine(error);
    }
    return assert.fail("packaging succeeded");
  };
  const oversized = staticPackageFixture();
  fs.mkdirSync(path.join(oversized.site, "dist", "videos"));
  fs.writeFileSync(path.join(oversized.site, "dist", "videos", "hero.mp4"), "");
  fs.truncateSync(path.join(oversized.site, "dist", "videos", "hero.mp4"), 14_680_064);
  assert.equal(
    refusal(oversized),
    "ohmyho.st packaging: /videos/hero.mp4 is 14680064 bytes; each static file may be at most 10485760 bytes (25 MiB and 1,000 files in total)",
  );
  const heavy = staticPackageFixture();
  for (const name of ["a.bin", "b.bin", "c.bin"]) {
    fs.writeFileSync(path.join(heavy.site, "dist", name), "");
    fs.truncateSync(path.join(heavy.site, "dist", name), 9 * 1024 * 1024);
  }
  assert.equal(
    refusal(heavy),
    "ohmyho.st packaging: the static files in dist exceed 26214400 bytes together; each static file may be at most 10485760 bytes (25 MiB and 1,000 files in total)",
  );
  const numerous = staticPackageFixture();
  for (let index = 0; index < 998; index += 1) {
    fs.writeFileSync(path.join(numerous.site, "dist", `page-${String(index)}.html`), "x");
  }
  assert.equal(
    refusal(numerous),
    "ohmyho.st packaging: dist has 1001 static files; at most 1,000 are allowed (each at most 10485760 bytes, 25 MiB in total)",
  );
  const headless = staticPackageFixture();
  fs.rmSync(path.join(headless.site, "dist", "index.html"));
  assert.equal(
    refusal(headless),
    "ohmyho.st packaging: dist has no index.html; a static site serves index.html from the top of its build output",
  );
  const module = functionsPackageFixture();
  fs.truncateSync(path.join(module.site, ".ohmyhost", "functions", "worker.js"), 5_242_881);
  assert.equal(
    refusal(module),
    "ohmyho.st packaging: the functions Worker module is 5242881 bytes; a Worker module may be at most 5242880 bytes",
  );

  const bundleRoot = path.join(temporaryDirectory(), "bundle");
  fs.mkdirSync(path.join(bundleRoot, "assets"), { recursive: true });
  fs.writeFileSync(path.join(bundleRoot, "manifest.json"), "{}");
  fs.writeFileSync(path.join(bundleRoot, "sbom.cdx.json"), "{}");
  // Random bytes do not compress, so the gzip artifact stays above its 30 MiB bound.
  fs.writeFileSync(path.join(bundleRoot, "assets", "noise.bin"), randomBytes(31_500_000));
  let artifactRefusal;
  try {
    createBuildArtifactArchive({ bundleRoot, outputPath: path.join(bundleRoot, "..", "a.tar.gz") });
  } catch (error) {
    artifactRefusal = packagingFailureLine(error);
  }
  assert.match(
    artifactRefusal ?? "",
    /^ohmyho\.st packaging: the compressed deployment artifact is \d{8} bytes; it may be at most 31457280 bytes \(static files, Worker modules and migrations together\)$/u,
  );
  fs.truncateSync(path.join(bundleRoot, "assets", "noise.bin"), 64 * 1024 * 1024);
  let expandedRefusal;
  const expandedOutput = path.join(bundleRoot, "..", "expanded.tar.gz");
  try {
    createBuildArtifactArchive({ bundleRoot, outputPath: expandedOutput });
  } catch (error) {
    assert.ok(error instanceof PackagingLimitError);
    expandedRefusal = packagingFailureLine(error);
  }
  assert.equal(
    expandedRefusal,
    "ohmyho.st packaging: the expanded deployment artifact is 67112448 bytes; it may be at most 67108864 bytes (USTAR headers, padding and all artifact files together)",
  );
  assert.equal(fs.existsSync(expandedOutput), false);
  assert.equal(packagingFailureLine(new Error("unsafe build output")), null);
  assert.equal(
    packagingFailureLine(new Error("generated Worker config capability is invalid")),
    "ohmyho.st packaging: the TanStack Worker output declares an unsupported Cloudflare capability; remove it from the build configuration and deploy again",
  );
  assert.equal(
    packagingFailureLine(new Error("compiled output contains a non-root framework asset prefix")),
    "ohmyho.st packaging: compiled framework assets use a non-root prefix; configure the framework asset base as '/' and deploy again",
  );
});

test("artifact packaging rejects a malformed build identity", () => {
  for (const buildId of [
    "missing-separator",
    ":opaque",
    "a:opaque",
    "bad.project:opaque",
    `${"a".repeat(151)}:opaque`,
    "valid-project:",
  ]) {
    const fixture = staticPackageFixture();
    fixture.environment.BUILD_ID = buildId;
    assert.throws(
      () =>
        packageBuildArtifact({
          applicationRoot: fixture.site,
          bundleRoot: fixture.bundle,
          dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
          packageManagerReceiptPath: fixture.packageManagerReceiptPath,
          compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
          environment: fixture.environment,
        }),
      /build identity is invalid/u,
    );
  }
});

test("artifact packaging fails closed without the immutable package-manager receipt", () => {
  const fixture = staticPackageFixture();
  assert.throws(
    () =>
      packageBuildArtifact({
        applicationRoot: fixture.site,
        bundleRoot: fixture.bundle,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
        environment: fixture.environment,
      }),
    /package manager receipt is invalid/u,
  );
});

test("static packaging rejects a storage capability it cannot bind", () => {
  const fixture = staticPackageFixture();
  fixture.environment.STORAGE_REQUIREMENT_JSON =
    '{"enabled":true,"provider":"r2","jurisdiction":"eu","public":false}';
  assert.throws(
    () =>
      packageBuildArtifact({
        applicationRoot: fixture.site,
        bundleRoot: fixture.bundle,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: fixture.packageManagerReceiptPath,
        compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
        environment: fixture.environment,
      }),
    /static storage requirement is invalid/u,
  );
});

test("packages an exact ordered migration inventory into the immutable artifact", () => {
  const fixture = staticPackageFixture();
  const migrations = path.join(fixture.site, "supabase", "migrations");
  fs.mkdirSync(migrations, { recursive: true });
  fs.writeFileSync(
    path.join(migrations, "20260821090000_first.sql"),
    "create table first_table(id bigint);\n",
  );
  fs.writeFileSync(
    path.join(migrations, "20260821100000_second.sql"),
    "alter table first_table add column name text;\n",
  );
  fixture.environment.DATABASE_REQUIREMENT_JSON =
    '{"enabled":true,"migrations":"supabase/migrations"}';

  const manifest = packageBuildArtifact({
    applicationRoot: fixture.site,
    bundleRoot: fixture.bundle,
    dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
    packageManagerReceiptPath: fixture.packageManagerReceiptPath,
    compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
    environment: fixture.environment,
  });

  assert.deepEqual(
    manifest.migrations.map(({ path: migrationPath, size }) => ({ path: migrationPath, size })),
    [
      { path: "20260821090000_first.sql", size: 37 },
      { path: "20260821100000_second.sql", size: 46 },
    ],
  );
  assert.equal(
    fs.readFileSync(path.join(fixture.bundle, "migrations", "20260821090000_first.sql"), "utf8"),
    "create table first_table(id bigint);\n",
  );
  const archive = path.join(fixture.repository, "migrations.tar.gz");
  createBuildArtifactArchive({ bundleRoot: fixture.bundle, outputPath: archive });
  assert.match(
    zlib.gunzipSync(fs.readFileSync(archive)).toString("utf8"),
    /20260821090000_first\.sql/u,
  );
});

test("packages only the root-owned pre-build migration snapshot after source tampering", () => {
  const fixture = staticPackageFixture();
  const migrations = path.join(fixture.site, "supabase", "migrations");
  const snapshot = path.join(fixture.repository, "migration-snapshot");
  fs.mkdirSync(migrations, { recursive: true });
  const migration = path.join(migrations, "20260821090000_first.sql");
  fs.writeFileSync(migration, "create table source_bound(id bigint);\n");
  fixture.environment.DATABASE_REQUIREMENT_JSON =
    '{"enabled":true,"migrations":"supabase/migrations"}';

  const evidence = snapshotDatabaseMigrations({
    applicationRoot: fixture.site,
    databaseRequirementJson: fixture.environment.DATABASE_REQUIREMENT_JSON,
    snapshotRoot: snapshot,
  });
  fs.writeFileSync(migration, "drop table source_bound;\n");
  const manifest = packageBuildArtifact({
    applicationRoot: fixture.site,
    bundleRoot: fixture.bundle,
    dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
    packageManagerReceiptPath: fixture.packageManagerReceiptPath,
    compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
    migrationSnapshotRoot: snapshot,
    environment: fixture.environment,
  });

  assert.equal(manifest.migrations[0].digest, evidence.migrations[0].digest);
  assert.equal(
    fs.readFileSync(path.join(fixture.bundle, "migrations", "20260821090000_first.sql"), "utf8"),
    "create table source_bound(id bigint);\n",
  );
  assert.equal(fs.statSync(snapshot).mode & 0o777, 0o500);
  assert.equal(fs.statSync(path.join(snapshot, "20260821090000_first.sql")).mode & 0o777, 0o400);
  fs.chmodSync(snapshot, 0o700);
});

test("rejects unsafe, non-SQL, empty, and non-canonical migration inputs", () => {
  for (const [name, body] of [
    ["not-ordered.sql", "select 1;\n"],
    ["20260821090000_empty.sql", ""],
    ["20260821090000_crlf.sql", "select 1;\r\n"],
  ]) {
    const fixture = staticPackageFixture();
    const migrations = path.join(fixture.site, "supabase", "migrations");
    fs.mkdirSync(migrations, { recursive: true });
    fs.writeFileSync(path.join(migrations, name), body);
    fixture.environment.DATABASE_REQUIREMENT_JSON =
      '{"enabled":true,"migrations":"supabase/migrations"}';
    assert.throws(
      () =>
        packageBuildArtifact({
          applicationRoot: fixture.site,
          bundleRoot: fixture.bundle,
          dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
          packageManagerReceiptPath: fixture.packageManagerReceiptPath,
          compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
          environment: fixture.environment,
        }),
      /database migration/u,
    );
  }
});

test("packaging rejects symlink, hardlink, FIFO, and sibling escape outputs", () => {
  for (const kind of ["symlink", "hardlink", "fifo", "escape"]) {
    const fixture = staticPackageFixture();
    const output = path.join(fixture.site, "dist", "hostile");
    if (kind === "symlink")
      fs.symlinkSync(path.join(fixture.repository, "dist", "stale.html"), output);
    if (kind === "hardlink") fs.linkSync(path.join(fixture.site, "dist", "index.html"), output);
    if (kind === "fifo") execFileSync("mkfifo", [output]);
    if (kind === "escape") fixture.environment.BUILD_OUTPUT_DIRECTORY = "../dist";
    assert.throws(
      () =>
        packageBuildArtifact({
          applicationRoot: fixture.site,
          bundleRoot: fixture.bundle,
          dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
          packageManagerReceiptPath: fixture.packageManagerReceiptPath,
          compressedWorkerPath: path.join(fixture.repository, "unused.gz"),
          environment: fixture.environment,
        }),
      /unsafe build output|escapes root/u,
    );
  }
});

function astroEdgePackageFixture() {
  const fixture = tanstackEdgePackageFixture();
  const server = path.join(fixture.site, "dist/server");
  fs.renameSync(path.join(server, "index.js"), path.join(server, "entry.mjs"));
  fs.writeFileSync(path.join(server, "entry.mjs.map"), '{"sources":["private-source.astro"]}');
  const configPath = path.join(server, "wrangler.json");
  const generated = JSON.parse(fs.readFileSync(configPath, "utf8"));
  Object.assign(generated, {
    main: "entry.mjs",
    compatibility_date: "2026-10-12",
    assets: { binding: "ASSETS", directory: "../client" },
    configPath: path.join(fs.realpathSync(fixture.site), ".ohmyhost-astro-wrangler.jsonc"),
    userConfigPath: path.join(fs.realpathSync(fixture.site), ".ohmyhost-astro-wrangler.jsonc"),
    previews: {},
    k2: [],
  });
  fs.writeFileSync(configPath, JSON.stringify(generated));
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture.site, "package.json"), "utf8"));
  manifest.scripts.build = "astro build";
  fs.writeFileSync(path.join(fixture.site, "package.json"), JSON.stringify(manifest));
  Object.assign(fixture.environment, {
    FRAMEWORK_ADAPTER: "astro",
    SERVER_ENTRYPOINT: "dist/server/entry.mjs",
    COMPATIBILITY_DATE: "2026-10-12",
  });
  return fixture;
}

test("packages Astro static and SSR artifacts with separate private modules and no source maps", () => {
  const fixture = astroEdgePackageFixture();
  createAstroPlatformConfig({ applicationRoot: fixture.site, environment: fixture.environment });
  const entryPath = path.join(fixture.site, "dist/server/entry.mjs");
  const original = fs.readFileSync(entryPath, "utf8");
  fs.writeFileSync(
    entryPath,
    `function deserializeManifest(value) { return value; }\nconst manifest = deserializeManifest(${JSON.stringify({ adapterName: "@astrojs/cloudflare", base: "/", assetsDir: "_astro", assets: ["/_astro/client.js", "/_astro/counter.js"], entryModules: { "@astrojs/react/client.js": "_astro/client.js", "src/components/Counter.tsx": "_astro/counter.js" } })});\n${original}`,
  );
  const packaged = packageBuildArtifact({
    applicationRoot: fixture.site,
    bundleRoot: fixture.bundle,
    dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
    packageManagerReceiptPath: fixture.packageManagerReceiptPath,
    environment: fixture.environment,
  });
  assert.equal(packaged.runtime.entryWrapperVersion, "astro-edge-wrapper-v1");
  assert.equal(packaged.lifecycleEvidence.frameworkBuild.framework, "astro");
  assert.ok(packaged.modules.some(({ path }) => path === "index.js"));
  assert.ok(packaged.assets.every(({ path }) => !/server|wrangler|\.map$/u.test(path)));
  assert.ok(packaged.modules.every(({ path }) => !path.endsWith(".map")));
  const stat = staticPackageFixture();
  stat.environment.FRAMEWORK_ADAPTER = "astro";
  const manifest = JSON.parse(fs.readFileSync(path.join(stat.site, "package.json"), "utf8"));
  manifest.scripts.build = "astro build";
  fs.writeFileSync(path.join(stat.site, "package.json"), JSON.stringify(manifest));
  const output = packageBuildArtifact({
    applicationRoot: stat.site,
    bundleRoot: stat.bundle,
    dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
    packageManagerReceiptPath: stat.packageManagerReceiptPath,
    environment: stat.environment,
  });
  assert.equal(output.runtime, undefined);
  assert.equal(output.lifecycleEvidence.frameworkBuild.framework, "astro");
});

test("refuses Astro foreign bindings, unknown capabilities and public source maps", () => {
  for (const mutation of [
    (c) => {
      c.kv_namespaces = [{ binding: "SESSION" }];
    },
    (c) => {
      c.images = { binding: "IMAGES" };
    },
    (c) => {
      c.future_resource = null;
    },
    (c) => {
      c.previews = { images: { binding: "IMAGES" } };
    },
    (c) => {
      c.assets.directory = "../../private";
    },
    (c) => {
      c.compatibility_flags = [];
    },
  ]) {
    const fixture = astroEdgePackageFixture();
    const configPath = path.join(fixture.site, "dist/server/wrangler.json");
    const generated = JSON.parse(fs.readFileSync(configPath, "utf8"));
    mutation(generated);
    fs.writeFileSync(configPath, JSON.stringify(generated));
    assert.throws(
      () =>
        validateAstroBuildOutput({
          applicationRoot: fixture.site,
          environment: fixture.environment,
        }),
      /Astro/u,
    );
  }
  const fixture = astroEdgePackageFixture();
  fs.writeFileSync(path.join(fixture.site, "dist/client/client.js.map"), "private-source");
  assert.throws(
    () =>
      packageBuildArtifact({
        applicationRoot: fixture.site,
        bundleRoot: fixture.bundle,
        dependencyEvidencePath: ".ohmyhost-resolved-dependencies.json",
        packageManagerReceiptPath: fixture.packageManagerReceiptPath,
        environment: fixture.environment,
      }),
    /Astro public assets/u,
  );
  assert.throws(
    () =>
      createAstroPlatformConfig({
        applicationRoot: fixture.site,
        environment: { ...fixture.environment, COMPATIBILITY_DATE: "2025-01-01" },
      }),
    /Astro framework plan/u,
  );
});

test("checks installed Astro and its edge adapter versions after the frozen install", () => {
  const fixture = astroEdgePackageFixture();
  for (const [name, version] of [
    ["astro", "7.4.0"],
    ["@astrojs/cloudflare", "14.4.0"],
  ]) {
    const directory = path.join(fixture.site, "node_modules", name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version }));
  }
  assert.deepEqual(
    readFrameworkBuildArguments({
      applicationRoot: fixture.site,
      environment: fixture.environment,
    }),
    [],
  );
  fs.writeFileSync(
    path.join(fixture.site, "node_modules/@astrojs/cloudflare/package.json"),
    JSON.stringify({ name: "@astrojs/cloudflare", version: "14.3.0" }),
  );
  assert.throws(
    () =>
      readFrameworkBuildArguments({
        applicationRoot: fixture.site,
        environment: fixture.environment,
      }),
    /not admitted/u,
  );
});

test("copies a build output file only through a descriptor that refuses a link", () => {
  const directory = temporaryDirectory();
  const root = path.join(directory, "bundle");
  const destination = path.join(directory, "destination");
  const outside = path.join(directory, "outside-secret");
  fs.mkdirSync(root);
  fs.writeFileSync(outside, "root-only\n");
  const link = path.join(root, "asset.txt");
  fs.symlinkSync(outside, link);
  assert.throws(() => copyBuildOutputFile(root, link, destination), /unsafe build output/u);
  assert.equal(fs.existsSync(path.join(destination, "asset.txt")), false);
});

test("pins the build sandbox base image by digest", () => {
  const dockerfile = fs.readFileSync(
    fileURLToPath(new URL("../Dockerfile", import.meta.url)),
    "utf8",
  );
  const from = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
  assert.equal(from.length, 1);
  assert.match(
    from[0],
    /^FROM --platform=linux\/amd64 node:24\.15\.0-bookworm-slim@sha256:[0-9a-f]{64}$/u,
  );
});
