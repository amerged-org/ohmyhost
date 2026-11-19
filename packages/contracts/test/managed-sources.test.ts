import { describe, expect, it } from "vitest";
import {
  assertGithubSourceResponse,
  assertManagedSourceResponse,
  isManagedSourcePath,
  MANAGED_SOURCE_LIMITS,
  parseManagedSourceRequest,
} from "../src/managed-sources.js";
import {
  formatMcpSourceFileResponse,
  McpSourceChangesInputError,
  normalizeMcpSourceChanges,
} from "../src/mcp-source-codec.js";

const id = "00000000000000000000000001";
const commit = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const file = { path: "src/main.ts", sha256: digest, byte_length: 1, executable: false };
const write = {
  expected_source_generation: 1,
  expected_commit_sha: commit,
  message: "Change application",
};

describe("managed source public contract", () => {
  it("accepts all credential-free mutation schemas and bounds hashes, paths, manifests and bytes", () => {
    const requests = {
      initialize: { template: "empty", expected_source_generation: 0 },
      upload: { ...write, mode: "commit", expected_source_connection_id: id },
      blob: { path: file.path, content_base64: "YQ==", sha256: digest, executable: true },
      finalize: { files: [file], expected_source_generation: 1 },
      switch: {
        files: [file],
        expected_source_generation: 1,
        upload_operation_id: id,
        expected_source_connection_id: id,
      },
      changes: {
        ...write,
        changes: [
          { path: file.path, content_base64: "YQ==", executable: false },
          { path: "old.ts", content_base64: null, executable: false },
        ],
      },
      restore: { ...write, restore_commit_sha: commit },
    };
    for (const [kind, request] of Object.entries(requests))
      expect(
        (parseManagedSourceRequest as (kind: string, value: unknown) => unknown)(kind, request),
      ).toEqual(request);
    expect(
      parseManagedSourceRequest("upload", {
        ...write,
        mode: "initialize",
        expected_source_connection_id: null,
        expected_commit_sha: null,
      }),
    ).toBeDefined();
    expect(
      parseManagedSourceRequest("upload", {
        ...write,
        mode: "switch",
        expected_source_connection_id: id,
        expected_commit_sha: null,
      }),
    ).toBeDefined();
    expect(
      parseManagedSourceRequest("finalize", { files: [], expected_source_generation: 0 }),
    ).toBeDefined();
    for (const path of [
      "../x",
      "/x",
      "a/./b",
      "a//b",
      "a/.GiT/config",
      "C:/x",
      "a\\b",
      "a\u0000b",
      "",
      "x".repeat(513),
      "ü.ts",
      "x".repeat(101),
      `${"a".repeat(156)}/x`,
      ".env",
      "src/.env.local",
      ".dev.vars.production",
      ".npmrc",
      ".ohmyhost/credentials.json",
      ".ssh/id_ed25519",
      "private.pem",
    ])
      expect(isManagedSourcePath(path)).toBe(false);
    expect(isManagedSourcePath("src/.config/name.ts")).toBe(true);
    expect(isManagedSourcePath(".env.example")).toBe(true);
    expect(isManagedSourcePath(`${"a".repeat(120)}/${"b".repeat(80)}`)).toBe(true);
    const invalid = [
      ["initialize", { ...requests.initialize, template: "other" }],
      ["initialize", { ...requests.initialize, expected_source_generation: -1 }],
      ["initialize", { ...requests.initialize, extra: true }],
      ["upload", { ...requests.upload, expected_source_connection_id: null }],
      ["upload", { ...requests.upload, mode: "initialize" }],
      ["upload", { ...requests.upload, mode: "unknown" }],
      ["restore", { ...requests.restore, restore_commit_sha: "A".repeat(40) }],
      ["changes", { ...requests.changes, message: " hi" }],
      ["changes", { ...requests.changes, changes: [] }],
      [
        "changes",
        {
          ...requests.changes,
          changes: [requests.changes.changes[0], requests.changes.changes[0]],
        },
      ],
      ["blob", { ...requests.blob, content_base64: "Y Q==" }],
      ["blob", { ...requests.blob, content_base64: "Yi==" }],
      ["blob", { ...requests.blob, content_base64: "YWJ=" }],
      ["blob", { ...requests.blob, executable: null }],
      ["finalize", { ...requests.finalize, files: [file, file] }],
      ["finalize", { ...requests.finalize, files: [{ ...file, byte_length: 2097153 }] }],
      ["switch", { ...requests.switch, upload_operation_id: "unknown" }],
      [
        "finalize",
        {
          ...requests.finalize,
          files: Array.from({ length: 5 }, (_, i) => ({
            ...file,
            path: `file${i}`,
            byte_length: 2097152,
          })),
        },
      ],
      ["changes", { ...requests.changes, changes: [0] }],
    ];
    for (const [kind, request] of invalid)
      expect(() =>
        (parseManagedSourceRequest as (kind: string, value: unknown) => unknown)(
          String(kind),
          request,
        ),
      ).toThrow(TypeError);
    expect(() => parseManagedSourceRequest("blob", null)).toThrow(TypeError);
  });

  it("rejects a manifest in which one path is a file and the folder of another path", () => {
    const folder = { ...file, path: "docs" };
    const nested = { ...file, path: "docs/readme.md" };
    expect(() =>
      assertManagedSourceResponse("files", { commit_sha: commit, files: [folder, nested] }),
    ).toThrow(TypeError);
    expect(() =>
      parseManagedSourceRequest("finalize", {
        expected_source_generation: 0,
        files: [nested, folder],
      }),
    ).toThrow(TypeError);
    // A sibling that only shares a leading string is a different path, not a folder of it.
    expect(() =>
      assertManagedSourceResponse("files", {
        commit_sha: commit,
        files: [folder, { ...file, path: "docs-notes/readme.md" }],
      }),
    ).not.toThrow();
  });

  it("validates every public response and distinguishes mode-only changes and exact records", () => {
    const github = {
      provider: "github",
      installation_id: "1",
      repository_full_name: "customer/application",
      status: "ready",
      linked_at: "2026-10-06T00:00:00.000Z",
      updated_at: "2026-10-06T00:00:00.000Z",
    };
    const githubBinding = { ...github, source_connection_id: id, source_generation: 1 };
    expect(() => assertGithubSourceResponse("legacy", github)).not.toThrow();
    expect(() =>
      assertGithubSourceResponse("legacy", { ...github, failure_summary: "Access revoked" }),
    ).not.toThrow();
    expect(() => assertGithubSourceResponse("binding", githubBinding)).not.toThrow();
    expect(() => assertGithubSourceResponse("legacy", githubBinding)).toThrow(TypeError);
    expect(() => assertGithubSourceResponse("binding", github)).toThrow(TypeError);
    for (const invalid of [
      null,
      { ...githubBinding, source_generation: 0 },
      { ...githubBinding, source_connection_id: "unknown" },
      { ...githubBinding, installation_id: "0" },
      { ...githubBinding, repository_full_name: "owner/repo/extra" },
      { ...githubBinding, linked_at: "unknown" },
      { ...githubBinding, status: "unknown" },
      { ...githubBinding, status: ["ready"] },
      { ...githubBinding, failure_summary: "" },
      { ...githubBinding, token: "private" },
    ])
      expect(() => assertGithubSourceResponse("binding", invalid)).toThrow(TypeError);
    const source = {
      provider: "managed",
      source_connection_id: id,
      source_generation: 1,
      namespace: "managed-us",
      repository_name: "application",
      branch: "main",
      current_commit_sha: commit,
      status: "ready",
      linked_at: "2026-10-06T00:00:00.000Z",
      updated_at: "2026-10-06T00:00:00.000Z",
    };
    const values = {
      source,
      files: { commit_sha: commit, files: [file] },
      versions: {
        versions: [
          {
            commit_sha: commit,
            parent_commit_sha: null,
            message: "Create",
            created_at: source.linked_at,
          },
        ],
        next_commit_sha: null,
      },
      diff: {
        from_commit_sha: commit,
        to_commit_sha: commit,
        changes: [
          {
            path: file.path,
            change: "modified",
            before_sha256: digest,
            after_sha256: digest,
            before_executable: false,
            after_executable: true,
          },
          {
            path: "new",
            change: "added",
            before_sha256: null,
            after_sha256: digest,
            before_executable: null,
            after_executable: false,
          },
          {
            path: "old",
            change: "deleted",
            before_sha256: digest,
            after_sha256: null,
            before_executable: false,
            after_executable: null,
          },
        ],
      },
      upload: {
        operation_id: id,
        state: "committed",
        expected_source_generation: 0,
        expected_commit_sha: null,
        commit_sha: commit,
        expires_at: source.linked_at,
      },
      blob: file,
    };
    expect(() =>
      assertManagedSourceResponse("source", {
        ...source,
        status: "failed",
        initialization_operation_id: id,
        initialization_error_code: "authorization_changed",
      }),
    ).not.toThrow();
    expect(() =>
      assertManagedSourceResponse("source", {
        ...source,
        status: "failed",
        initialization_error_code: "PROVIDER_SECRET_ERROR",
      }),
    ).toThrow(TypeError);
    expect(() =>
      assertManagedSourceResponse("source", { ...source, initialization_operation_id: id }),
    ).toThrow(TypeError);
    for (const [kind, value] of Object.entries(values))
      expect(() =>
        assertManagedSourceResponse(
          kind as Parameters<typeof assertManagedSourceResponse>[0],
          value,
        ),
      ).not.toThrow();
    expect(() =>
      assertManagedSourceResponse("files", {
        commit_sha: commit,
        file: { ...file, content_base64: "YQ==" },
      }),
    ).not.toThrow();
    expect(() =>
      assertManagedSourceResponse("source", { ...source, current_commit_sha: null }),
    ).not.toThrow();
    for (const [kind, value] of Object.entries(values))
      expect(() =>
        assertManagedSourceResponse(kind as Parameters<typeof assertManagedSourceResponse>[0], {
          ...value,
          token: "hidden",
        }),
      ).toThrow(TypeError);
    for (const invalid of [
      { ...source, provider: "github" },
      { ...source, namespace: "../org" },
      { ...source, status: "unknown" },
      { ...source, updated_at: "bad" },
    ])
      expect(() => assertManagedSourceResponse("source", invalid)).toThrow(TypeError);
    expect(() =>
      assertManagedSourceResponse("files", {
        commit_sha: commit,
        file: { ...file, content_base64: "" },
      }),
    ).toThrow(TypeError);
    expect(() =>
      assertManagedSourceResponse("versions", { ...values.versions, versions: null }),
    ).toThrow(TypeError);
    expect(() =>
      assertManagedSourceResponse("upload", { ...values.upload, commit_sha: null }),
    ).toThrow(TypeError);
    expect(() =>
      assertManagedSourceResponse("diff", {
        ...values.diff,
        changes: [{ ...values.diff.changes[0], after_executable: false }],
      }),
    ).toThrow(TypeError);
    expect(() =>
      assertManagedSourceResponse("diff", {
        ...values.diff,
        changes: [{ ...values.diff.changes[1], before_executable: false }],
      }),
    ).toThrow(TypeError);

    // MCP text convenience must preserve exact source bytes and never change REST schemas.
    const text = "\ufeffGrüße aus 東京 👋\n\texport default true;\r\n";
    const textBytes = new TextEncoder().encode(text);
    const textBase64 = btoa(String.fromCharCode(...textBytes));
    const textRequest = {
      ...write,
      changes: [{ path: file.path, content_text: text, executable: true }],
    };
    const normalized = normalizeMcpSourceChanges(textRequest);
    expect(normalized).toEqual({
      ...write,
      changes: [{ path: file.path, content_base64: textBase64, executable: true }],
    });
    expect(textRequest.changes[0]).toEqual({
      path: file.path,
      content_text: text,
      executable: true,
    });
    expect(() => parseManagedSourceRequest("changes", textRequest)).toThrow(TypeError);
    const textResponse = {
      commit_sha: commit,
      file: {
        ...file,
        content_base64: textBase64,
        byte_length: textBytes.byteLength,
        executable: true,
      },
    };
    const formattedText = formatMcpSourceFileResponse(textResponse);
    expect(formattedText).toEqual({
      commit_sha: commit,
      file: {
        ...file,
        byte_length: textBytes.byteLength,
        executable: true,
        content_text: text,
        encoding: "utf8",
      },
    });
    expect(formatMcpSourceFileResponse(textResponse, "base64")).toBe(textResponse);
    expect(() => assertManagedSourceResponse("files", formattedText)).toThrow(TypeError);
    expect(formatMcpSourceFileResponse(values.files)).toBe(values.files);

    const binaryResponse = {
      commit_sha: commit,
      file: { ...file, byte_length: 4, content_base64: "AP8AgA==", executable: true },
    };
    expect(formatMcpSourceFileResponse(binaryResponse)).toEqual({
      commit_sha: commit,
      file: {
        ...binaryResponse.file,
        encoding: "base64",
        guidance:
          "Binary file: preserve content_base64 and use content_base64 when writing this file.",
      },
    });
    for (const content_base64 of ["AA==", "AQ==", "Cw==", "DA==", "Dg==", "fw=="])
      expect(
        formatMcpSourceFileResponse({
          commit_sha: commit,
          file: { ...file, content_base64 },
        }),
      ).toEqual({
        commit_sha: commit,
        file: {
          ...file,
          content_base64,
          encoding: "base64",
          guidance:
            "Binary file: preserve content_base64 and use content_base64 when writing this file.",
        },
      });
    expect(
      normalizeMcpSourceChanges({
        ...write,
        changes: [
          { path: "binary.dat", content_base64: "AP8AgA==", executable: true },
          { path: "old.ts", content_base64: null, executable: false },
          { path: "empty.ts", content_text: "" },
        ],
      }),
    ).toEqual({
      ...write,
      changes: [
        { path: "binary.dat", content_base64: "AP8AgA==", executable: true },
        { path: "old.ts", content_base64: null, executable: false },
        { path: "empty.ts", content_base64: "", executable: false },
      ],
    });

    for (const change of [
      { path: file.path, content_text: text, content_base64: textBase64 },
      { path: file.path },
      { path: file.path, content_text: null },
      { path: file.path, content_text: undefined },
      { path: file.path, content_text: "\ud800" },
      { path: file.path, content_text: "\udc00" },
      { path: file.path, content_text: "ü".repeat(MANAGED_SOURCE_LIMITS.fileBytes / 2 + 1) },
      { path: file.path, content_text: "a".repeat(MANAGED_SOURCE_LIMITS.fileBytes + 1) },
      { path: file.path, content_base64: "Yi==" },
      { path: file.path, content_base64: "Y Q==" },
      { path: file.path, content_text: "", executable: undefined },
      { path: file.path, content_text: "", token: "hidden" },
      Object.assign(Object.create({ content_text: text }) as Record<string, unknown>, {
        path: file.path,
      }),
      null,
    ])
      expect(() => normalizeMcpSourceChanges({ ...write, changes: [change] })).toThrow(
        McpSourceChangesInputError,
      );
    for (const invalid of [
      null,
      { ...write, changes: null },
      { ...write, changes: [] },
      {
        ...write,
        changes: Array.from({ length: MANAGED_SOURCE_LIMITS.files + 1 }, (_, index) => ({
          path: `src/file-${index}.ts`,
          content_text: "",
        })),
      },
      {
        ...write,
        changes: ["a.ts", "b.ts"].map((path) => ({
          path,
          content_text: "a".repeat(MANAGED_SOURCE_LIMITS.uploadBytes / 2 + 1),
        })),
      },
      {
        ...write,
        changes: [
          { path: "a.ts", content_base64: "YQ==" },
          { path: "b.ts", content_text: "a".repeat(MANAGED_SOURCE_LIMITS.uploadBytes) },
        ],
      },
    ])
      expect(() => normalizeMcpSourceChanges(invalid)).toThrow(McpSourceChangesInputError);
    expect(new McpSourceChangesInputError()).toBeInstanceOf(TypeError);
    expect(() => normalizeMcpSourceChanges({ ...write, message: " hi", changes: [] })).toThrow(
      "MCP source changes are invalid",
    );
    expect(() => formatMcpSourceFileResponse({ ...textResponse, token: "hidden" })).toThrow(
      TypeError,
    );
    try {
      formatMcpSourceFileResponse({ ...textResponse, token: "hidden" });
    } catch (error) {
      expect(error).not.toBeInstanceOf(McpSourceChangesInputError);
    }
    expect(() => formatMcpSourceFileResponse(textResponse, "unknown" as "text")).toThrow(TypeError);
  });
});
