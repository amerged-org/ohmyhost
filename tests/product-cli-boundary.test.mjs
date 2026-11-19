import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

import {
  verifyProductCliBoundary,
  verifyProductCliSourceBoundary,
} from "../scripts/check-product-cli-boundary.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Product CLI boundary verifier", () => {
  it("fails closed when emitted build evidence is absent", async () => {
    const root = await createFixture();
    await rm(join(root, "apps/product-cli/dist/bin.js"));

    assert.throws(
      () => verifyProductCliBoundary({ repositoryRoot: root, runTypeScriptResolution: false }),
      /build evidence missing/u,
    );
  });

  it("rejects a forbidden transitive workspace dependency", async () => {
    const root = await createFixture();
    const sdkManifestPath = join(root, "packages/sdk-ts/package.json");
    const sdkManifest = JSON.parse(await readFile(sdkManifestPath, "utf8"));
    sdkManifest.dependencies = { "@ohmyhost/database": "workspace:*" };
    await writeFile(sdkManifestPath, JSON.stringify(sdkManifest));
    await writeJson(join(root, "packages/database/package.json"), {
      name: "@ohmyhost/database",
      version: "0.0.0",
    });

    assert.throws(
      () => verifyProductCliBoundary({ repositoryRoot: root, runTypeScriptResolution: false }),
      /forbidden dependency '@ohmyhost\/database'/u,
    );
  });

  for (const forbiddenWorkosImport of [
    "@ohmyhost/workos-auth-contracts",
    "@ohmyhost/workos-auth-contracts/management-rpc",
    "@ohmyhost/workos-auth-contracts/organizations",
    "@ohmyhost/workos-auth-contracts/tokens",
    "@ohmyhost/workos-auth-contracts/webhooks",
  ]) {
    it(`rejects non-public WorkOS import ${forbiddenWorkosImport}`, async () => {
      const root = await createFixture();
      const cliPath = join(root, "apps/product-cli/src/cli.ts");
      const cli = await readFile(cliPath, "utf8");
      await writeFile(cliPath, `import "${forbiddenWorkosImport}";\n${cli}`);

      assert.throws(
        () => verifyProductCliBoundary({ repositoryRoot: root, runTypeScriptResolution: false }),
        /imports non-public WorkOS surface/u,
      );
    });
  }

  it("rejects child-process and Babel parser imports", async () => {
    const root = await createFixture();
    const cliPath = join(root, "apps/product-cli/src/cli.ts");
    const cli = await readFile(cliPath, "utf8");
    for (const [statement, refusal] of [
      ['import { spawn } from "node:child_process";', /forbidden dependency 'node:child_process'/u],
      // The runtime-source walk keeps Babel in SourceFetcher; the published CLI never bundles it.
      ['import { parse } from "@babel/parser";', /forbidden dependency '@babel\/parser'/u],
    ]) {
      await writeFile(cliPath, `${statement}\n${cli}`);
      assert.throws(
        () => verifyProductCliBoundary({ repositoryRoot: root, runTypeScriptResolution: false }),
        refusal,
      );
    }
  });

  it("permits only the reviewed local token-file helper and rejects forged source and emitted helpers", async () => {
    const actualRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    assert.doesNotThrow(() =>
      verifyProductCliSourceBoundary({
        repositoryRoot: actualRoot,
        runTypeScriptResolution: false,
      }),
    );
    const root = await createFixture();
    const cliPath = join(root, "apps/product-cli/src/cli.ts");
    const cli = await readFile(cliPath, "utf8");
    await writeFile(cliPath, `import "./user-token-file.js";\n${cli}`);
    const forged =
      'import { execFile } from "node:child_process"; execFile("curl", ["https://provider.example.test"]);';
    await writeFile(join(root, "apps/product-cli/src/user-token-file.ts"), forged);
    assert.throws(
      () =>
        verifyProductCliSourceBoundary({ repositoryRoot: root, runTypeScriptResolution: false }),
      /unreviewed local credential-file helper/u,
    );
    await writeFile(cliPath, cli);
    const emittedPath = join(root, "apps/product-cli/dist/cli.js");
    const emitted = await readFile(emittedPath, "utf8");
    await writeFile(emittedPath, `import "./user-token-file.js";\n${emitted}`);
    await writeFile(join(root, "apps/product-cli/dist/user-token-file.js"), forged);
    assert.throws(
      () => verifyProductCliBoundary({ repositoryRoot: root, runTypeScriptResolution: false }),
      /unreviewed local credential-file helper/u,
    );
  });

  it("rejects createRequire runtime-loader imports", async () => {
    const root = await createFixture();
    const emittedPath = join(root, "apps/product-cli/dist/cli.js");
    const emitted = await readFile(emittedPath, "utf8");
    await writeFile(emittedPath, `import { createRequire } from "node:module";\n${emitted}`);

    assert.throws(
      () => verifyProductCliBoundary({ repositoryRoot: root, runTypeScriptResolution: false }),
      /forbidden helper-process or runtime-loader primitive 'createRequire'/u,
    );
  });

  it("rejects login when it reaches a product mutation dependency", async () => {
    const root = await createFixture();
    const cliPath = join(root, "apps/product-cli/src/cli.ts");
    await writeFile(
      cliPath,
      "export class ProductCli { async run(command) { if (command.kind === 'login') return this.login(); } async login() { return this.productApi.createProject(); } }",
    );

    assert.throws(
      () => verifyProductCliBoundary({ repositoryRoot: root, runTypeScriptResolution: false }),
      /login reaches product mutation dependency/u,
    );
  });

  it("rejects forbidden emitted imports even when source evidence is clean", async () => {
    const root = await createFixture();
    const emittedPath = join(root, "apps/product-cli/dist/cli.js");
    const emitted = await readFile(emittedPath, "utf8");
    await writeFile(emittedPath, `import "pg";\n${emitted}`);

    assert.throws(
      () => verifyProductCliBoundary({ repositoryRoot: root, runTypeScriptResolution: false }),
      /forbidden dependency 'pg'.*emitted import/u,
    );
  });

  it("rejects invalid optional bundle metadata", async () => {
    const root = await createFixture();
    await writeFileWithParents(
      join(root, "apps/product-cli/dist/bundle-metafile.json"),
      "not-json",
    );

    assert.throws(
      () => verifyProductCliBoundary({ repositoryRoot: root, runTypeScriptResolution: false }),
      /invalid bundle metadata/u,
    );
  });

  it("reports source and emitted evidence separately for a valid graph", async () => {
    const root = await createFixture();

    const evidence = verifyProductCliBoundary({
      repositoryRoot: root,
      runTypeScriptResolution: false,
    });

    assert.deepEqual(evidence.source.login.reachableMethods, ["login"]);
    assert.equal(evidence.source.imports.fileCount, 3);
    assert.equal(evidence.build.fileCount, 3);
    assert.equal(evidence.build.sourceMapCount, 3);
    assert.deepEqual(evidence.build.login.reachableMethods, ["login"]);
  });

  it("accepts a valid JSON asset exported by a reachable workspace package", async () => {
    const root = await createFixture();
    const productManifestPath = join(root, "apps/product-cli/package.json");
    const productManifest = JSON.parse(await readFile(productManifestPath, "utf8"));
    productManifest.dependencies["@ohmyhost/contracts"] = "workspace:*";
    await writeFile(productManifestPath, JSON.stringify(productManifest));
    await writeJson(join(root, "packages/contracts/package.json"), {
      name: "@ohmyhost/contracts",
      version: "0.0.0",
      exports: {
        "./schema.json": "./schemas/schema.json",
      },
    });
    await writeJson(join(root, "packages/contracts/schemas/schema.json"), {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
    });
    const cliPath = join(root, "apps/product-cli/src/cli.ts");
    const cli = await readFile(cliPath, "utf8");
    await writeFile(
      cliPath,
      `import schema from "@ohmyhost/contracts/schema.json";\n${cli}\nvoid schema;\n`,
    );
    const emittedPath = join(root, "apps/product-cli/dist/cli.js");
    const emitted = await readFile(emittedPath, "utf8");
    await writeFile(
      emittedPath,
      `import schema from "@ohmyhost/contracts/schema.json" with { type: "json" };\n${emitted.replace("//# sourceMappingURL=cli.js.map", "void schema;\n//# sourceMappingURL=cli.js.map")}`,
    );

    const evidence = verifyProductCliBoundary({
      repositoryRoot: root,
      runTypeScriptResolution: false,
    });

    assert.equal(evidence.build.assetCount, 1);
  });
});

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "product-cli-boundary-"));
  temporaryDirectories.push(root);

  await writeJson(join(root, "apps/product-cli/package.json"), {
    name: "@ohmyhost/product-cli",
    version: "0.0.0",
    dependencies: { "@ohmyhost/sdk-ts": "workspace:*" },
  });
  await writeJson(join(root, "packages/sdk-ts/package.json"), {
    name: "@ohmyhost/sdk-ts",
    version: "0.0.0",
    exports: {
      ".": { source: "./src/index.ts", import: "./dist/index.js" },
    },
  });
  await writeFileWithParents(
    join(root, "apps/product-cli/src/bin.ts"),
    'import { ProductCli } from "./cli.js"; void ProductCli;\n',
  );
  await writeFileWithParents(
    join(root, "apps/product-cli/src/cli.ts"),
    "import { sdk } from \"@ohmyhost/sdk-ts\"; export class ProductCli { async run(argv) { const command = parse(argv); return this.runCommand(command); } async runCommand(command) { if (command.kind === 'login') return this.login(); return 'other'; } async login() { return 'authenticated'; } } const parse = (value) => value; void sdk;\n",
  );
  await writeFileWithParents(
    join(root, "packages/sdk-ts/src/index.ts"),
    "export const sdk = true;\n",
  );

  await writeEmitted(
    root,
    "apps/product-cli/dist/bin.js",
    'import { ProductCli } from "./cli.js"; void ProductCli;\n',
    "../src/bin.ts",
  );
  await writeEmitted(
    root,
    "apps/product-cli/dist/cli.js",
    "import { sdk } from \"@ohmyhost/sdk-ts\"; export class ProductCli { async run(argv) { const command = parse(argv); return this.runCommand(command); } async runCommand(command) { if (command.kind === 'login') return this.login(); return 'other'; } async login() { return 'authenticated'; } } const parse = (value) => value; void sdk;\n",
    "../src/cli.ts",
  );
  await writeEmitted(
    root,
    "packages/sdk-ts/dist/index.js",
    "export const sdk = true;\n",
    "../src/index.ts",
  );
  return root;
};

const writeEmitted = async (root, relativePath, body, source) => {
  const path = join(root, relativePath);
  const mapName = `${relativePath.split("/").at(-1)}.map`;
  await writeFileWithParents(path, `${body}//# sourceMappingURL=${mapName}\n`);
  await writeJson(`${path}.map`, {
    version: 3,
    file: relativePath.split("/").at(-1),
    sourceRoot: "",
    sources: [source],
    names: [],
    mappings: "",
  });
};

const writeJson = async (path, value) => {
  await writeFileWithParents(path, JSON.stringify(value));
};

const writeFileWithParents = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
};
