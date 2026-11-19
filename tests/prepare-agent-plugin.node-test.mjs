import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { prepareAgentPlugin } from "../scripts/prepare-agent-plugin.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("plugin preparation includes exact canonical Skills and checks the contained installable package", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "ohmyhost-plugin-package-"));
  try {
    const destination = resolve(temporary, "ohmyhost");
    await prepareAgentPlugin({ repository, destination });
    await prepareAgentPlugin({ repository, destination, check: true });
    const readme = await readFile(resolve(destination, "README.md"), "utf8");
    assert.match(readme, /current account membership, roles and.*token restrictions/iu);
    assert.doesNotMatch(
      readme,
      /project selection and preview\/publish rights are then approved|successful OAuth connection alone grants no application access|explicit grants/iu,
    );
    const path = "skills/ohmyhost-deploy/SKILL.md";
    assert.deepEqual(
      await readFile(resolve(destination, path)),
      await readFile(resolve(repository, "skills/ohmyhost-deploy/SKILL.md")),
    );
    for (const manifest of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]) {
      const value = JSON.parse(await readFile(resolve(destination, manifest), "utf8"));
      assert.equal(value.skills, "./skills/");
      assert.equal(value.mcpServers, "./.mcp.json");
    }
    await writeFile(resolve(destination, path), "changed after preparation");
    await assert.rejects(
      prepareAgentPlugin({ repository, destination, check: true }),
      /bytes are stale/u,
    );
    await prepareAgentPlugin({ repository, destination });
    await writeFile(resolve(destination, ".env"), "PRIVATE_TEST_VALUE=true\n");
    await assert.rejects(prepareAgentPlugin({ repository, destination }), /unexpected files/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("plugin preparation refuses credential configuration and linked package resources", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "ohmyhost-plugin-boundary-"));
  try {
    const local = resolve(temporary, "repository");
    const templates = resolve(local, "plugins/ohmyhost");
    await cp(resolve(repository, "plugins/ohmyhost"), templates, { recursive: true });
    await mkdir(resolve(local, "skills"));
    await cp(
      resolve(repository, "skills/ohmyhost-deploy"),
      resolve(local, "skills/ohmyhost-deploy"),
      { recursive: true },
    );
    const config = JSON.parse(await readFile(resolve(templates, ".mcp.json"), "utf8"));
    config.mcpServers.ohmyho.headers = { Authorization: "PRIVATE_TEST_VALUE" };
    await writeFile(resolve(templates, ".mcp.json"), JSON.stringify(config));
    await assert.rejects(prepareAgentPlugin({ repository: local }), /credential-free/u);
    await cp(resolve(repository, "plugins/ohmyhost/.mcp.json"), resolve(templates, ".mcp.json"));
    await symlink(
      resolve(repository, "skills/ohmyhost-deploy/SKILL.md"),
      resolve(local, "skills/ohmyhost-deploy/linked.md"),
    );
    await assert.rejects(prepareAgentPlugin({ repository: local }), /symbolic links/u);
    await rm(resolve(local, "skills/ohmyhost-deploy/linked.md"));
    await writeFile(
      resolve(local, "skills/ohmyhost-deploy/.env.local"),
      "PRIVATE_TEST_VALUE=true\n",
    );
    await assert.rejects(prepareAgentPlugin({ repository: local }), /credential files/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
