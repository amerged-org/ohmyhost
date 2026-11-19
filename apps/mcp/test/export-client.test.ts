import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { GeneratedSdkLocalMcpClient } from "../src/local-client.js";
import { GeneratedSdkProductApi } from "../../product-cli/src/product-api.js";
const project = "00000000000000000000000001",
  operation = "00000000000000000000000002",
  now = "2026-09-10T00:00:00.000Z";
const queued = { id: operation, state: "queued", created_at: now, updated_at: now };
const state = {
  id: operation,
  project_id: project,
  state: "queued",
  requested_at: now,
  next_request_at: "2026-09-11T00:00:00.000Z",
  next_poll_after_seconds: 5,
  error: null,
  archive: null,
};
it("sends a user password through the generated API and keeps it out of CLI/MCP results", async () => {
  const root = await mkdtemp(join(tmpdir(), "omh-export-password-"));
  const path = join(root, "password");
  await writeFile(path, "test-pass-1234", { mode: 0o600 });
  const requests: { path: string; body: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push({ path: request.url ?? "", body });
    expect(request.headers.authorization).toBe("Bearer customer-token");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.method === "POST" ? queued : state));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture missing");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const cli = new GeneratedSdkProductApi(base, "customer-token", fetch),
      mcp = new GeneratedSdkLocalMcpClient(base, "customer-token", fetch);
    expect(
      await cli.createProjectExport({
        projectId: project,
        password: "test-pass-1234",
        idempotencyKey: "cli-export",
      }),
    ).toEqual(queued);
    expect(await cli.getProjectExport({ projectId: project, exportId: operation })).toEqual(state);
    expect(
      await mcp.createProjectExport({
        projectId: project,
        passwordFile: path,
        idempotencyKey: "mcp-export",
      }),
    ).toEqual(queued);
    const result = await mcp.getProjectExport({ projectId: project, exportId: operation });
    expect(result).toEqual(state);
    expect(JSON.stringify(result)).not.toContain("test-pass-1234");
    expect(requests.map((item) => item.path)).toEqual([
      `/v1/projects/${project}/exports`,
      `/v1/projects/${project}/exports/${operation}`,
      `/v1/projects/${project}/exports`,
      `/v1/projects/${project}/exports/${operation}`,
    ]);
    expect(JSON.parse(requests[2]?.body ?? "{}")).toEqual({ password: "test-pass-1234" });
    await writeFile(path, "test-pass-1");
    await expect(
      mcp.createProjectExport({ projectId: project, passwordFile: path, idempotencyKey: "short" }),
    ).rejects.toThrow("EXPORT_PASSWORD_FILE_INVALID");
    expect(requests).toHaveLength(4);
    await writeFile(path, "x".repeat(1025));
    await expect(
      mcp.createProjectExport({ projectId: project, passwordFile: path, idempotencyKey: "large" }),
    ).rejects.toThrow("EXPORT_PASSWORD_FILE_INVALID");
    await writeFile(path, "test-pass-1234");
    await chmod(path, 0o644);
    if (process.platform !== "win32")
      await expect(
        mcp.createProjectExport({
          projectId: project,
          passwordFile: path,
          idempotencyKey: "public",
        }),
      ).rejects.toThrow("EXPORT_PASSWORD_FILE_INVALID");
    await chmod(path, 0o600);
    await symlink(path, join(root, "link"));
    await expect(
      mcp.createProjectExport({
        projectId: project,
        passwordFile: join(root, "link"),
        idempotencyKey: "linked",
      }),
    ).rejects.toThrow("EXPORT_PASSWORD_FILE_INVALID");
    expect(requests).toHaveLength(4);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it("signs one download link through the generated API for the CLI and the MCP client", async () => {
  const link = {
    id: operation,
    project_id: project,
    download_url: "https://exports.example.test/signed-zip",
    download_expires_at: "2026-09-11T00:00:00.000Z",
  };
  let reply: unknown = link;
  const requests: { method: string; path: string }[] = [];
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    requests.push({ method: request.method ?? "", path: request.url ?? "" });
    expect(request.headers.authorization).toBe("Bearer customer-token");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(reply));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture missing");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const cli = new GeneratedSdkProductApi(base, "customer-token", fetch),
      mcp = new GeneratedSdkLocalMcpClient(base, "customer-token", fetch);
    expect(
      await cli.createProjectExportDownloadLink({ projectId: project, exportId: operation }),
    ).toEqual(link);
    expect(
      await mcp.createProjectExportDownloadLink({ projectId: project, exportId: operation }),
    ).toEqual(link);
    expect(requests).toEqual([
      { method: "POST", path: `/v1/projects/${project}/exports/${operation}/download-links` },
      { method: "POST", path: `/v1/projects/${project}/exports/${operation}/download-links` },
    ]);
    // A response that is not a verified https link is refused before it reaches a customer.
    reply = { ...link, download_url: "http://exports.example.test/signed-zip" };
    await expect(
      mcp.createProjectExportDownloadLink({ projectId: project, exportId: operation }),
    ).rejects.toThrow("Project export download link is invalid");
    await expect(
      cli.createProjectExportDownloadLink({ projectId: project, exportId: operation }),
    ).rejects.toThrow("Project export download link is invalid");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
