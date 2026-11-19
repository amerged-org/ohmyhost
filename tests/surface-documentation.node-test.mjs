import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";

import { auditSurfaceDocumentation } from "../scripts/check-surface-documentation.mjs";
import {
  renderSurfaceReference,
  SURFACE_REFERENCE,
} from "../scripts/prepare-surface-reference.mjs";

test("every CLI command and MCP tool is named in the Skills an agent reads", () => {
  // The customer documentation lives in its own repository, so only the Skills are checked here;
  // `node scripts/check-surface-documentation.mjs <docs-clone>` checks both before a docs release.
  const audit = auditSurfaceDocumentation(null);
  assert.ok(audit.mcpTools > 60, "the tool catalog must be loaded");
  assert.ok(audit.cliCommands > 60, "the command list must be loaded");
  assert.deepEqual(
    audit.report.map(({ kind, name }) => `${kind}: ${name}`),
    [],
    "extend the Skills instead of shipping an undocumented surface",
  );
});

test("the generated surface reference matches the shipped clients", () => {
  const { text } = renderSurfaceReference();
  assert.equal(
    readFileSync(SURFACE_REFERENCE, "utf8"),
    text,
    "run node scripts/prepare-surface-reference.mjs after changing a command or tool",
  );
});

test("remote documentation satisfies actual uploaded tool promises without treating local capabilities as remote", async () => {
  const rendered = renderSurfaceReference();
  assert.match(rendered.text, /^## CLI commands$/mu);
  assert.match(rendered.text, /^## Local MCP tools$/mu);
  assert.match(rendered.text, /^## Remote MCP tools$/mu);
  const { readRemoteMcpSurface } = await import("../scripts/prepare-surface-reference.mjs");
  const remote = readRemoteMcpSurface();
  const bundledSource = readFileSync(
    new URL("../packages/contracts/generated/openapi.json", import.meta.url),
    "utf8",
  );
  const bundledSha256 = createHash("sha256").update(bundledSource).digest("hex");
  assert.equal(
    remote.contractSha256,
    bundledSha256,
    "surface hash must identify exact bundled bytes",
  );
  assert.ok(rendered.text.includes(bundledSha256));
  const { renderRemoteMcpSnippet } = await import("../scripts/prepare-surface-reference.mjs");
  const snippet = renderRemoteMcpSnippet();
  assert.ok(snippet.includes(bundledSha256), "public snippet must identify the same bundled bytes");
  const tools = new Map(remote.tools.map((tool) => [tool.name, tool]));
  for (const name of [
    "secret_input_request",
    "workspace_setup",
    "native_auth_provider_set",
    "native_auth_provider_secret_input_request",
    "identity_get",
  ]) {
    const tool = tools.get(name);
    assert.equal(
      tool.inputSchema,
      undefined,
      `${name} must not claim REST inputs are its MCP schema`,
    );
    assert.doesNotMatch(tool.description, /Accepts a write-only value|Creates an organization/u);
  }
  for (const name of ["secret_input_request", "workspace_setup"])
    assert.match(tools.get(name).description, /tools\/list|portal|form/u);
  assert.doesNotMatch(snippet, /Accepts a write-only value|Creates an organization/u);
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/openai-human-r4-0.1.52-tool-promises.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    fixture.source.sha256,
    "913d802adaf04efdccb85272056f9c6c7b9ab4c904f5e9894f5d7bdb7ceed44e",
  );
  for (const promise of fixture.promises) {
    const tool = tools.get(promise.tool);
    assert.ok(tool, `${promise.source_skill}:${promise.source_line} promises ${promise.tool}`);
    for (const property of promise.input_properties)
      assert.ok(
        tool.inputSchema?.properties?.[property],
        `${promise.tool} must accept ${property}`,
      );
    assert.match(rendered.text, new RegExp(`^- \\x60${promise.tool}\\x60`, "mu"));
  }
  assert.equal(tools.get("database_write").inputSchema.properties.confirmed.const, true);
  assert.equal(tools.get("database_compute_set").inputSchema.properties.confirm.const, true);
  assert.deepEqual(tools.get("database_query").inputSchema.properties.environment.enum, [
    "dev",
    "prod",
  ]);
  for (const exception of fixture.intentional_local_or_handoff)
    assert.equal(tools.has(exception.tool), false, exception.reason);
  assert.equal(tools.has("api_reference"), true);
  for (const name of ["api_call", "api_execute", "execute_api"])
    assert.equal(tools.has(name), false, "documentation must not introduce a public executor");
  const database = readFileSync(
    new URL("../skills/ohmyhost-manage-database/SKILL.md", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(database, /remote MCP cannot create or delete watches|local server adds/u);
  assert.match(database, /local `promotion_execute` or remote `deployment_promote`/u);
  for (const correction of fixture.requires_imported_skill_update) {
    if (correction.remote_tool)
      assert.equal(tools.has(correction.remote_tool), true, correction.reason);
    const skill = readFileSync(new URL(`../${correction.source_skill}`, import.meta.url), "utf8");
    assert.match(skill, /local|Remote|remote/u, correction.reason);
  }
  const start = readFileSync(
    new URL("../skills/ohmyhost-get-started/SKILL.md", import.meta.url),
    "utf8",
  );
  assert.match(start, /api_reference/u);
  assert.doesNotMatch(start, /Remote-only tools like this one are\s+not in the surfaces list/u);
  const audit = auditSurfaceDocumentation(null);
  assert.equal(audit.remoteMcpTools, remote.tools.length);
  assert.deepEqual(audit.report, []);
  for (const platform of [".codex-plugin", ".claude-plugin"]) {
    const manifest = JSON.parse(
      readFileSync(new URL(`../plugins/ohmyhost/${platform}/plugin.json`, import.meta.url), "utf8"),
    );
    assert.equal(manifest.mcpServers, "./.mcp.json");
  }
  assert.equal(fixture.claude_variant.workflow_count, 4);
  assert.equal(fixture.claude_variant.review_bytes_changed, false);
  assert.equal(fixture.claude_variant.endpoint, fixture.source.endpoint);
});
