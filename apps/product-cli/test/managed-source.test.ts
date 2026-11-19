import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkosDeviceFlowClient } from "@ohmyhost/workos-auth-contracts/device-flow";
import type {
  ManagedProjectSource,
  ManagedSourceUploadReceipt,
  SourceManifestFile,
} from "@ohmyhost/contracts/managed-sources";
import type { Operation } from "@ohmyhost/sdk-ts";

import { ProductCli } from "../src/cli.js";
import { parseProductCliCommand } from "../src/command.js";
import {
  createBoundedFetch,
  runProductionCli,
  resolveProductCliEnvironment,
} from "../src/composition.js";
import { GeneratedSdkProductApi } from "../src/product-api.js";
import { OwnerOnlyProjectLinkStore, readProjectLinks } from "../src/project-link-store.js";
import { createSourceSnapshot, inspectSourceWorkspace } from "../src/source-workspace.js";
import { publishSourceSnapshot } from "../src/source-publisher.js";
import {
  prepareLocalSourcePublication,
  completeLocalSourcePublication,
  inspectLocalSourcePublications,
} from "../src/source-publication-store.js";
import { createLocalOhmyhostMcpHandler } from "../../mcp/src/local-server.js";
import { GeneratedSdkLocalMcpClient } from "../../mcp/src/local-client.js";
import { memoryProfiles, login } from "./memory-profiles.js";

const PROJECT = "01K2F3G4H5J6K7M8N9P0QRSTVW";
const CONNECTION = "01K2F3G4H5J6K7M8N9P0QRSTVX";
const ORGANIZATION = "00000000000000000000000001";
const OPERATION = "01K2F3G4H5J6K7M8N9P0QRSTVY";
const DATE = "2026-10-06T00:00:00.000Z";
const GITHUB_SOURCE = {
  provider: "github" as const,
  source_connection_id: CONNECTION,
  source_generation: 1,
  installation_id: "42",
  repository_full_name: "owner/repository",
  status: "ready" as const,
  linked_at: DATE,
  updated_at: DATE,
};
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "omh-managed-source-")));
  roots.push(root);
  await fs.writeFile(join(root, "main.ts"), "export const current = 'uncommitted';\n");
  await fs.writeFile(join(root, "config.json"), '{"feature":true}\n');
  await fs.writeFile(join(root, ".env.local"), "NEVER_UPLOAD=private-value\n");
  return root;
}

/** HTTP fixture for consumer wire behavior; provider/state-machine acceptance lives server-side. */
class SourceControl {
  public source: ManagedProjectSource | typeof GITHUB_SOURCE | null = null;
  public state: ManagedSourceUploadReceipt["state"] = "staging";
  public loseFinalize = false;
  public sourceUnavailable = false;
  public ignoreBindingQuery = false;
  public rejectStaleUpload = false;
  public staleUploadConflict: "source_generation_conflict" | "source_commit_conflict" =
    "source_commit_conflict";
  public operationState: Operation["state"] = "succeeded";
  public readonly calls: Array<{
    path: string;
    method: string;
    body: Record<string, unknown>;
    key: string | null;
    authorization: string | null;
  }> = [];
  public readonly uploaded = new Map<
    string,
    { manifest: SourceManifestFile; content_base64: string }
  >();
  public readonly projectIdentity = {
    project_id: PROJECT,
    url: "https://steady-otter.ohmyho.st",
    data_id: "unchanged-data",
  };
  #request: Record<string, unknown> = {};
  #commit = "a".repeat(40);
  #uploadCommit: string | null = null;
  #uploadKey: string | null = null;
  #uploadRequests = new Map<string | null, string>();
  #commits = 0;
  #trees = new Map<string, Map<string, { manifest: SourceManifestFile; content_base64: string }>>();

  public advanceHead(): void {
    this.#commit = "c".repeat(40);
    if (this.source?.provider === "managed")
      this.source = { ...this.source, current_commit_sha: this.#commit };
    const data = Buffer.from("other chat's edit\n");
    this.uploaded.set("main.ts", {
      manifest: {
        path: "main.ts",
        sha256: `sha256:${createHash("sha256").update(data).digest("hex")}`,
        byte_length: data.byteLength,
        executable: false,
      },
      content_base64: data.toString("base64"),
    });
    this.#trees.set(this.#commit, new Map(this.uploaded));
  }

  public operation(state: Operation["state"] = this.operationState): Operation {
    return {
      id: OPERATION,
      state,
      created_at: DATE,
      updated_at: DATE,
      ...(state === "failed"
        ? {
            error: {
              code: "operation_failed",
              message: "The operation failed",
              retryable: false,
              suggested_action: "Read and merge the source before retrying.",
            },
          }
        : {}),
    };
  }
  public receipt(): ManagedSourceUploadReceipt {
    return {
      operation_id: OPERATION,
      state: this.state,
      expected_source_generation: Number(this.#request["expected_source_generation"] ?? 0),
      expected_commit_sha: (this.#request["expected_commit_sha"] as string | null) ?? null,
      commit_sha: this.state === "committed" ? this.#uploadCommit : null,
      expires_at: "2026-10-06T01:00:00.000Z",
    };
  }
  public fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const body =
      request.method === "GET" ? {} : (JSON.parse(await request.text()) as Record<string, unknown>);
    this.calls.push({
      path: `${url.pathname}${url.search}`,
      method: request.method,
      body,
      key: request.headers.get("Idempotency-Key"),
      authorization: request.headers.get("authorization"),
    });
    let result: unknown;
    if (url.pathname === "/v1/me")
      result = {
        actor_id: "user:user_test",
        email: "owner@example.test",
        organization_ids: [ORGANIZATION],
        organizations: [{ id: ORGANIZATION, name: "Owner" }],
      };
    else if (url.pathname === "/v1/me/profile")
      result = {
        user_id: "user_test",
        name: "Owner",
        email: "owner@example.test",
        email_verified: true,
        organizations: [{ id: ORGANIZATION, workos_id: "org_managed", name: "Owner" }],
        organization_ids: [ORGANIZATION],
        signup_source: null,
        attributed_at: null,
        initial_workspace_id: ORGANIZATION,
      };
    else if (url.pathname === `/v1/organizations/${ORGANIZATION}/github`)
      result = { status: "not_connected", connection: null };
    else if (url.pathname === `/v1/operations/${OPERATION}`) result = this.operation();
    else if (!url.pathname.startsWith(`/v1/projects/${PROJECT}/source`))
      return Response.json(
        {
          type: "https://ohmyho.st/problems/resource_not_found",
          title: "Resource not found",
          status: 404,
          code: "resource_not_found",
          request_id: "source-scope",
          retryable: false,
          suggested_action: "Read the selected project.",
        },
        { status: 404 },
      );
    else if (url.pathname.endsWith("source:initialize")) {
      this.#bind(1);
      result = this.operation();
    } else if (url.pathname.endsWith("source/uploads") && request.method === "POST") {
      const key = request.headers.get("Idempotency-Key");
      const originalRequest = this.#uploadRequests.get(key);
      if (originalRequest !== undefined && originalRequest !== JSON.stringify(body))
        return Response.json(
          {
            type: "https://ohmyho.st/problems/idempotency-key-conflict",
            title: "Idempotency key conflict",
            status: 409,
            code: "idempotency_key_reused",
            request_id: "source-replay-conflict",
            retryable: false,
            suggested_action: "Reuse the original request for this key.",
          },
          { status: 409 },
        );
      if (
        this.rejectStaleUpload &&
        this.#uploadKey !== key &&
        body["mode"] === "commit" &&
        body["expected_commit_sha"] !== this.#commit
      )
        return Response.json(
          {
            type: "https://ohmyho.st/problems/source-generation-conflict",
            title: "Source binding changed",
            status: 409,
            code: this.staleUploadConflict,
            request_id: "source-admission-conflict",
            retryable: false,
            suggested_action: "Read and merge the source, then start a new request.",
          },
          { status: 409 },
        );
      if (this.#uploadKey !== request.headers.get("Idempotency-Key")) {
        this.state = "staging";
        this.uploaded.clear();
        this.#uploadCommit = null;
        this.#uploadKey = request.headers.get("Idempotency-Key");
      }
      this.#uploadRequests.set(key, JSON.stringify(body));
      this.#request = body;
      result = this.operation(this.state === "committed" ? "succeeded" : "queued");
    } else if (url.pathname.endsWith(`/source/uploads/${OPERATION}`)) result = this.receipt();
    else if (url.pathname.endsWith(`/source/uploads/${OPERATION}/files`)) {
      const contents = Buffer.from(String(body["content_base64"]), "base64");
      const manifest = {
        path: String(body["path"]),
        sha256: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
        byte_length: contents.byteLength,
        executable: body["executable"] === true,
      };
      expect(body["sha256"]).toBe(manifest.sha256);
      this.uploaded.set(manifest.path, {
        manifest,
        content_base64: String(body["content_base64"]),
      });
      result = manifest;
    } else if (url.pathname.endsWith(":commit") || url.pathname.endsWith("source:switch")) {
      if (
        this.#request["mode"] === "commit" &&
        this.#request["expected_commit_sha"] !== this.#commit
      ) {
        this.state = "failed";
        this.operationState = "failed";
        return Response.json(
          {
            type: "https://ohmyho.st/problems/source-commit-conflict",
            title: "Source conflict",
            status: 409,
            code: "source_commit_conflict",
            request_id: "source-head-conflict",
            retryable: false,
            suggested_action: "Read and merge the source before retrying.",
          },
          { status: 409 },
        );
      }
      expect(body["files"]).toEqual([...this.uploaded.values()].map((entry) => entry.manifest));
      this.state = "committed";
      this.#commits += 1;
      this.#commit =
        this.#commits === 1
          ? "b".repeat(40)
          : createHash("sha1").update(`commit-${this.#commits}`).digest("hex");
      this.#uploadCommit = this.#commit;
      this.#trees.set(this.#commit, new Map(this.uploaded));
      this.#bind(
        Number(this.#request["expected_source_generation"]) +
          (this.#request["mode"] === "commit" ? 0 : 1),
      );
      if (this.loseFinalize) {
        this.loseFinalize = false;
        throw new TypeError("Connection lost after accepted finalize");
      }
      result = this.operation();
    } else if (url.pathname.endsWith("source/files")) {
      const path = url.searchParams.get("path");
      const commit = url.searchParams.get("commit_sha") ?? this.#commit;
      const files = url.searchParams.has("commit_sha")
        ? (this.#trees.get(commit) ?? this.uploaded)
        : this.uploaded;
      const entry = path === null ? undefined : files.get(path);
      result =
        path === null
          ? {
              commit_sha: commit,
              files: [...files.values()].map((file) => file.manifest),
            }
          : {
              commit_sha: commit,
              file: { ...entry?.manifest, content_base64: entry?.content_base64 },
            };
    } else if (url.pathname.endsWith("source/versions"))
      result = {
        versions: [
          {
            commit_sha: this.#commit,
            parent_commit_sha: null,
            message: "Current source",
            created_at: DATE,
          },
        ],
        next_commit_sha: null,
      };
    else if (url.pathname.endsWith("source/diff"))
      result = {
        from_commit_sha: url.searchParams.get("from_commit_sha"),
        to_commit_sha: url.searchParams.get("to_commit_sha"),
        changes: [],
      };
    else if (url.pathname.endsWith("source:restore") || url.pathname.endsWith("source/changes"))
      result = this.operation();
    else if (url.pathname.endsWith("/source")) {
      if (this.sourceUnavailable) throw new TypeError("Source read is unavailable");
      result = this.source;
      if (
        this.source?.provider === "github" &&
        (url.searchParams.get("include_binding") !== "true" || this.ignoreBindingQuery)
      ) {
        const { source_connection_id, source_generation, ...legacy } = this.source;
        void source_connection_id;
        void source_generation;
        result = legacy;
      }
    } else throw new Error("Unexpected managed-source fixture request");
    return Response.json(result);
  };

  #bind(generation: number): void {
    this.source = {
      provider: "managed",
      source_connection_id: CONNECTION,
      source_generation: generation,
      namespace: "namespace",
      repository_name: "repository",
      branch: "main",
      current_commit_sha: this.#commit,
      status: "ready",
      linked_at: DATE,
      updated_at: DATE,
    };
  }
}

function cli(
  control: SourceControl,
  root: string,
  linkedSourceProvider?: "managed" | "github",
): ProductCli {
  const api = new GeneratedSdkProductApi(
    "https://control.example.test",
    "private-user-token",
    control.fetch,
  );
  return new ProductCli({
    apiToken: "private-user-token",
    commandPrefix: "ohmyhost",
    sourceDirectory: root,
    sourceWorkspace: () => inspectSourceWorkspace(root),
    linkedSourceProvider,
    deviceFlow: {} as WorkosDeviceFlowClient,
    deviceAuthorizationPresenter: { present: async () => undefined },
    productApi: () => api,
    accountProfile: async () => {
      throw new Error("Not used");
    },
    projectLinkStore: new OwnerOnlyProjectLinkStore(join(root, ".ohmyhost"), root),
    productApiOrigin: "https://control.example.test",
    tokenRefresher: {
      refresh: async () => {
        throw new Error("Not used");
      },
    },
    tokenRevoker: { revoke: async () => undefined },
    now: () => new Date(DATE),
    waitUntil: async () => undefined,
    lifecycleTimeoutMs: 1000,
    createCorrelationId: () => "source-test",
    diagnosticSink: { record: () => undefined },
    readSecretValue: async () => {
      throw new Error("Not used");
    },
  });
}

async function mcpCall(
  handler: { fetch(request: Request): Promise<Response> },
  name: string,
  args: Record<string, unknown>,
) {
  const response = await handler.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  const text = await response.text();
  const serialized = response.headers.get("content-type")?.startsWith("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
    : text;
  return JSON.parse(serialized ?? "null") as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
}

describe("managed source consumers", () => {
  it("recovers an accepted snapshot after a lost response without another commit or any credential upload", async () => {
    const root = await directory();
    const control = new SourceControl();
    const source = new GeneratedSdkProductApi(
      "https://control.example.test",
      "private-user-token",
      control.fetch,
    ).managedSource;
    const input = {
      api: source,
      projectId: PROJECT,
      request: {
        mode: "initialize" as const,
        expected_source_generation: 0,
        expected_source_connection_id: null,
        expected_commit_sha: null,
        message: "Current working files",
      },
      snapshot: await createSourceSnapshot({ directory: root }),
      idempotencyKey: "stable-attempt",
      signal: new AbortController().signal,
    };
    const prepared = await prepareLocalSourcePublication({
      directory: root,
      apiOrigin: "https://control.example.test",
      identity: {
        actor_id: "user:user_test",
        email: "owner@example.test",
        organization_ids: [ORGANIZATION],
        organizations: [{ id: ORGANIZATION, name: "Owner" }],
      },
      projectId: PROJECT,
      request: input.request,
      explicitExpectedCommit: false,
      snapshotSha256: input.snapshot.sha256,
      idempotencyKey: input.idempotencyKey,
    });
    control.loseFinalize = true;
    await expect(publishSourceSnapshot({ ...input, rejected: prepared.rejected })).rejects.toThrow(
      "Connection lost",
    );
    const recovered = await publishSourceSnapshot({ ...input, rejected: prepared.rejected });
    expect(recovered.receipt).toMatchObject({ state: "committed", commit_sha: "b".repeat(40) });
    expect(control.calls.filter((call) => call.path.endsWith(":commit"))).toHaveLength(1);
    expect(control.calls.filter((call) => call.method === "PUT")).toHaveLength(2);
    const pending = await inspectLocalSourcePublications(root);
    expect(pending).toMatchObject([{ project_id: PROJECT, operation_id: null }]);
    const rejectedCreation = {
      type: "https://ohmyho.st/problems/source-generation-conflict",
      title: "Source binding changed",
      status: 409,
      code: "source_generation_conflict",
      request_id: "observed-source-conflict",
      retryable: false,
      suggested_action: "Read and merge the source.",
    };
    for (const uncertain of [
      new TypeError("Uncertain request"),
      { ...rejectedCreation, status: 401, code: "unauthenticated" },
      { ...rejectedCreation, status: 503, code: "project_handle_unavailable" },
    ])
      await prepared.rejected(uncertain);
    expect(await inspectLocalSourcePublications(root)).toEqual(pending);
    await prepared.accepted(control.operation());
    await prepared.rejected(rejectedCreation);
    expect(await inspectLocalSourcePublications(root)).toMatchObject([{ operation_id: OPERATION }]);
    await expect(
      completeLocalSourcePublication({
        directory: root,
        apiOrigin: "https://control.example.test",
        identity: {
          actor_id: "user:other_owner",
          email: "other@example.test",
          organization_ids: [ORGANIZATION],
          organizations: [{ id: ORGANIZATION, name: "Owner" }],
        },
        projectId: PROJECT,
        api: source,
        getOperation: async () => control.operation(),
      }),
    ).rejects.toMatchObject({ code: "source_publication_scope_mismatch" });
    const completed = await completeLocalSourcePublication({
      directory: root,
      apiOrigin: "https://control.example.test",
      identity: {
        actor_id: "user:user_test",
        email: "owner@example.test",
        organization_ids: [ORGANIZATION],
        organizations: [{ id: ORGANIZATION, name: "Owner" }],
      },
      projectId: PROJECT,
      api: source,
      getOperation: async () => control.operation(),
    });
    expect(completed.status).toBe("completed");
    expect(await inspectLocalSourcePublications(root)).toEqual([]);
    expect(control.calls.every((call) => call.authorization === "Bearer private-user-token")).toBe(
      true,
    );
    expect(JSON.stringify(control.calls.map((call) => call.body))).not.toContain("private-value");
    control.state = "sealed";
    expect((await publishSourceSnapshot(input)).receipt.state).toBe("sealed");
    expect(control.calls.filter((call) => call.path.endsWith(":commit"))).toHaveLength(1);
    control.state = "staging";
    control.source = GITHUB_SOURCE;
    const switched = await publishSourceSnapshot({
      ...input,
      idempotencyKey: "switch-existing",
      request: {
        ...input.request,
        mode: "switch",
        expected_source_generation: 1,
        expected_source_connection_id: CONNECTION,
      },
    });
    expect(switched.receipt.state).toBe("committed");
    await source.changes({
      projectId: PROJECT,
      idempotencyKey: "change-one",
      body: {
        expected_source_generation: 2,
        expected_commit_sha: "b".repeat(40),
        message: "Atomic edit",
        changes: [
          {
            path: "main.ts",
            content_base64: Buffer.from("edit").toString("base64"),
            executable: false,
          },
        ],
      },
    });
    expect(control.calls.find((call) => call.path.endsWith("/source/changes"))?.body).toMatchObject(
      { expected_source_generation: 2, changes: [{ path: "main.ts", executable: false }] },
    );
    await prepareLocalSourcePublication({
      directory: root,
      apiOrigin: "https://control.example.test",
      identity: {
        actor_id: "user:user_test",
        email: "owner@example.test",
        organization_ids: [ORGANIZATION],
        organizations: [{ id: ORGANIZATION, name: "Owner" }],
      },
      projectId: PROJECT,
      request: {
        ...input.request,
        mode: "commit",
        expected_source_generation: 2,
        expected_source_connection_id: CONNECTION,
        expected_commit_sha: "b".repeat(40),
      },
      explicitExpectedCommit: true,
      snapshotSha256: input.snapshot.sha256,
      idempotencyKey: "another-attempt",
    });
    await prepared.rejected(rejectedCreation);
    expect(await inspectLocalSourcePublications(root)).toMatchObject([
      { operation_id: null, mode: "commit", source_generation: 2 },
    ]);
  });

  it("uses managed source commands through the real SDK, keeps one project binding and avoids mandatory GitHub onboarding", async () => {
    for (const invalidPath of ["caf\u00e9.ts", `nested/${"a".repeat(238)}.ts`]) {
      const invalidRoot = await directory();
      await fs.mkdir(join(invalidRoot, "nested"), { recursive: true });
      await fs.writeFile(join(invalidRoot, invalidPath), "invalid path\n");
      const invalidControl = new SourceControl();
      const invalidClient = cli(invalidControl, invalidRoot);
      const args = [
        "source",
        "publish",
        "--project",
        PROJECT,
        "--mode",
        "initialize",
        "--expected-source-generation",
        "0",
        "--message",
        "Files",
        "--idempotency-key",
        "invalid-path",
        "--wait",
        "--json",
      ];
      const rejected = await invalidClient.run(args);
      expect.soft(JSON.parse(rejected.stdout).error.code).toBe("source_path_invalid");
      expect.soft(await inspectLocalSourcePublications(invalidRoot)).toEqual([]);
      expect(invalidControl.calls.filter((call) => call.method !== "GET")).toEqual([]);
      await fs.rename(join(invalidRoot, invalidPath), join(invalidRoot, "valid.ts"));
      const corrected = await invalidClient.run(
        args.map((value) => (value === "invalid-path" ? "corrected-path" : value)),
      );
      expect.soft(corrected.exitCode, corrected.stdout).toBe(0);
    }
    const invalidKeyRoot = await directory();
    const invalidKeyControl = new SourceControl();
    const invalidKeyClient = cli(invalidKeyControl, invalidKeyRoot);
    const invalidKeyArgs = [
      "source",
      "publish",
      "--project",
      PROJECT,
      "--mode",
      "initialize",
      "--expected-source-generation",
      "0",
      "--message",
      "Files",
      "--idempotency-key",
      "a".repeat(129),
      "--json",
    ];
    const rejectedKey = await invalidKeyClient.run(invalidKeyArgs);
    expect.soft(JSON.parse(rejectedKey.stdout).error.code).toBe("invalid_command");
    expect.soft(await fs.readdir(invalidKeyRoot)).not.toContain(".ohmyhost");
    expect(invalidKeyControl.calls.filter((call) => call.method !== "GET")).toEqual([]);
    for (const input of [
      { snapshotSha256: "sha256:" + "a".repeat(64), idempotencyKey: "a".repeat(129) },
      { snapshotSha256: "invalid", idempotencyKey: "invalid-digest" },
    ]) {
      await expect(
        prepareLocalSourcePublication({
          directory: invalidKeyRoot,
          apiOrigin: "https://control.example.test",
          identity: {
            actor_id: "user:user_test",
            email: "owner@example.test",
            organization_ids: [ORGANIZATION],
            organizations: [{ id: ORGANIZATION, name: "Owner" }],
          },
          projectId: PROJECT,
          request: {
            mode: "initialize",
            expected_source_generation: 0,
            expected_source_connection_id: null,
            expected_commit_sha: null,
            message: "Files",
          },
          explicitExpectedCommit: false,
          ...input,
        }),
      ).rejects.toMatchObject({ code: "source_publication_input_invalid" });
    }
    expect(await fs.readdir(invalidKeyRoot)).not.toContain(".ohmyhost");
    const root = await directory();
    const control = new SourceControl();
    const client = cli(control, root);
    const identity = await client.run(["whoami", "--json"]);
    expect(JSON.parse(identity.stdout).next_action).toContain("Ask once");
    expect(control.calls.some((call) => call.path.includes("github"))).toBe(false);
    const published = await client.run([
      "source",
      "publish",
      "--project",
      PROJECT,
      "--mode",
      "initialize",
      "--directory",
      root,
      "--expected-source-generation",
      "0",
      "--message",
      "Current files",
      "--idempotency-key",
      "one-save",
      "--wait",
      "--json",
    ]);
    expect(published.exitCode).toBe(0);
    expect(JSON.parse(published.stdout)).toMatchObject({
      status: "completed",
      receipt: { commit_sha: "b".repeat(40) },
      snapshot: { files: 2 },
    });
    const links = await readProjectLinks(join(root, ".ohmyhost"), "https://control.example.test");
    expect(links.links).toMatchObject([
      { version: 3, project_id: PROJECT, source: { provider: "managed", source_generation: 1 } },
    ]);
    expect(JSON.stringify(links)).not.toContain("current_commit_sha");
    expect(links.links).toMatchObject([{ source: { last_confirmed_commit_sha: "b".repeat(40) } }]);
    expect(
      JSON.parse((await cli(control, root, "managed").run(["whoami", "--json"])).stdout)
        .next_action,
    ).toBeUndefined();
    for (const args of [
      ["status"],
      ["files", "--commit", "b".repeat(40)],
      ["file", "--path", "main.ts"],
      ["versions", "--limit", "10", "--before", "a".repeat(40)],
      ["diff", "--from", "a".repeat(40), "--to", "b".repeat(40)],
      ["upload", "--operation", OPERATION],
      [
        "restore",
        "--expected-source-generation",
        "1",
        "--expected-commit",
        "b".repeat(40),
        "--restore-commit",
        "a".repeat(40),
        "--message",
        "Restore version",
        "--idempotency-key",
        "restore-one",
        "--wait",
      ],
      [
        "initialize",
        "--expected-source-generation",
        "0",
        "--template",
        "empty",
        "--idempotency-key",
        "initialize-one",
        "--wait",
      ],
    ])
      expect((await client.run(["source", ...args, "--project", PROJECT, "--json"])).exitCode).toBe(
        0,
      );
    expect((await client.run(["source", "inspect", "--directory", root, "--json"])).exitCode).toBe(
      0,
    );
    for (const args of [
      ["file", "--path", "../escape"],
      ["files", "--path", "main.ts"],
      ["versions", "--limit", "101"],
      ["diff", "--from", "bad", "--to", "b".repeat(40)],
    ])
      expect(() => parseProductCliCommand(["source", ...args, "--project", PROJECT])).toThrow();
    const output: string[] = [];
    expect(
      await runProductionCli(
        ["source", "inspect", "--json"],
        {},
        { writeStdout: (value) => output.push(value), writeStderr: () => undefined },
        new AbortController().signal,
        { workingDirectory: root },
      ),
    ).toBe(0);
    expect(JSON.parse(output.join("")).workspace.git).toBeNull();
    const bounded = createBoundedFetch(control.fetch, new AbortController().signal, 1000, 1024);
    const large = Buffer.alloc(2 * 1024 * 1024);
    control.uploaded.set("large.ts", {
      manifest: {
        path: "large.ts",
        sha256: `sha256:${createHash("sha256").update(large).digest("hex")}`,
        byte_length: large.byteLength,
        executable: false,
      },
      content_base64: large.toString("base64"),
    });
    const largeResponse = await bounded(
      `https://control.example.test/v1/projects/${PROJECT}/source/files?path=large.ts`,
    );
    expect((await largeResponse.text()).length).toBeGreaterThan(2 * 1024 * 1024);
    control.uploaded.delete("large.ts");
    control.advanceHead();
    const stale = await client.run([
      "source",
      "publish",
      "--project",
      PROJECT,
      "--mode",
      "commit",
      "--expected-source-generation",
      "1",
      "--expected-source-connection",
      CONNECTION,
      "--message",
      "Local edit",
      "--idempotency-key",
      "stale-source",
      "--wait",
      "--json",
    ]);
    expect(stale.exitCode).not.toBe(0);
    expect(JSON.parse(stale.stdout).error.code).toBe("source_commit_conflict");
    expect(
      control.calls.filter((call) => call.path.endsWith("source/uploads")).at(-1)?.body[
        "expected_commit_sha"
      ],
    ).toBe("b".repeat(40));
    expect(
      (await readProjectLinks(join(root, ".ohmyhost"), "https://control.example.test")).links,
    ).toMatchObject([{ source: { last_confirmed_commit_sha: "b".repeat(40) } }]);
    const failed = await client.run([
      "source",
      "publish",
      "complete",
      "--project",
      PROJECT,
      "--directory",
      root,
      "--operation",
      OPERATION,
      "--json",
    ]);
    expect(JSON.parse(failed.stdout).error.code).toBe("source_publication_failed");
    await fs.writeFile(join(root, "main.ts"), "other chat edit + merged local edit\n");
    control.operationState = "succeeded";
    const merged = await client.run([
      "source",
      "publish",
      "--project",
      PROJECT,
      "--mode",
      "commit",
      "--expected-source-generation",
      "1",
      "--expected-source-connection",
      CONNECTION,
      "--expected-commit",
      "c".repeat(40),
      "--message",
      "Merged edits",
      "--idempotency-key",
      "merged-source",
      "--wait",
      "--json",
    ]);
    expect(merged.exitCode).toBe(0);
    const mergedCommit = control.receipt().commit_sha;
    const replayArgs = [
      "source",
      "publish",
      "--project",
      PROJECT,
      "--mode",
      "commit",
      "--expected-source-generation",
      "1",
      "--expected-source-connection",
      CONNECTION,
      "--message",
      "Merged edits",
      "--idempotency-key",
      "merged-source",
      "--wait",
      "--json",
    ];
    const publicationDirectory = join(root, ".ohmyhost", "publications");
    // Persisted state after the binding was saved, but before the pending record was removed.
    await fs.copyFile(
      join(publicationDirectory, `completed-${ORGANIZATION}-${PROJECT}.json`),
      join(publicationDirectory, `${ORGANIZATION}-${PROJECT}.json`),
    );
    const commitsBeforeReplay = control.calls.filter((call) =>
      call.path.endsWith(":commit"),
    ).length;
    expect((await client.run(replayArgs)).exitCode).toBe(0);
    expect((await client.run(replayArgs)).exitCode).toBe(0);
    expect(control.calls.filter((call) => call.path.endsWith(":commit"))).toHaveLength(
      commitsBeforeReplay,
    );
    expect(
      control.calls.filter((call) => call.path.endsWith("source/uploads")).at(-1)?.body[
        "expected_commit_sha"
      ],
    ).toBe("c".repeat(40));
    expect(await inspectLocalSourcePublications(root)).toEqual([]);
    const callsBeforeRejectedReplay = control.calls.filter((call) => call.method !== "GET").length;
    const differentParent = [...replayArgs, "--expected-commit", "d".repeat(40)];
    expect(JSON.parse((await client.run(differentParent)).stdout).error.code).toBe(
      "source_publication_pending",
    );
    for (const differentAttempt of [
      replayArgs.map((value) => (value === "Merged edits" ? "Another message" : value)),
      replayArgs.map((value) => (value === "commit" ? "switch" : value)),
    ])
      expect(JSON.parse((await client.run(differentAttempt)).stdout).error.code).toBe(
        "source_publication_pending",
      );
    await fs.writeFile(join(root, "main.ts"), "changed after completion\n");
    expect(JSON.parse((await client.run(replayArgs)).stdout).error.code).toBe(
      "source_publication_pending",
    );
    expect(control.calls.filter((call) => call.method !== "GET")).toHaveLength(
      callsBeforeRejectedReplay,
    );
    expect(await inspectLocalSourcePublications(root)).toEqual([]);
    const nextArgs = replayArgs.map((value) => (value === "merged-source" ? "next-source" : value));
    expect((await client.run(nextArgs)).exitCode).toBe(0);
    expect(
      control.calls.filter((call) => call.path.endsWith("source/uploads")).at(-1)?.body[
        "expected_commit_sha"
      ],
    ).toBe(mergedCommit);
    const bindingBeforeSwitch = await readProjectLinks(
      join(root, ".ohmyhost"),
      "https://control.example.test",
    );
    if (control.source?.provider !== "managed") throw new Error("Expected managed source");
    const sourceBeforeSwitch = control.source;
    control.source = {
      ...control.source,
      source_connection_id: "01K2F3G4H5J6K7M8N9P0QRSTVZ",
      source_generation: 2,
    };
    const switchedCompletion = await client.run([
      "source",
      "publish",
      "complete",
      "--project",
      PROJECT,
      "--json",
    ]);
    expect(JSON.parse(switchedCompletion.stdout).error.code).toBe(
      "source_publication_scope_mismatch",
    );
    expect(await readProjectLinks(join(root, ".ohmyhost"), "https://control.example.test")).toEqual(
      bindingBeforeSwitch,
    );
    control.source = sourceBeforeSwitch;
    control.rejectStaleUpload = true;
    control.advanceHead();
    for (const code of ["source_generation_conflict", "source_commit_conflict"] as const) {
      control.staleUploadConflict = code;
      const admissionConflict = await client.run(
        nextArgs.map((value) => (value === "next-source" ? `admission-${code}` : value)),
      );
      expect(JSON.parse(admissionConflict.stdout).error.code).toBe(code);
      expect.soft(await inspectLocalSourcePublications(root)).toEqual([]);
    }
    const remoteFile = JSON.parse(
      (
        await client.run([
          "source",
          "file",
          "--project",
          PROJECT,
          "--path",
          "main.ts",
          "--commit",
          "c".repeat(40),
          "--json",
        ])
      ).stdout,
    ).source.file;
    await fs.writeFile(
      join(root, "main.ts"),
      Buffer.from(remoteFile.content_base64, "base64").toString("utf8") + "merged local edit\n",
    );
    const admissionMergedArgs = [
      ...nextArgs.map((value) => (value === "next-source" ? "admission-merged" : value)),
      "--expected-commit",
      "c".repeat(40),
    ];
    const admittedMerge = await client.run(admissionMergedArgs);
    expect.soft(admittedMerge.exitCode, admittedMerge.stdout).toBe(0);
    const reusedKey = await client.run(nextArgs);
    expect.soft(JSON.parse(reusedKey.stdout).error.code).toBe("idempotency_key_reused");
    expect.soft(await inspectLocalSourcePublications(root)).toEqual([]);
    const afterReusedKey = await client.run(
      nextArgs.map((value) => (value === "next-source" ? "after-key-conflict" : value)),
    );
    expect.soft(afterReusedKey.exitCode, afterReusedKey.stdout).toBe(0);

    const productionRoot = await directory();
    const otherDirectory = await directory();
    const otherOrganization = "00000000000000000000000002";
    await new OwnerOnlyProjectLinkStore(join(otherDirectory, ".ohmyhost", "production")).save({
      version: 3,
      api_origin: "https://app.ohmyho.st",
      organization_id: otherOrganization,
      project_id: PROJECT,
      source: {
        provider: "github",
        source_connection_id: CONNECTION,
        source_generation: 1,
        installation_id: "42",
        repository_full_name: "other/repository",
      },
    });
    const profiles = await memoryProfiles([
      {
        profile: login("owner", "user_test", ORGANIZATION),
        credential: {
          accessToken: "saved-owner-token",
          refreshToken: "saved-owner-refresh",
          expiresAt: "2099-01-01T00:00:00.000Z",
          organizationId: ORGANIZATION,
        },
      },
      {
        profile: login("other", "user_other", otherOrganization),
        credential: {
          accessToken: "saved-other-token",
          refreshToken: "saved-other-refresh",
          expiresAt: "2099-01-01T00:00:00.000Z",
          organizationId: otherOrganization,
        },
      },
    ]);
    roots.push(profiles.directory);
    const productionControl = new SourceControl();
    vi.stubGlobal("fetch", productionControl.fetch);
    const runProduction = async (
      args: string[],
      platform = "production",
      cwd = productionRoot,
      interactive = false,
    ) => {
      const output: string[] = [];
      const exitCode = await runProductionCli(
        [...args, "--json"],
        {
          OHMYHOST_ENVIRONMENT: platform,
          ...(interactive ? {} : { OHMYHOST_TOKEN: `sk_${"b".repeat(46)}` }),
        },
        { writeStdout: (value) => output.push(value), writeStderr: () => undefined },
        new AbortController().signal,
        { workingDirectory: cwd, profiles: profiles.registry },
      );
      return { exitCode, document: JSON.parse(output.join("")) };
    };
    const productionPublish = await runProduction([
      "source",
      "publish",
      "--project",
      PROJECT,
      "--mode",
      "initialize",
      "--expected-source-generation",
      "0",
      "--message",
      "Production files",
      "--idempotency-key",
      "production-source",
      "--wait",
    ]);
    expect(productionPublish.exitCode, JSON.stringify(productionPublish.document)).toBe(0);
    expect(
      (
        await readProjectLinks(
          join(productionRoot, ".ohmyhost", "production"),
          "https://app.ohmyho.st",
        )
      ).links,
    ).toMatchObject([{ project_id: PROJECT, source: { provider: "managed" } }]);
    expect(
      (await readProjectLinks(join(productionRoot, ".ohmyhost"), "https://dev.app.ohmyho.st"))
        .links,
    ).toEqual([]);
    expect((await runProduction(["source", "status"])).exitCode).toBe(0);
    expect((await runProduction(["whoami"])).document.next_action).toBeUndefined();
    expect((await runProduction(["source", "status"], "development")).exitCode).toBe(2);
    const fromSelectedDirectory = await runProduction(
      ["source", "publish", "complete", "--directory", productionRoot],
      "production",
      otherDirectory,
      true,
    );
    expect(fromSelectedDirectory.exitCode, JSON.stringify(fromSelectedDirectory.document)).toBe(0);
    expect(productionControl.calls.at(-1)?.authorization).toBe("Bearer saved-owner-token");
    const callsBeforeWrongProfile = productionControl.calls.length;
    const wrongProfile = await runProduction(
      [
        "source",
        "publish",
        "complete",
        "--directory",
        productionRoot,
        "--project",
        PROJECT,
        "--profile-name",
        "other",
      ],
      "production",
      otherDirectory,
      true,
    );
    expect(wrongProfile.exitCode).not.toBe(0);
    expect(productionControl.calls).toHaveLength(callsBeforeWrongProfile);
    expect(profiles.writes).toEqual([]);
    await new OwnerOnlyProjectLinkStore(join(productionRoot, ".ohmyhost", "production")).save({
      version: 3,
      api_origin: "https://app.ohmyho.st",
      organization_id: ORGANIZATION,
      project_id: PROJECT,
      source: {
        provider: "github",
        source_connection_id: CONNECTION,
        source_generation: 1,
        installation_id: "42",
        repository_full_name: "owner/repository",
      },
    });
    await fs.mkdir(join(productionRoot, ".git"));
    await fs.writeFile(join(productionRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
    await fs.writeFile(
      join(productionRoot, ".git", "config"),
      '[remote "origin"]\nurl=https://github.com/owner/repository.git\n',
    );
    const githubCallsBeforeGuidance = productionControl.calls.filter((call) =>
      call.path.endsWith("/github"),
    ).length;
    const switchedGuidance = await runProduction(["whoami"]);
    expect(switchedGuidance.exitCode).toBe(0);
    expect(switchedGuidance.document.next_action).toBeUndefined();
    expect(productionControl.calls.filter((call) => call.path.endsWith("/github"))).toHaveLength(
      githubCallsBeforeGuidance,
    );
    const managedBinding = productionControl.source;
    const githubBinding = {
      provider: "github" as const,
      source_connection_id: CONNECTION,
      source_generation: 1,
      installation_id: "42",
      repository_full_name: "owner/repository",
      status: "ready" as const,
      linked_at: DATE,
      updated_at: DATE,
    };
    productionControl.source = githubBinding;
    expect((await runProduction(["whoami"])).document.next_action).toContain("github connect");
    productionControl.sourceUnavailable = true;
    const unavailableGuidance = await runProduction(["whoami"]);
    expect(unavailableGuidance.exitCode).toBe(0);
    expect(unavailableGuidance.document.next_action).toBeUndefined();
    productionControl.sourceUnavailable = false;
    productionControl.source = managedBinding;
    const token = [
      Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
      Buffer.from(
        JSON.stringify({ sub: "user_test", exp: Date.parse("2099-01-01T00:00:00.000Z") / 1000 }),
      ).toString("base64url"),
      "c2ln",
    ].join(".");
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.host === "api.workos.com") {
        if (url.pathname === "/user_management/authorize/device")
          return Response.json({
            device_code: "source-login-device",
            user_code: "ABCD",
            verification_uri: resolveProductCliEnvironment().verificationUri,
            expires_in: 600,
            interval: 1,
          });
        if (url.pathname === "/user_management/authenticate")
          return Response.json({
            access_token: token,
            refresh_token: "source-login-refresh",
            token_type: "Bearer",
            organization_id: "org_managed",
          });
        throw new Error("Unexpected login fixture path");
      }
      return productionControl.fetch(request);
    });
    const loginGuidance = await runProduction(
      ["login", "--organization", ORGANIZATION, "--profile-name", "owner"],
      "production",
      productionRoot,
      true,
    );
    expect(loginGuidance.exitCode, JSON.stringify(loginGuidance.document)).toBe(0);
    expect(loginGuidance.document.next_action).toBeUndefined();
    expect(
      productionControl.calls
        .filter((call) => call.path === `/v1/projects/${PROJECT}/source?include_binding=true`)
        .at(-1)?.authorization,
    ).toBe(`Bearer ${token}`);
  });

  it("exposes actual local MCP source operations and preserves project identity on an explicit GitHub-to-managed switch", async () => {
    const root = await directory();
    const control = new SourceControl();
    const client = new GeneratedSdkLocalMcpClient(
      "https://control.example.test",
      "private-user-token",
      control.fetch,
    );
    const handler = createLocalOhmyhostMcpHandler({
      authenticatedClient: async () => client,
      environment: { OHMYHOST_ENVIRONMENT: "development" },
    });
    const identity = structuredClone(control.projectIdentity);
    const common = {
      project_id: PROJECT,
      expected_source_generation: 1,
      expected_commit_sha: "b".repeat(40),
      message: "Save source",
      idempotency_key: "source-call",
    };
    try {
      for (const args of [
        { project_id: PROJECT },
        { project_id: PROJECT, include_binding: true },
      ]) {
        const unbound = await mcpCall(handler, "source_get", args);
        expect(JSON.parse(unbound.result.content[0]?.text ?? "null")).toBeNull();
      }
      expect(
        (await mcpCall(handler, "source_inspect", { directory: root })).result.isError,
      ).not.toBe(true);
      expect(
        (
          await mcpCall(handler, "source_initialize", {
            project_id: PROJECT,
            expected_source_generation: 0,
            idempotency_key: "init",
          })
        ).result.isError,
      ).not.toBe(true);
      const initialized = await mcpCall(handler, "source_get", {
        project_id: PROJECT,
        include_binding: true,
      });
      expect(JSON.parse(initialized.result.content[0]?.text ?? "null")).toMatchObject({
        provider: "managed",
        source_connection_id: CONNECTION,
        source_generation: 1,
      });
      control.source = GITHUB_SOURCE;
      const { source_connection_id, source_generation, ...legacy } = GITHUB_SOURCE;
      void source_connection_id;
      void source_generation;
      for (const args of [
        { project_id: PROJECT },
        { project_id: PROJECT, include_binding: false },
      ]) {
        const read = await mcpCall(handler, "source_get", args);
        expect(JSON.parse(read.result.content[0]?.text ?? "null")).toEqual(legacy);
        expect(control.calls.at(-1)?.path).toBe(`/v1/projects/${PROJECT}/source`);
      }
      const binding = await mcpCall(handler, "source_get", {
        project_id: PROJECT,
        include_binding: true,
      });
      expect(JSON.parse(binding.result.content[0]?.text ?? "null")).toEqual(GITHUB_SOURCE);
      expect(control.calls.at(-1)?.path).toBe(
        `/v1/projects/${PROJECT}/source?include_binding=true`,
      );
      control.ignoreBindingQuery = true;
      const unsupported = await mcpCall(handler, "source_get", {
        project_id: PROJECT,
        include_binding: true,
      });
      expect(unsupported.result.isError).toBe(true);
      expect(JSON.parse(unsupported.result.content[0]?.text ?? "null").error.code).toBe(
        "response_contract_invalid",
      );
      control.ignoreBindingQuery = false;
      expect(
        (
          await mcpCall(handler, "source_publish", {
            ...common,
            expected_commit_sha: null,
            mode: "switch",
            expected_source_connection_id: CONNECTION,
            directory: root,
          })
        ).result.isError,
      ).not.toBe(true);
      expect(control.source).toMatchObject({ provider: "managed", source_generation: 2 });
      expect(control.projectIdentity).toEqual(identity);
      const localState = await mcpCall(handler, "source_inspect", { directory: root });
      expect(
        JSON.parse(localState.result.content[0]?.text ?? "null").pending_publications,
      ).toMatchObject([{ project_id: PROJECT, operation_id: OPERATION }]);
      expect(localState.result.content[0]?.text).not.toContain("idempotency_key");
      control.advanceHead();
      control.operationState = "queued";
      const waiting = await mcpCall(handler, "source_publish_complete", {
        project_id: PROJECT,
        directory: root,
        operation_id: OPERATION,
      });
      expect(JSON.parse(waiting.result.content[0]?.text ?? "null").status).toBe("pending");
      control.operationState = "succeeded";
      const finished = await mcpCall(handler, "source_publish_complete", {
        project_id: PROJECT,
        directory: root,
        operation_id: OPERATION,
      });
      expect(JSON.parse(finished.result.content[0]?.text ?? "null").status).toBe("completed");
      const replayed = await mcpCall(handler, "source_publish_complete", {
        project_id: PROJECT,
        directory: root,
        operation_id: OPERATION,
      });
      expect(JSON.parse(replayed.result.content[0]?.text ?? "null").status).toBe("completed");
      expect(
        (await readProjectLinks(join(root, ".ohmyhost"), "https://control.example.test")).links,
      ).toMatchObject([{ source: { last_confirmed_commit_sha: "b".repeat(40) } }]);
      expect(await inspectLocalSourcePublications(root)).toEqual([]);
      const managed = { ...common, expected_source_generation: 2 };
      for (const [name, args] of [
        ["source_files", { project_id: PROJECT }],
        ["source_file", { project_id: PROJECT, path: "main.ts" }],
        ["source_versions", { project_id: PROJECT }],
        [
          "source_diff",
          { project_id: PROJECT, from_commit_sha: "a".repeat(40), to_commit_sha: "b".repeat(40) },
        ],
        [
          "source_changes",
          {
            ...managed,
            changes: [
              {
                path: "main.ts",
                content_base64: Buffer.from("next version").toString("base64"),
                executable: false,
              },
            ],
          },
        ],
        ["source_restore", { ...managed, restore_commit_sha: "a".repeat(40) }],
        ["source_upload", { project_id: PROJECT, operation_id: OPERATION }],
      ] as const)
        expect((await mcpCall(handler, name, args)).result.isError).not.toBe(true);
      expect(
        (
          await mcpCall(handler, "source_file", {
            project_id: "01K2F3G4H5J6K7M8N9P0QRSTVZ",
            path: "main.ts",
          })
        ).result.isError,
      ).toBe(true);
      expect(
        (
          await mcpCall(handler, "source_changes", {
            ...common,
            changes: [{ path: ".env", content_base64: "", executable: false }],
          })
        ).result.isError,
      ).toBe(true);
      expect(
        control.calls.some(
          (call) =>
            call.path.includes("deployments") ||
            (call.path === "/v1/projects" && call.method === "POST"),
        ),
      ).toBe(false);
    } finally {
      await handler.close();
    }
  });
});
