/* global structuredClone */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  sourceHash,
  requiresSourceReview,
  extractResources,
  validateFileReviews,
  validateResources,
  collectDiagrams,
  validateDiagrams,
  validateMarkdownLinks,
  validateDiagramSyntax,
  validateHistoricalMigration,
} from "../scripts/check-documentation.mjs";

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "ohmyhost-docs-check-"));
  try {
    await mkdir(path.join(root, "docs/architecture"), { recursive: true });
    await mkdir(path.join(root, "apps/example"), { recursive: true });
    await writeFile(
      path.join(root, "docs/architecture/example.md"),
      "# Example\n\n## Scope\n\n```mermaid\nflowchart LR\n  A[Client] --> B[Worker]\n```\n",
    );
    await writeFile(path.join(root, "apps/example/main.ts"), "export const mode = 'private';\n");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const sourceReview = () => ({
  path: "apps/example/main.ts",
  category: "source",
  reviewer: "engineer",
  reviewState: "reviewed",
  reviewMethod: "full-source-review",
  summary: "Reviewed the private worker mode and its documented scope.",
  sha256: sourceHash("export const mode = 'private';\n"),
  document: "docs/architecture/example.md#scope",
});

test("file reviews reject missing, duplicate, pending, stale and removed source records", async () => {
  assert.equal(requiresSourceReview("apps/preview-runtime/container/confine.c"), true);
  await fixture(async (root) => {
    const files = ["apps/example/main.ts"],
      record = sourceReview();
    assert.deepEqual(
      validateFileReviews({ root, files, coverage: { schemaVersion: 2, fileReviews: [record] } }),
      [],
    );
    for (const records of [
      [],
      [record, record],
      [{ ...record, reviewState: "pending" }],
      [{ ...record, sha256: "a".repeat(64) }],
      [{ ...record, document: "docs/architecture/example.md#gone" }],
      [{ ...record, path: "../outside.ts" }],
    ]) {
      assert.ok(
        validateFileReviews({ root, files, coverage: { schemaVersion: 2, fileReviews: records } })
          .length > 0,
      );
    }
    assert.ok(
      validateFileReviews({
        root,
        files: [],
        coverage: { schemaVersion: 2, fileReviews: [record] },
      }).some((error) => error.includes("Removed")),
    );
    const docPath = "docs/architecture/example.md";
    const documentReview = {
      ...record,
      path: docPath,
      category: "documentation",
      sha256: sourceHash("old documentation"),
    };
    assert.ok(
      validateFileReviews({
        root,
        files: [docPath],
        coverage: { schemaVersion: 2, fileReviews: [documentReview] },
      }).some((error) => error.includes("Changed source")),
    );
    await writeFile(path.join(root, files[0]), "export const mode = 'public';\n");
    assert.ok(
      validateFileReviews({
        root,
        files,
        coverage: { schemaVersion: 2, fileReviews: [record] },
      }).some((error) => error.includes("Changed source")),
    );
  });
});

test("resource coverage detects new private bindings, changed targets and duplicate declarations", async () => {
  await fixture(async (root) => {
    const file = "apps/example/wrangler.production.jsonc";
    await writeFile(
      path.join(root, file),
      JSON.stringify({
        name: "example-production",
        main: "main.ts",
        browser: { binding: "BROWSER" },
        services: [{ binding: "DATA", service: "database-production", entrypoint: "ScopedData" }],
        artifacts: [{ binding: "MANAGED_GIT", namespace: "git-production-eu" }],
        dispatch_namespaces: [
          {
            binding: "DISPATCHER",
            namespace: "customer-production",
            outbound: { service: "egress-production", parameters: ["EGRESS_CONTEXT"] },
          },
        ],
        tail_consumers: [{ service: "diagnostic-tail-production" }],
        queues: { consumers: [{ queue: "operations", dead_letter_queue: "operations-dlq" }] },
        containers: [
          {
            class_name: "Preview",
            scheduling_policy: "durable_object",
            images: { preview: { dockerfile: "./container/Dockerfile" } },
          },
        ],
      }),
    );
    const resources = extractResources(root, [file]);
    for (const kind of [
      "browser",
      "artifacts",
      "wfp-namespace",
      "wfp-outbound",
      "tail-consumer",
      "queue-dlq",
      "container-image",
    ])
      assert.ok(resources.some((record) => record.kind === kind));
    assert.equal(
      resources.find((record) => record.kind === "container-image").target,
      "./container/Dockerfile",
    );
    assert.deepEqual(
      resources.find((record) => record.kind === "browser"),
      {
        id: `${file}::default::browser::BROWSER`,
        file,
        profile: "default",
        kind: "browser",
        binding: "BROWSER",
        target: "",
        entrypoint: "",
      },
    );
    assert.deepEqual(
      resources.find((record) => record.kind === "artifacts"),
      {
        id: `${file}::default::artifacts::MANAGED_GIT`,
        file,
        profile: "default",
        kind: "artifacts",
        binding: "MANAGED_GIT",
        target: "git-production-eu",
        entrypoint: "",
      },
    );
    const coverage = {
      resources: resources.map((record) => ({
        ...record,
        document: "docs/architecture/example.md#scope",
      })),
      features: [],
      manualBoundaries: [],
    };
    assert.deepEqual(validateResources({ root, resources, coverage }), []);
    assert.ok(
      validateResources({
        root,
        resources,
        coverage: { ...coverage, resources: coverage.resources.slice(1) },
      }).some((error) => error.includes("Unmapped")),
    );
    assert.throws(() => extractResources(root, [file, file]), /Duplicate declared/u);
    const changed = structuredClone(coverage);
    changed.resources[0].target = "neighboring-production";
    assert.ok(
      validateResources({ root, resources, coverage: changed }).some((error) =>
        error.includes("Stale"),
      ),
    );
    assert.ok(
      validateResources({
        root,
        resources,
        coverage: { ...coverage, resources: [...coverage.resources, coverage.resources[0]] },
      }).some((error) => error.includes("Duplicate")),
    );
    await writeFile(path.join(root, file), JSON.stringify({ browser: {} }));
    assert.throws(() => extractResources(root, [file]), /Invalid browser resource declaration/u);
  });
});

test("diagram reviews fail when code, diagram bytes or resource mappings change", async () => {
  await fixture(async (root) => {
    const diagrams = collectDiagrams(root, ["docs/architecture/example.md"]);
    const diagram = {
      id: diagrams[0].id,
      document: diagrams[0].document,
      sha256: diagrams[0].sha256,
    };
    const record = {
      ...diagram,
      reviewer: "engineer",
      summary: "Reviewed the client-to-private-worker call against source.",
      sourceRefs: [{ path: sourceReview().path, sha256: sourceReview().sha256 }],
      resources: [],
    };
    assert.deepEqual(
      validateDiagrams({ root, diagrams, resources: [], coverage: { diagrams: [record] } }),
      [],
    );
    const resource = { id: "known-config-service", file: "apps/example/wrangler.jsonc" };
    const missingDependency = { ...record, resources: [resource.id] };
    assert.ok(
      validateDiagrams({
        root,
        diagrams,
        resources: [resource],
        coverage: { diagrams: [missingDependency] },
      }).some((error) => error.includes("lacks source dependency")),
    );

    for (const records of [
      [],
      [{ ...record, sha256: "a".repeat(64) }],
      [{ ...record, resources: ["missing-worker"] }],
      [{ ...record, sourceRefs: [] }],
      [{ ...record, sourceRefs: [{ path: sourceReview().path, sha256: "b".repeat(64) }] }],
    ]) {
      assert.ok(
        validateDiagrams({ root, diagrams, resources: [], coverage: { diagrams: records } })
          .length > 0,
      );
    }
  });
});

test("current Markdown links reject missing files and anchors", async () => {
  await fixture(async (root) => {
    const file = "docs/index.md";
    await writeFile(path.join(root, file), "# Docs\n[Valid](architecture/example.md#scope)\n");
    assert.deepEqual(validateMarkdownLinks(root, [file]), []);
    await writeFile(
      path.join(root, file),
      "# Docs\n[Missing](architecture/missing.md)\n[Stale](architecture/example.md#removed)\n",
    );
    assert.equal(validateMarkdownLinks(root, [file]).length, 2);
    await writeFile(
      path.join(root, file),
      "# Docs\n[Zero](../apps/example/main.ts#L0)\n[Invalid](../apps/example/main.ts#wrong)\n[Range](../apps/example/main.ts#L999-L1000)\n",
    );
    assert.equal(validateMarkdownLinks(root, [file]).length, 3);
  });
});

test("historical preservation rejects omitted originals, duplicates, mutable bypass and changed bytes", async () => {
  await fixture(async (root) => {
    await mkdir(path.join(root, "plan"), { recursive: true });
    await mkdir(path.join(root, "docs/plan/history"), { recursive: true });
    await mkdir(path.join(root, "docs/plan/evidence"), { recursive: true });
    const original = "retained exact receipt\n",
      from = "plan/receipt.txt",
      to = "docs/plan/evidence/receipt.txt";
    await writeFile(path.join(root, from), original);
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "--quiet");
    git("add", "--", from);
    git(
      "-c",
      "user.name=Documentation Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    await writeFile(path.join(root, to), original);
    const record = { from, to, sha256: sourceHash(original) },
      baseRevision = git("rev-parse", "HEAD");
    const save = async (moves) =>
      writeFile(
        path.join(root, "docs/plan/history/source-migration.json"),
        JSON.stringify({ baseRevision, moves }),
      );
    await save([record]);
    assert.deepEqual(validateHistoricalMigration(root, baseRevision), []);
    assert.ok(validateHistoricalMigration(root, "a".repeat(40)).length > 0);
    for (const moves of [
      [],
      [record, record],
      [{ ...record, mutable: true }],
      [{ ...record, mutable: "yes" }],
      [{ ...record, from: "other.txt" }],
    ]) {
      await save(moves);
      assert.ok(validateHistoricalMigration(root, baseRevision).length > 0);
    }
    await save([record]);
    await writeFile(path.join(root, to), "rewritten receipt\n");
    assert.ok(
      validateHistoricalMigration(root, baseRevision).some((error) =>
        error.includes("bytes changed"),
      ),
    );
  });
});

test("every production custom-domain route is named in the threat model", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const threatModel = await readFile(
    path.join(root, "docs/architecture/security/threat-model.md"),
    "utf8",
  );
  const hosts = [];
  for (const app of await readdir(path.join(root, "apps"))) {
    const config = await readFile(
      path.join(root, "apps", app, "wrangler.production.jsonc"),
      "utf8",
    ).catch(() => "");
    for (const [, host] of config.matchAll(/"pattern":\s*"([^"]+)",\s*"custom_domain":\s*true/gu))
      hosts.push(host);
  }
  assert.ok(hosts.includes("ai.ohmyho.st"));
  for (const host of hosts) assert.ok(threatModel.includes(host), `threat model names ${host}`);
});

test(
  "the pinned Mermaid grammar rejects invalid syntax without a browser",
  { timeout: 35_000 },
  async () => {
    await assert.rejects(
      validateDiagramSyntax([
        { id: "negative-syntax-fixture", source: "flowchart LR\n  A[Client --> B[Worker" },
      ]),
      (error) =>
        error instanceof Error &&
        error.message.includes("negative-syntax-fixture") &&
        /Parse error|Lexical error|Syntax error/iu.test(error.message),
    );
  },
);
