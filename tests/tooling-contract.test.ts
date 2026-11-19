import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { ESLint } from "eslint";
import { parse as parseYaml } from "yaml";

type RootManifest = {
  private?: unknown;
  packageManager?: unknown;
  engines?: unknown;
  scripts?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

type TurboConfig = {
  $schema?: unknown;
  globalDependencies?: string[];
  tasks?: Record<string, { outputs?: unknown; cache?: unknown }>;
};

type TypeScriptConfig = {
  compilerOptions?: Record<string, unknown>;
  extends?: unknown;
  include?: unknown;
};

type PackageManifest = {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  exports?: Record<string, unknown>;
  pnpm?: { auditConfig?: unknown };
  scripts?: Record<string, unknown>;
};

type RenovateConfig = {
  extends?: unknown;
  rangeStrategy?: unknown;
  packageRules?: Array<{ matchManagers?: unknown }>;
};

const readText = (path: string) =>
  readFile(new globalThis.URL(`../${path}`, import.meta.url), "utf8");

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readText(path)) as T;

test("the root manifest pins the supported toolchain and exposes every quality gate", async () => {
  const manifest = await readJson<RootManifest>("package.json");

  assert.equal(manifest.private, true);
  assert.equal(manifest.packageManager, "pnpm@10.28.2");
  assert.deepEqual(manifest.engines, { node: "24.6.0", pnpm: "10.28.2" });
  assert.equal(
    manifest.scripts?.["audit:moderate"],
    "pnpm audit --audit-level=moderate && pnpm --dir fixtures/next-edge --ignore-workspace audit --audit-level=moderate && pnpm --dir fixtures/gateway-canary --ignore-workspace audit --audit-level=moderate",
    "both standalone fixture audits must use their own lockfiles and propagate failures",
  );

  const requiredScripts = [
    "format",
    "format:check",
    "lint",
    "typecheck",
    "test",
    "test:coverage",
    "coverage",
    "audit:moderate",
    "build",
    "phase0:fake-provider-boundary:test",
    "phase0:fake-provider-boundary:verify",
    "phase0:fake-provider-boundary",
    "contracts:lint",
    "contracts:bundle",
    "contracts:check",
    "phase1:p1a:red",
    "phase1:p1a",
    "phase1:auth-preflight:capabilities:producer",
    "phase1:verify",
    "phase1:evidence-runner:test",
    "phase1:credential-store-platform-proof",
    "phase1:credential-store-platforms",
    "phase1:credential-store-platforms:attested",
    "ci:verify",
    "verify:fast",
    "test:shards",
    "release:rehearse",
    "release:train",
  ];

  for (const script of requiredScripts) {
    const command = manifest.scripts?.[script];

    if (typeof command !== "string") {
      assert.fail(`missing script: ${script}`);
    }

    assert.doesNotMatch(command, /(?:^|\s)(?:true|echo)(?:\s|$)/u);
    assert.doesNotMatch(command, /--if-present/u);
  }

  const ciVerify = manifest.scripts?.["ci:verify"];
  if (typeof ciVerify !== "string") {
    assert.fail("missing ci:verify script");
  }

  assert.match(ciVerify, /format:check/u);
  assert.match(ciVerify, /lint/u);
  assert.match(ciVerify, /typecheck/u);
  assert.match(ciVerify, /test/u);
  assert.match(ciVerify, /coverage/u);
  assert.match(ciVerify, /build/u);
  assert.match(ciVerify, /contracts:check/u);
  assert.match(ciVerify, /audit:moderate/u);
  assert.match(ciVerify, /plan:check/u);
  assert.match(ciVerify, /test:node/u);
  assert.match(ciVerify, /phase0:fake-provider-boundary:verify/u);

  // One entry point runs every repository node test, so a new one cannot silently stay out of CI.
  const nodeTests = manifest.scripts?.["test:node"];
  if (typeof nodeTests !== "string") assert.fail("missing test:node script");
  assert.match(nodeTests, /node --test --test-concurrency=1 tests\/\*\.node-test\.mjs/u);
  assert.match(nodeTests, /node --test apps\/build-runner\/sandbox\/tests\/\*\.test\.mjs/u);
  assert.match(nodeTests, /node --test packages\/build-broker\/src\/\*\.node-test\.mjs/u);
  assert.ok(
    ciVerify.indexOf("pnpm build") < ciVerify.indexOf("pnpm phase0:fake-provider-boundary:verify"),
    "production artifacts must be built before fake-provider exclusion is verified",
  );

  assert.equal(
    manifest.scripts?.["phase0:fake-provider-boundary:test"],
    "node --test tests/fake-provider-production-boundary.node-test.mjs",
  );
  assert.equal(
    manifest.scripts?.["phase0:fake-provider-boundary:verify"],
    "node scripts/check-fake-provider-production-boundary.mjs",
  );
  assert.equal(
    manifest.scripts?.["phase0:fake-provider-boundary"],
    "pnpm build && pnpm phase0:fake-provider-boundary:verify",
  );

  const evidenceRunnerTest = manifest.scripts?.["phase1:evidence-runner:test"];
  if (typeof evidenceRunnerTest !== "string") {
    assert.fail("missing phase1:evidence-runner:test script");
  }

  assert.match(
    evidenceRunnerTest,
    /pnpm --filter @ohmyhost\/workos-management\.\.\. build/u,
    "evidence runner tests must build the retained management artifact dependency closure",
  );

  for (const [name, version] of Object.entries(manifest.devDependencies ?? {})) {
    if (typeof version !== "string") {
      assert.fail(`${name} must have a string version`);
    }

    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, `${name} must be exact`);
  }

  assert.equal(manifest.devDependencies?.["vitest"], "4.1.12");
  assert.equal(manifest.devDependencies?.["@vitest/coverage-v8"], "4.1.12");
  assert.equal(manifest.devDependencies?.["turbo"], "2.9.14");

  const rootTest = manifest.scripts?.["test"];
  if (typeof rootTest !== "string") {
    assert.fail("missing test script");
  }

  assert.match(
    rootTest,
    /turbo run build/u,
    "the root test command must build workspace entrypoints on a clean checkout",
  );
  assert.equal(manifest.scripts?.["typecheck:root"], "tsc --project tsconfig.root.json --noEmit");
  assert.equal(manifest.scripts?.["typecheck"], "pnpm typecheck:root && turbo run typecheck");
  assert.match(
    String(manifest.scripts?.["phase1:credential-store-platform-proof"]),
    /pnpm --filter @ohmyhost\/product-cli\.\.\. build/u,
  );
});

test("workspace, TypeScript, Turbo, and package-manager settings are strict", async () => {
  const [
    workspace,
    turbo,
    tsconfig,
    rootTsconfig,
    npmrc,
    nodeVersion,
    prettier,
    prettierIgnore,
    eslint,
    vitest,
    platform,
    contracts,
    database,
    orchestrator,
    webhookIngress,
    nextFixture,
    gatewayFixture,
  ] = await Promise.all([
    readText("pnpm-workspace.yaml"),
    readJson<TurboConfig>("turbo.json"),
    readJson<TypeScriptConfig>("tsconfig.base.json"),
    readJson<TypeScriptConfig>("tsconfig.root.json"),
    readText(".npmrc"),
    readText(".node-version"),
    readJson<{ endOfLine?: unknown }>(".prettierrc.json"),
    readText(".prettierignore"),
    readText("eslint.config.mjs"),
    readText("vitest.config.mts"),
    readJson<PackageManifest>("packages/platform/package.json"),
    readJson<PackageManifest>("packages/contracts/package.json"),
    readJson<PackageManifest>("packages/database/package.json"),
    readJson<PackageManifest>("apps/orchestrator/package.json"),
    readJson<PackageManifest>("apps/webhook-ingress/package.json"),
    readJson<PackageManifest>("fixtures/next-edge/package.json"),
    readJson<PackageManifest>("fixtures/gateway-canary/package.json"),
  ]);

  assert.match(
    workspace,
    /^packages:\n[ ]{2}- "apps\/\*"\n[ ]{2}- "packages\/\*"\n\noverrides:\n[ ]{2}"@cloudflare\/sandbox>zod": "4\.6\.6"\n[ ]{2}"js-yaml@\^4": "4\.3\.2"\n[ ]{2}"ajv@8\.18\.0>fast-uri": "3\.1\.9"\n[ ]{2}"brace-expansion@\^1": "1\.1\.21"\n[ ]{2}"brace-expansion@\^2": "2\.1\.7"\n[ ]{2}"brace-expansion@\^5": "5\.0\.12"\n[ ]{2}"miniflare>sharp": "0\.35\.5"\n[ ]{2}"miniflare>undici": "7\.30\.1"\n[ ]{2}"source-map-js": "1\.2\.2"\n[ ]{2}"mermaid>katex": "0\.18\.2"\n[ ]{2}"mermaid>dompurify": "3\.4\.17"\n[ ]{2}"vitest@4\.1\.12>vite": "7\.3\.7"\n[ ]{2}"minimatch@\^3": "11\.0\.3"\n[ ]{2}"minimatch@\^10": "11\.0\.3"\n[ ]{2}"node-pg-migrate>glob": "14\.0\.3"\n\npatchedDependencies:\n[ ]{2}"pdf-lib@1\.17\.1": "patches\/pdf-lib@1\.17\.1\.patch"\n$/u,
  );
  assert.equal(nextFixture.pnpm?.auditConfig, undefined);
  assert.equal(gatewayFixture.pnpm?.auditConfig, undefined);
  assert.equal(turbo.$schema, "https://turbo.build/schema.json");
  for (const task of ["build", "lint", "typecheck", "test", "coverage"]) {
    assert.ok(turbo.tasks?.[task], `missing Turbo task: ${task}`);
  }
  assert.deepEqual(
    turbo.tasks?.["build"]?.outputs,
    ["dist/**"],
    "package builds must emit only the declared dist artifact",
  );
  assert.deepEqual(turbo.tasks?.["@ohmyhost/public-site#build"]?.outputs, [
    "dist/**",
    "public/pages/**",
  ]);
  assert.deepEqual(
    turbo.globalDependencies,
    ["tsconfig*.json"],
    "only the TypeScript settings every package build extends may invalidate every task; repository files a build reads are declared on that task",
  );
  assert.equal(
    turbo.tasks?.["@ohmyhost/contracts#build"],
    undefined,
    "runtime contracts use the standard dist build task",
  );
  assert.equal(tsconfig.compilerOptions?.["strict"], true);
  assert.equal(tsconfig.compilerOptions?.["noUncheckedIndexedAccess"], true);
  assert.equal(tsconfig.compilerOptions?.["exactOptionalPropertyTypes"], true);
  assert.equal(tsconfig.compilerOptions?.["noImplicitReturns"], true);
  assert.equal(tsconfig.compilerOptions?.["noFallthroughCasesInSwitch"], true);
  assert.deepEqual(tsconfig.compilerOptions?.["customConditions"], ["source"]);
  assert.equal(rootTsconfig.extends, "./tsconfig.base.json");
  assert.deepEqual(rootTsconfig.include, ["tests/**/*.ts", "vitest.config.mts"]);
  assert.match(npmrc, /^engine-strict=true$/mu);
  assert.match(npmrc, /^save-exact=true$/mu);
  assert.match(npmrc, /^strict-peer-dependencies=true$/mu);
  assert.equal(nodeVersion.trim(), "24.6.0");
  assert.equal(prettier.endOfLine, "lf");
  assert.match(prettierIgnore, /^packages\/contracts\/generated\/openapi\.json$/mu);
  assert.match(eslint, /tseslint\.configs\.strict/u);
  const linter = new ESLint();
  assert.equal(await linter.isPathIgnored("docs/plan/tmp/generated-customer/index.js"), true);
  assert.equal(await linter.isPathIgnored(".ohmyhost/customer-runs/example/index.js"), true);
  assert.equal(await linter.isPathIgnored("apps/product-cli/src/repository-init.ts"), false);
  assert.equal(
    await linter.isPathIgnored(
      "fixtures/cloudflare-preview/tanstack-start/worker-configuration.d.ts",
    ),
    true,
  );
  assert.equal(
    await linter.isPathIgnored("scripts/preview-spike/worker/build-context/container/driver.mjs"),
    true,
  );
  assert.equal(await linter.isPathIgnored("scripts/preview-spike/worker/.dry-run/index.js"), true);
  assert.equal(
    await linter.isPathIgnored("scripts/preview-spike/worker/container/driver.mjs"),
    false,
  );
  assert.equal(
    await linter.isPathIgnored("fixtures/cloudflare-preview/tanstack-start/src/routes/index.tsx"),
    false,
  );

  assert.match(vitest, /passWithNoTests:\s*false/u);
  assert.match(
    vitest,
    /include:\s*\["apps\/\*\*\/src\/\*\*\/\*\.ts", "packages\/\*\*\/src\/\*\*\/\*\.ts"\]/u,
  );
  assert.match(vitest, /reportOnFailure:\s*true/u);
  assert.match(vitest, /packages\/\*\*\/\*\.test/u);
  assert.match(vitest, /functions:\s*100/u);
  assert.match(
    vitest,
    /"@ohmyhost\/orchestrator":\s*fileURLToPath\(\s*new URL\("\.\/apps\/orchestrator\/src\/index\.ts", import\.meta\.url\)/u,
  );
  assert.match(vitest, /conditions:\s*\["source"\]/u);
  assert.equal(platform.scripts?.["build"], "tsc --project tsconfig.build.json");
  assert.deepEqual(platform.exports?.["."], {
    source: "./src/index.ts",
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  });
  assert.equal(contracts.dependencies?.["ajv"], "8.18.0");
  assert.equal(contracts.dependencies?.["yaml"], "2.8.3");
  assert.equal(contracts.scripts?.["build"], "tsc --project tsconfig.build.json");
  assert.deepEqual(contracts.exports?.["."], {
    source: "./src/index.ts",
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  });
  assert.equal(database.scripts?.["build"], "tsc --project tsconfig.build.json");
  assert.deepEqual(database.exports?.["."], {
    source: "./src/index.ts",
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  });
  assert.equal(orchestrator.dependencies?.["@ohmyhost/testkit"], undefined);
  assert.equal(orchestrator.devDependencies?.["@ohmyhost/testkit"], undefined);
  assert.deepEqual(Object.keys(orchestrator.exports ?? {}), ["."]);
  assert.match(
    String(webhookIngress.scripts?.["boundary"]),
    /pnpm --filter @ohmyhost\/webhook-ingress\.\.\. build/u,
  );
});

type DryRunTask = { taskId: string; directory: string; inputs: Record<string, string> };

// Static relative references of a script: imports, dynamic imports and new URL("./x", import.meta.url).
const relativeReferences =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']|new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url/gu;

const isFile = (path: string) =>
  stat(path).then(
    (info) => info.isFile(),
    () => false,
  );

// Every file the `node <script>` commands of a build script load through such a reference, followed
// transitively. A read through a computed path (a repository root joined with a name) stays invisible.
const scriptReads = async (directory: string, build: string) => {
  const pending = [...build.matchAll(/\bnode\s+(\S+\.mjs)\b/gu)].flatMap((match) =>
    match[1] === undefined ? [] : [resolve(directory, match[1])],
  );
  const reads = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || reads.has(file)) continue;
    // The package's own built output is produced by the task itself, not read from the repository.
    if (relative(directory, file).startsWith("dist/")) continue;
    // A missing path (a type-only import, a file the script writes) or a directory is no read.
    if (!(await isFile(file))) continue;
    reads.add(file);
    if (!/\.(?:mjs|cjs|js|mts|cts|ts)$/u.test(file)) continue;
    for (const match of (await readFile(file, "utf8")).matchAll(relativeReferences)) {
      const reference = match[1] ?? match[2];
      if (reference !== undefined) pending.push(resolve(dirname(file), reference));
    }
  }
  return [...reads];
};

test("build tasks hash only the repository files they read", async () => {
  const repositoryRoot = fileURLToPath(new globalThis.URL("..", import.meta.url));
  // The 30 s limit stops a hung turbo, which vitest cannot interrupt during a blocking call, so the
  // test carries the same budget as its last argument.
  const dryRun = JSON.parse(
    execFileSync("pnpm", ["exec", "turbo", "run", "build", "--dry=json"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    }),
  ) as { globalCacheInputs: { files: Record<string, string> }; tasks: DryRunTask[] };
  // .gitattributes is a Turbo implicit input; the two tsconfig files are the declared globalDependencies.
  assert.deepEqual(Object.keys(dryRun.globalCacheInputs.files).sort(), [
    ".gitattributes",
    "tsconfig.base.json",
    "tsconfig.root.json",
  ]);
  const inputsOf = (taskId: string) => {
    const task = dryRun.tasks.find((entry) => entry.taskId === taskId);
    assert.ok(task, `missing build task ${taskId}`);
    return Object.keys(task.inputs);
  };
  const declared: Record<string, string[]> = {
    "@ohmyhost/browser-gateway#build": ["../../patches/pdf-lib@1.17.1.patch"],
    // Each list is what the package's build script, tsc program or bundle reads outside its folder.
    "@ohmyhost/agent-skills#build": ["../../skills/ohmyhost-deploy/SKILL.md"],
    "@ohmyhost/control-api#build": [
      "../../scripts/prepare-portal-assets.mjs",
      "../../brand/brand-bundle.json",
      "../product-cli/package.json",
    ],
    "@ohmyhost/project-recovery#build": [
      "../../scripts/postgres-tools.mjs",
      "../../scripts/postgres-tools.d.mts",
    ],
    "@ohmyhost/public-site#build": [
      "../../scripts/credit-pricing-document.mjs",
      "../../brand/assets/favicon.svg",
      "../../content/data/plans.json",
      "../../docs/architecture/pricing-contract.md",
      "../../packages/contracts/generated/openapi.json",
      "../../redocly.yaml",
    ],
  };
  for (const [taskId, files] of Object.entries(declared))
    for (const file of files)
      assert.ok(inputsOf(taskId).includes(file), `${taskId} must hash ${file}`);
  // Every other repository file stays outside all task hashes, so a docs-only commit reuses the cache.
  const readable: Record<string, RegExp> = {
    "@ohmyhost/browser-gateway#build": /^\.\.\/\.\.\/patches\/pdf-lib@1\.17\.1\.patch$/u,
    "@ohmyhost/agent-skills#build": /^\.\.\/\.\.\/skills\//u,
    "@ohmyhost/control-api#build":
      /^(?:\.\.\/\.\.\/scripts\/prepare-portal-assets\.mjs|\.\.\/\.\.\/brand\/brand-bundle\.json|\.\.\/product-cli\/package\.json)$/u,
    "@ohmyhost/project-recovery#build": /^\.\.\/\.\.\/scripts\/postgres-tools\.(?:mjs|d\.mts)$/u,
    "@ohmyhost/public-site#build":
      /^\.\.\/\.\.\/(?:scripts\/credit-pricing-document\.mjs|brand\/assets\/|content\/|docs\/architecture\/pricing-contract\.md$|packages\/contracts\/generated\/openapi\.json$|redocly\.yaml$)/u,
  };
  for (const task of dryRun.tasks) {
    const external = Object.keys(task.inputs).filter((file) => file.startsWith("../"));
    const allowed = readable[task.taskId];
    assert.deepEqual(
      external.filter((file) => !allowed?.test(file)),
      [],
      `${task.taskId} hashes repository files its build does not read`,
    );
    // The dry run cannot see a missing declaration, but a build script that names a file outside
    // its package (a new generator script, say) must hash it, or a stale output would be replayed.
    const manifest = await readJson<PackageManifest>(`${task.directory}/package.json`);
    for (const [reference] of String(manifest.scripts?.["build"]).matchAll(/(?:\.\.\/)+[\w./-]+/gu))
      assert.ok(
        Object.hasOwn(task.inputs, reference),
        `${task.taskId} runs ${reference} without declaring it as a task input`,
      );
    // The scripts it runs may import further files outside the package (a shared helper, say), and
    // each of those must be hashed as well. Only static relative references are visible here: a read
    // through a computed path stays a review obligation of whoever edits the script.
    const directory = resolve(repositoryRoot, task.directory);
    for (const file of await scriptReads(directory, String(manifest.scripts?.["build"]))) {
      const reference = relative(directory, file);
      if (reference.startsWith("../"))
        assert.ok(
          Object.hasOwn(task.inputs, reference),
          `${task.taskId} loads ${reference} through a script it runs without declaring it as a task input`,
        );
    }
  }
}, 30_000);

test("typecheck re-runs the compiler incrementally instead of replaying package-level results", async () => {
  const turbo = await readJson<TurboConfig>("turbo.json");
  // Tests import other packages by relative path, which the package graph cannot see, so a task
  // result keyed by package inputs could replay a green run for a test that no longer compiles.
  for (const task of ["typecheck", "lint", "test", "coverage"])
    assert.equal(turbo.tasks?.[task]?.cache, false, `${task} must not replay cached results`);
  // Placeholder folders carry only a .gitkeep; every folder with a manifest is a workspace package.
  const manifests: string[] = [];
  for (const directory of ["apps", "packages"])
    for (const name of await readdir(new globalThis.URL(`../${directory}`, import.meta.url)))
      if (
        await access(
          new globalThis.URL(`../${directory}/${name}/package.json`, import.meta.url),
        ).then(
          () => true,
          () => false,
        )
      )
        manifests.push(`${directory}/${name}/package.json`);
  assert.ok(manifests.length >= 50, "the workspace packages were found");
  for (const manifest of manifests)
    assert.equal(
      (await readJson<PackageManifest>(manifest)).scripts?.["typecheck"],
      "tsc --project tsconfig.json --noEmit --incremental --tsBuildInfoFile typecheck.tsbuildinfo",
      `${manifest} must typecheck, and let tsc itself decide what to recheck`,
    );
  assert.match(await readText(".gitignore"), /^\*\.tsbuildinfo$/mu);
});

test("CI installs the pinned toolchain and runs the complete verification contract", async () => {
  const [workflow, setup, renovate] = await Promise.all([
    readText(".github/workflows/ci.yml"),
    readText(".github/actions/setup-workspace/action.yml"),
    readJson<RenovateConfig>("renovate.json"),
  ]);
  const toolchain = workflow + setup;
  assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/u);
  assert.match(toolchain, /pnpm\/action-setup@ff378ebe6b225b0680b81c1ad4498ae0d1d3a5e3/u);
  assert.match(toolchain, /version: 10\.28\.2/u);
  assert.match(toolchain, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/u);
  assert.match(toolchain, /node-version: 24\.6\.0/u);
  assert.match(setup, /pnpm install --frozen-lockfile/u);
  const setupSteps = (
    parseYaml(setup) as {
      runs: { steps: { name?: string; shell?: string; run?: string }[] };
    }
  ).runs.steps;
  const previewInstall = setupSteps.find(
    (step) => step.name === "Install preview spike worker dependencies",
  );
  assert.equal(previewInstall?.shell, "bash");
  assert.match(
    previewInstall?.run ?? "",
    /if test -f scripts\/preview-spike\/worker\/package-lock\.json; then/u,
  );
  assert.match(
    previewInstall?.run ?? "",
    /pnpm exec npm --prefix scripts\/preview-spike\/worker ci --ignore-scripts --no-audit --no-fund/u,
  );
  assert.match(setup, /pnpm --filter @ohmyhost\/contracts build/u);
  const graph = parseYaml(workflow) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: Record<
      string,
      {
        needs?: string | string[];
        if?: string;
        strategy?: { "fail-fast": boolean; matrix: { shard: number[] } };
        steps: { run?: string; uses?: string; env?: Record<string, string> }[];
      }
    >;
  };
  assert.deepEqual(Object.keys(graph.on).sort(), ["pull_request", "push", "workflow_dispatch"]);
  assert.deepEqual(graph.permissions, { contents: "read" });
  assert.match(graph.concurrency.group, /github\.sha/u);
  assert.equal(graph.concurrency["cancel-in-progress"], false);
  const requiredJobs = [
    "secret-scan",
    "static",
    "build",
    "boundaries",
    "node-tests",
    "vitest",
    "coverage",
  ];
  assert.deepEqual(Object.keys(graph.jobs).sort(), [...requiredJobs, "verify"].sort());
  const finalGate = graph.jobs["verify"];
  const coverageJob = graph.jobs["coverage"];
  const vitestJob = graph.jobs["vitest"];
  assert.ok(finalGate && coverageJob && vitestJob);
  assert.deepEqual(finalGate.needs, requiredJobs);
  assert.equal(finalGate.if, "${{ always() }}");
  assert.equal(finalGate.steps.at(-1)?.run, "node scripts/check-ci-jobs.mjs");
  assert.equal(finalGate.steps.at(-1)?.env?.["CI_JOB_RESULTS"], "${{ toJSON(needs) }}");
  for (const job of ["boundaries", "node-tests", "vitest"])
    assert.equal(graph.jobs[job]?.needs, "build");
  assert.deepEqual(coverageJob.needs, ["build", "vitest"]);
  assert.deepEqual(vitestJob.strategy, {
    "fail-fast": false,
    matrix: { shard: [1, 2, 3, 4, 5, 6] },
  });
  const commands = Object.values(graph.jobs).flatMap((job) =>
    job.steps.flatMap((step) => (step.run === undefined ? [] : [step.run])),
  );
  for (const command of [
    "audit:moderate",
    "plan:check",
    "contracts:check",
    "sdk-ts:check",
    "phase1:product-cli-boundary:test",
    "phase1:product-cli-boundary",
    "phase1:webhook-ingress-boundary",
    "proof:application-root:test",
    "proof:postgres-portability:test",
    "format:check",
    "lint",
    "build",
    "typecheck",
    "test:node",
    "phase0:fake-provider-boundary:verify",
  ])
    assert.ok(commands.includes(`pnpm ${command}`), `Missing CI check ${command}`);
  assert.ok(
    commands.includes(
      "node scripts/vitest-shards.mjs inventory --output .ohmyhost/test-shards/inventory.json --shards 6 --timings scripts/ci-test-durations.json",
    ),
  );
  assert.ok(commands.some((command) => command.startsWith("node scripts/vitest-shards.mjs run ")));
  assert.ok(
    commands.some((command) => command.startsWith("node scripts/vitest-shards.mjs merge ")),
  );
  // The integration tests assert their server version, so CI must supply PostgreSQL 18.
  assert.match(setup, /postgresql-18/u);
  assert.match(setup, /postgres_bin=\/usr\/lib\/postgresql\/18\/bin/u);
  assert.match(setup, /OHMYHOST_TEST_POSTGRES_BIN=/u);
  // A shared database would let cluster-wide roles of one suite collide with another.
  assert.doesNotMatch(workflow, /TEST_DATABASE_URL/u);
  assert.doesNotMatch(workflow, /image: postgres@/u);
  assert.doesNotMatch(toolchain, /continue-on-error:\s*true/u);
  assert.doesNotMatch(toolchain, /--if-present/u);
  assert.doesNotMatch(workflow, /runs-on:\s*[^\n]*latest/u);

  assert.equal(
    Array.isArray(renovate.extends) && renovate.extends.includes("config:recommended"),
    true,
  );
  assert.equal(renovate.rangeStrategy, "pin");
  assert.equal(
    renovate.packageRules?.some(
      (rule) => Array.isArray(rule.matchManagers) && rule.matchManagers.includes("github-actions"),
    ),
    true,
  );
});

type WorkflowStep = {
  id?: string;
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};

type WorkflowGraph = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: Record<
    string,
    {
      if?: string;
      permissions?: Record<string, string>;
      "timeout-minutes"?: number;
      steps: WorkflowStep[];
    }
  >;
};

type CompositeAction = {
  outputs: Record<string, { value: string }>;
  runs: { steps: WorkflowStep[] };
};

// Fails when a build rewrote or created any file that git does not ignore.
const cleanTree =
  'git status --porcelain=v1 --untracked-files=all\ntest -z "$(git status --porcelain=v1 --untracked-files=all)"\n';

test("every public CI job retains the read-only workflow token and remains a required gate", async () => {
  const workflowText = await readText(".github/workflows/ci.yml");
  const graph = parseYaml(workflowText) as WorkflowGraph;
  for (const [name, job] of Object.entries(graph.jobs)) {
    assert.equal(job.permissions, undefined, `${name} keeps the read-only workflow token`);
    assert.ok(job.steps.every((step) => !step.run?.includes("gh run cancel")));
  }
  assert.deepEqual(graph.permissions, { contents: "read" });
  assert.doesNotMatch(workflowText, /continue-on-error/u);
  assert.match(workflowText, /fail-fast: false/u);

  // Restore the lean toolchain only where the proof holds: the inventory collects tests
  // and the merge reads reports, neither starts PostgreSQL or OpenTofu.
  const setupStep = (name: string) =>
    graph.jobs[name]?.steps.find((step) => step.uses === "./.github/actions/setup-workspace");
  for (const name of ["build", "coverage"]) {
    const step = setupStep(name);
    assert.ok(step, `${name} uses the shared setup`);
    assert.equal(step.with?.["postgres"], undefined);
    assert.equal(step.with?.["opentofu"], undefined);
  }
  for (const name of ["boundaries", "node-tests", "vitest"]) {
    assert.equal(setupStep(name)?.with?.["postgres"], "true");
    assert.equal(setupStep(name)?.with?.["opentofu"], "true");
  }
});

test("compiled task outputs and TypeScript build information are restored where used and saved once", async () => {
  const [workflowText, setupText] = await Promise.all([
    readText(".github/workflows/ci.yml"),
    readText(".github/actions/setup-workspace/action.yml"),
  ]);
  const workflow = parseYaml(workflowText) as WorkflowGraph;
  const setup = parseYaml(setupText) as CompositeAction;
  const cache = "0057852bfaa89a56745cba8c7296529d2fc39830";
  // actions/cache itself saves when the job that restored it ends, which stored one copy per job.
  assert.doesNotMatch(workflowText + setupText, /actions\/cache@/u);
  const saves = Object.entries(workflow.jobs).flatMap(([name, job]) =>
    job.steps.filter((step) => step.uses?.startsWith("actions/cache/save@")).map(() => name),
  );
  assert.deepEqual(saves, ["build", "boundaries"], "only the build and the typecheck save a cache");
  // An exact key ends with the commit; the prefix finds the newest entry of an earlier commit.
  const prefixOf = (key: unknown) => {
    assert.ok(
      typeof key === "string" && key.endsWith("-${{ github.sha }}"),
      "the key ends with the commit",
    );
    return key.slice(0, -"${{ github.sha }}".length);
  };
  const containsAll = (prefix: string, parts: string[]) => {
    for (const part of parts) assert.ok(prefix.includes(part), `the key must contain ${part}`);
  };

  // Every job restores through the shared setup, under everything that can change an output.
  const turbo = setup.runs.steps.find((step) => step.id === "turbo");
  assert.equal(turbo?.uses, `actions/cache/restore@${cache}`);
  assert.equal(turbo.with?.["path"], ".turbo/cache");
  const turboPrefix = prefixOf(turbo.with?.["key"]);
  assert.equal(turbo.with?.["restore-keys"], `${turboPrefix}\n`);
  containsAll(turboPrefix, [
    "turbo-v2-",
    "runner.os",
    "runner.arch",
    "steps.toolchain.outputs.node",
    "steps.toolchain.outputs.pnpm",
    "hashFiles('pnpm-lock.yaml', 'pnpm-workspace.yaml', 'turbo.json')",
  ]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(setup.outputs).map(([name, { value }]) => [name, value])),
    {
      "turbo-cache-key": "${{ steps.turbo.outputs.cache-primary-key }}",
      "turbo-cache-hit": "${{ steps.turbo.outputs.cache-hit }}",
    },
  );

  // The build job saves what it built, once, and only after the build succeeded and left every
  // tracked file as committed: Turbo replays no rewrite of a tracked generated file, so an entry
  // saved by a dirty build would let a later commit pass on the stale committed file.
  const build = workflow.jobs["build"]?.steps ?? [];
  const built = build.findIndex((step) => step.run === "pnpm build");
  const clean = build.findIndex((step) => step.run === cleanTree);
  const prune = build.findIndex((step) => step.run === "node scripts/prune-turbo-cache.mjs");
  const saveBuild = build.findIndex((step) => step.uses === `actions/cache/save@${cache}`);
  assert.ok(
    built >= 0 && built < clean && clean < prune && prune < saveBuild,
    "build, then clean tree, then prune, then save",
  );
  assert.equal(build[built]?.if, undefined);
  assert.equal(build[clean]?.if, undefined, "the clean-tree check is never skipped");
  assert.equal(build[built]?.env?.["TURBO_RUN_SUMMARY"], "true");
  assert.equal(
    build.find((step) => step.uses === "./.github/actions/setup-workspace")?.id,
    "setup",
  );
  const notRestored = "${{ steps.setup.outputs.turbo-cache-hit != 'true' }}";
  assert.equal(build[prune]?.if, notRestored);
  assert.equal(build[saveBuild]?.if, notRestored);
  assert.deepEqual(build[saveBuild]?.with, {
    path: ".turbo/cache",
    key: "${{ steps.setup.outputs.turbo-cache-key }}",
  });

  // The typecheck restores the build information of an earlier commit, always runs, and saves once green.
  const boundaries = workflow.jobs["boundaries"]?.steps ?? [];
  const restoreInfo = boundaries.findIndex((step) => step.id === "tsc");
  const typecheck = boundaries.findIndex((step) => step.run === "pnpm typecheck");
  const saveInfo = boundaries.findIndex((step) => step.uses === `actions/cache/save@${cache}`);
  assert.ok(restoreInfo >= 0 && restoreInfo < typecheck && typecheck < saveInfo);
  assert.equal(boundaries[typecheck]?.if, undefined, "the typecheck is never skipped");
  const buildInfo = "apps/*/typecheck.tsbuildinfo\npackages/*/typecheck.tsbuildinfo\n";
  assert.equal(boundaries[restoreInfo]?.uses, `actions/cache/restore@${cache}`);
  assert.equal(boundaries[restoreInfo]?.with?.["path"], buildInfo);
  const tscPrefix = prefixOf(boundaries[restoreInfo]?.with?.["key"]);
  assert.equal(boundaries[restoreInfo]?.with?.["restore-keys"], `${tscPrefix}\n`);
  containsAll(tscPrefix, [
    "tsc-v1-",
    "runner.os",
    "runner.arch",
    "steps.compiler.outputs.versions",
    // tsc keeps a cached result across a change of target or module, so every tsconfig is in the key.
    "hashFiles('pnpm-lock.yaml', 'tsconfig*.json', 'apps/*/tsconfig*.json', 'packages/*/tsconfig*.json')",
  ]);
  assert.equal(boundaries[saveInfo]?.if, "${{ steps.tsc.outputs.cache-hit != 'true' }}");
  assert.deepEqual(boundaries[saveInfo]?.with, {
    path: buildInfo,
    key: "${{ steps.tsc.outputs.cache-primary-key }}",
  });
  // No status function: a failed or cancelled job never saves a half-finished state.
  for (const step of [build[prune], build[saveBuild], boundaries[saveInfo]])
    assert.doesNotMatch(String(step?.if), /always\(\)|failure\(\)|cancelled\(\)/u);
});

test("scheduled checks report a new advisory and a failure a cache hid without becoming a gate", async () => {
  const [auditText, ciWorkflow, setup, renovateText] = await Promise.all([
    readText(".github/workflows/audit.yml"),
    readText(".github/workflows/ci.yml"),
    readText(".github/actions/setup-workspace/action.yml"),
    readText("renovate.json"),
  ]);
  const ciText = ciWorkflow + setup;
  const audit = parseYaml(auditText) as WorkflowGraph;
  const ci = parseYaml(ciWorkflow) as WorkflowGraph;
  assert.deepEqual(Object.keys(audit.on).sort(), ["schedule", "workflow_dispatch"]);
  assert.deepEqual(audit.on["schedule"], [{ cron: "23 5 * * *" }, { cron: "17 3 * * 0" }]);
  assert.deepEqual(audit.permissions, { contents: "read" });
  assert.equal(audit.concurrency?.["cancel-in-progress"], false);
  assert.match(String(audit.concurrency?.group), /github\.workflow/u);
  assert.deepEqual(Object.keys(audit.jobs), ["audit", "cold"]);
  const job = audit.jobs["audit"];
  const cold = audit.jobs["cold"];
  assert.ok(job && cold);
  // The morning schedule starts the audit, the weekly one the cold build, a manual dispatch both.
  assert.equal(job.if, "${{ github.event.schedule != '17 3 * * 0' }}");
  assert.equal(
    cold.if,
    "${{ github.event_name == 'workflow_dispatch' || github.event.schedule == '17 3 * * 0' }}",
  );
  assert.equal(job.permissions, undefined);
  assert.equal(cold.permissions, undefined);
  assert.equal(job["timeout-minutes"], 10);
  assert.equal(cold["timeout-minutes"], 30);
  // The audit reads only the lockfiles, so it never installs anything.
  assert.deepEqual(
    job.steps.flatMap((step) => (step.run === undefined ? [] : [step.run])),
    ["pnpm audit:moderate"],
  );
  // The cold run is what the release gate runs on an empty cache: the same install, build and
  // typecheck, with a check after the build that it left every tracked generated file as committed.
  assert.deepEqual(
    cold.steps.flatMap((step) => (step.run === undefined ? [] : [step.run])),
    ["pnpm install --frozen-lockfile", "pnpm build", cleanTree, "pnpm typecheck"],
  );
  assert.equal(cold.steps.find((step) => step.run === "pnpm build")?.env?.["TURBO_FORCE"], "true");
  for (const each of [job, cold])
    assert.deepEqual(each.steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with, {
      "persist-credentials": false,
    });
  // Neither job restores or saves any cache, not even the pnpm store, so nothing but the sources decides.
  assert.doesNotMatch(auditText, /actions\/cache|cache:|setup-workspace|\.turbo|tsbuildinfo/u);
  // The checks pin exactly the actions and versions the release gate uses, so Renovate bumps both together.
  const pinned = (text: string) => new Set(text.match(/[\w-]+\/[\w-]+@[0-9a-f]{40}/gu));
  for (const action of pinned(auditText)) assert.ok(pinned(ciText).has(action), action);
  assert.ok(pinned(auditText).size >= 3);
  assert.match(auditText, /version: 10\.28\.2/u);
  assert.match(auditText, /node-version: 24\.6\.0/u);
  assert.doesNotMatch(auditText, /secrets\.|continue-on-error/u);
  // The exact-commit release gate retains its fixed job list.
  assert.deepEqual(Object.keys(ci.on).sort(), ["pull_request", "push", "workflow_dispatch"]);
  assert.ok(!Object.keys(ci.jobs).includes("audit") && !Object.keys(ci.jobs).includes("cold"));
  assert.match(renovateText, /"pinDigests": true/u);
});

test("public CI keeps native keyring signing in the private archive and preserves its verifier", async () => {
  const [workflow, verifier] = await Promise.all([
    readText(".github/workflows/ci.yml"),
    readText("scripts/phase1-github-attestation.mjs"),
  ]);
  await assert.rejects(readText(".github/workflows/phase1-native-keyring.yml"), { code: "ENOENT" });
  assert.doesNotMatch(workflow, /id-token:\s*write|attestations:\s*write|secrets\./u);
  assert.match(verifier, /GH_ATTESTATION_VERIFIER_VERSION = "2\.97\.0"/u);
  assert.match(
    verifier,
    /GH_ATTESTATION_VERIFIER_SHA256 =\n\s+"141507c337e8b202ad398550c3b73d72f5af92e86f71665214538a81efd4c409"/u,
  );
  assert.match(verifier, /"attestation",\n\s+"verify"/u);
  assert.match(verifier, /"--signer-workflow"/u);
  assert.match(verifier, /"--source-ref"/u);
  assert.match(verifier, /"--source-digest"/u);
  assert.match(verifier, /"--deny-self-hosted-runners"/u);
  assert.doesNotMatch(verifier, /verifyAttestation\s*=/u);
  assert.doesNotMatch(verifier, /readRepositoryState\s*=/u);
});

test("generated package-manager stores stay out of source control", async () => {
  const gitignore = await readText(".gitignore");

  assert.match(gitignore, /^\.pnpm-store\/$/mu);
  assert.match(gitignore, /^\.ohmyhost\/$/mu);
  assert.match(gitignore, /^\.wrangler\/$/mu);
});
