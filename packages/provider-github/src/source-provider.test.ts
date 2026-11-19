import { createHash } from "node:crypto";

import type {
  ExactSourceIdentity,
  ProviderMutationContext,
  SourceArchiveReceipt,
  SourceArchiveSink,
  SourceArchiveWriter,
} from "@ohmyhost/platform";
import { parseUlid } from "@ohmyhost/platform";
import { describe, expect, it, vi } from "vitest";

import {
  GithubProviderContractError,
  GithubProviderInputError,
  GithubProviderUncertainError,
} from "./errors.js";
import { createGitHubSourceArchiveProvider } from "./source-provider.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SOURCE: ExactSourceIdentity = Object.freeze({
  provider: "github",
  sourceConnectionId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAT"),
  externalRepositoryId: "987654",
  repository: Object.freeze({ owner: "acme", name: "widget" }),
  requestedCommitSha: SHA,
});
const CONTEXT: ProviderMutationContext = Object.freeze({
  operationId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
  projectId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
  environmentId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
  idempotencyKey: "github-source-fixture",
});
const IDENTITY = Object.freeze({ context: CONTEXT, source: SOURCE });
const ARCHIVE = new TextEncoder().encode("exact archive fixture");
const RECEIPT: SourceArchiveReceipt = Object.freeze({
  archiveId: "archive-fixture-123",
  identity: IDENTITY,
  archiveFormat: "tar.gz",
  byteLength: ARCHIVE.byteLength,
  sha256: createHash("sha256").update(ARCHIVE).digest("hex"),
});

function githubResponse(body: unknown, status = 201): Response {
  return Response.json(body, { status });
}

function commitShaResponse(sha = SHA): Response {
  return new Response(sha, {
    status: 200,
    headers: { "Content-Type": "application/vnd.github.sha" },
  });
}

function redirectResponse(query = ""): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: `https://codeload.github.com/acme/widget/legacy.tar.gz/${SHA}${query}` },
  });
}

function archiveResponse(bytes = ARCHIVE, contentLength = bytes.byteLength): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const midpoint = Math.ceil(bytes.byteLength / 2);
        controller.enqueue(bytes.slice(0, midpoint));
        controller.enqueue(bytes.slice(midpoint));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Length": String(contentLength) } },
  );
}

function chunkedArchiveResponse(bytes = ARCHIVE): Response {
  return new Response(bytes, { status: 200 });
}

function successfulFetch(
  finalResponse: Response = archiveResponse(),
): ReturnType<typeof vi.fn<typeof globalThis.fetch>> {
  return vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      githubResponse({
        token: "ghs_private_installation_token",
        expires_at: "2026-08-19T12:59:59.000Z",
        repository_selection: "selected",
        repositories: [{ id: 987_654 }],
        permissions: { contents: "read" },
      }),
    )
    .mockResolvedValueOnce(commitShaResponse())
    .mockResolvedValueOnce(redirectResponse())
    .mockResolvedValueOnce(finalResponse);
}

function dependencies(fetch = successfulFetch()) {
  return {
    repositoryGrantResolver: {
      resolve: vi.fn(async () => ({
        installationId: 123,
        repositoryId: 987_654,
        owner: "acme",
        repository: "widget",
      })),
    },
    appJwtIssuer: { issue: vi.fn(async () => "app.jwt.signature") },
    fetch,
    clock: { now: () => new Date("2026-08-19T12:00:00.000Z") },
    userAgent: "ohmyhost-test",
    requestTimeoutMs: 1_000,
  };
}

function sink(observed: SourceArchiveReceipt | null = null) {
  const writes: Uint8Array[] = [];
  const writer: SourceArchiveWriter = {
    write: vi.fn(async (chunk) => {
      writes.push(chunk.slice());
    }),
    commit: vi.fn(async (metadata) => ({ ...RECEIPT, ...metadata })),
    abort: vi.fn(async () => undefined),
  };
  const value: SourceArchiveSink = {
    observe: vi.fn(async () => observed),
    begin: vi.fn(async () => writer),
  };
  return { value, writer, writes };
}

function acquireInput(overrides: Record<string, unknown> = {}) {
  return {
    identity: IDENTITY,
    maxBytes: 1_024,
    deadline: new Date("2026-08-19T12:00:10.000Z"),
    ...overrides,
  };
}

describe("GitHub SourceArchiveProvider", () => {
  it("replays an observed exact receipt before resolving grants or making GitHub calls", async () => {
    const deps = dependencies();
    const target = sink(RECEIPT);
    const provider = createGitHubSourceArchiveProvider(deps);

    await expect(provider.acquireExact(acquireInput(), target.value)).resolves.toBe(RECEIPT);
    expect(target.value.observe).toHaveBeenCalledWith(IDENTITY);
    expect(deps.repositoryGrantResolver.resolve).not.toHaveBeenCalled();
    expect(deps.appJwtIssuer.issue).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(target.value.begin).not.toHaveBeenCalled();
  });

  it("rejects an observed receipt from a different operation without provider work", async () => {
    const deps = dependencies();
    const foreignIdentity = {
      context: { ...CONTEXT, operationId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAY") },
      source: SOURCE,
    };
    const target = sink({ ...RECEIPT, identity: foreignIdentity });
    const provider = createGitHubSourceArchiveProvider(deps);

    await expect(provider.acquireExact(acquireInput(), target.value)).rejects.toBeInstanceOf(
      GithubProviderContractError,
    );
    expect(deps.repositoryGrantResolver.resolve).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("uses a scoped installation token internally and streams the exact archive into the sink", async () => {
    const deps = dependencies();
    const target = sink();
    const provider = createGitHubSourceArchiveProvider(deps);

    await expect(provider.acquireExact(acquireInput(), target.value)).resolves.toEqual(RECEIPT);
    expect(deps.repositoryGrantResolver.resolve).toHaveBeenCalledWith({
      context: CONTEXT,
      source: SOURCE,
      deadline: new Date("2026-08-19T12:00:10.000Z"),
    });
    expect(target.value.begin).toHaveBeenCalledWith(IDENTITY);
    expect(Buffer.concat(target.writes.map((chunk) => Buffer.from(chunk)))).toEqual(
      Buffer.from(ARCHIVE),
    );
    expect(target.writer.commit).toHaveBeenCalledWith({
      archiveFormat: "tar.gz",
      byteLength: ARCHIVE.byteLength,
      sha256: RECEIPT.sha256,
    });
    expect(target.writer.abort).not.toHaveBeenCalled();
    expect(new Headers(deps.fetch.mock.calls[1]?.[1]?.headers).get("accept")).toBe(
      "application/vnd.github.sha",
    );
    expect(
      JSON.stringify(await provider.acquireExact(acquireInput(), sink(RECEIPT).value)),
    ).not.toContain("ghs_private_installation_token");
  });

  it("accepts GitHub's temporary private-repository archive token on the exact codeload path", async () => {
    const fetch = successfulFetch();
    fetch.mockReset();
    fetch
      .mockResolvedValueOnce(
        githubResponse({
          token: "opaque",
          expires_at: "2026-08-19T12:59:59.000Z",
          repository_selection: "selected",
          repositories: [{ id: 987_654 }],
          permissions: { contents: "read" },
        }),
      )
      .mockResolvedValueOnce(commitShaResponse())
      .mockResolvedValueOnce(redirectResponse(`?token=${"a".repeat(148)}`))
      .mockResolvedValueOnce(archiveResponse());

    await expect(
      createGitHubSourceArchiveProvider(dependencies(fetch)).acquireExact(
        acquireInput(),
        sink().value,
      ),
    ).resolves.toEqual(RECEIPT);
  });

  it("accepts a chunked archive without Content-Length while enforcing the stream cap", async () => {
    const fetch = successfulFetch(chunkedArchiveResponse());
    const target = sink();
    const provider = createGitHubSourceArchiveProvider(dependencies(fetch));
    await expect(provider.acquireExact(acquireInput(), target.value)).resolves.toEqual(RECEIPT);
  });

  it.each([
    [
      "malformed",
      new Response(ARCHIVE, { status: 200, headers: { "Content-Length": "invalid" } }),
      "archive_content_length_invalid",
    ],
    ["zero", archiveResponse(new Uint8Array(), 0), "archive_content_length_invalid"],
    ["oversized", archiveResponse(ARCHIVE, 1_025), "archive_content_length_invalid"],
    ["mismatched", archiveResponse(ARCHIVE, 1), "archive_content_length_mismatch"],
    ["chunked oversize", chunkedArchiveResponse(new Uint8Array(1_025)), "archive_stream_too_large"],
  ])("fails closed for %s archive length", async (_name, response, code) => {
    const target = sink();
    const provider = createGitHubSourceArchiveProvider(dependencies(successfulFetch(response)));
    await expect(provider.acquireExact(acquireInput(), target.value)).rejects.toMatchObject({
      code,
    });
    expect(target.writer.abort).toHaveBeenCalledOnce();
    expect(target.writer.commit).not.toHaveBeenCalled();
  });

  it("aborts the sink when streamed bytes exceed the caller's cap", async () => {
    const fetch = successfulFetch();
    fetch.mockReset();
    fetch
      .mockResolvedValueOnce(
        githubResponse({
          token: "opaque",
          expires_at: "2026-08-19T12:59:59.000Z",
          repository_selection: "selected",
          repositories: [{ id: 987_654 }],
          permissions: { contents: "read" },
        }),
      )
      .mockResolvedValueOnce(commitShaResponse())
      .mockResolvedValueOnce(redirectResponse())
      .mockResolvedValueOnce(archiveResponse(new Uint8Array(10), 1));
    const target = sink();
    const provider = createGitHubSourceArchiveProvider(dependencies(fetch));

    await expect(
      provider.acquireExact(acquireInput({ maxBytes: 5 }), target.value),
    ).rejects.toMatchObject({
      code: "archive_stream_too_large",
    });
    expect(target.writer.abort).toHaveBeenCalledOnce();
    expect(target.writer.commit).not.toHaveBeenCalled();
  });

  it("aborts the sink when its writer fails", async () => {
    const target = sink();
    vi.mocked(target.writer.write).mockRejectedValueOnce(new Error("sink unavailable"));
    const provider = createGitHubSourceArchiveProvider(dependencies());
    await expect(provider.acquireExact(acquireInput(), target.value)).rejects.toThrow(
      "sink unavailable",
    );
    expect(target.writer.abort).toHaveBeenCalledOnce();
  });

  it("does not abort after an uncertain commit failure", async () => {
    const target = sink();
    vi.mocked(target.writer.commit).mockRejectedValueOnce(new Error("commit unavailable"));
    const provider = createGitHubSourceArchiveProvider(dependencies());
    const failure = await provider
      .acquireExact(acquireInput(), target.value)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GithubProviderUncertainError);
    expect(failure).toMatchObject({ code: "github_archive_commit_reconciliation_required" });
    expect(target.writer.abort).not.toHaveBeenCalled();
  });

  it.each([
    { sha256: "f".repeat(64) },
    { byteLength: ARCHIVE.byteLength + 1 },
    { archiveFormat: "zip" as const },
    { archiveId: "" },
    { archiveId: `https://codeload.github.com/acme/widget/legacy.tar.gz/${SHA}` },
    { identity: undefined },
    {
      identity: {
        ...IDENTITY,
        context: { ...CONTEXT, operationId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAY") },
      },
    },
  ])("requires committed receipt metadata to match exactly (%o)", async (receiptOverride) => {
    const target = sink();
    vi.mocked(target.writer.commit).mockImplementationOnce(
      async (metadata) => ({ ...RECEIPT, ...metadata, ...receiptOverride }) as SourceArchiveReceipt,
    );
    const provider = createGitHubSourceArchiveProvider(dependencies());
    await expect(provider.acquireExact(acquireInput(), target.value)).rejects.toMatchObject({
      code: "github_archive_commit_reconciliation_required",
    });
    expect(target.writer.abort).not.toHaveBeenCalled();
  });

  it("rejects an expired deadline before grant or GitHub work", async () => {
    const deps = dependencies();
    const target = sink();
    const provider = createGitHubSourceArchiveProvider(deps);
    await expect(
      provider.acquireExact(
        acquireInput({ deadline: new Date("2026-08-19T11:59:59.000Z") }),
        target.value,
      ),
    ).rejects.toBeInstanceOf(GithubProviderInputError);
    expect(deps.repositoryGrantResolver.resolve).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("rejects a grant that does not match the exact requested repository", async () => {
    const deps = dependencies();
    deps.repositoryGrantResolver.resolve.mockResolvedValueOnce({
      installationId: 123,
      repositoryId: 999,
      owner: "acme",
      repository: "widget",
    });
    const provider = createGitHubSourceArchiveProvider(deps);
    await expect(provider.acquireExact(acquireInput(), sink().value)).rejects.toBeInstanceOf(
      GithubProviderContractError,
    );
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it.each([
    `https://codeload.github.com/other/widget/legacy.tar.gz/${SHA}`,
    `https://codeload.github.com/acme/other/legacy.tar.gz/${SHA}`,
    `https://codeload.github.com/acme/widget/legacy.tar.gz/${"f".repeat(40)}`,
    `https://codeload.github.com/acme/widget/tar.gz/${SHA}`,
    `https://codeload.github.com/acme/widget/legacy.tar.gz/${SHA}?token=`,
    `https://codeload.github.com/acme/widget/legacy.tar.gz/${SHA}?token=one&token=two`,
    `https://codeload.github.com/acme/widget/legacy.tar.gz/${SHA}?token=one&other=two`,
    `https://codeload.github.com/acme/widget/legacy.tar.gz/${SHA}?token=${"a".repeat(513)}`,
    `https://codeload.github.com/acme/widget/legacy.tar.gz/${SHA}?token=unsafe%2Fvalue`,
  ])("rejects a redirect path not bound to the exact source (%s)", async (location) => {
    const fetch = successfulFetch();
    fetch.mockReset();
    fetch
      .mockResolvedValueOnce(
        githubResponse({
          token: "opaque",
          expires_at: "2026-08-19T12:59:59.000Z",
          repository_selection: "selected",
          repositories: [{ id: 987_654 }],
          permissions: { contents: "read" },
        }),
      )
      .mockResolvedValueOnce(commitShaResponse())
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: location } }));
    const target = sink();
    await expect(
      createGitHubSourceArchiveProvider(dependencies(fetch)).acquireExact(
        acquireInput(),
        target.value,
      ),
    ).rejects.toMatchObject({ code: "unsafe_archive_redirect" });
    expect(target.value.begin).not.toHaveBeenCalled();
  });

  it("bounds the commit JSON response before beginning the sink", async () => {
    const fetch = successfulFetch();
    fetch.mockReset();
    fetch
      .mockResolvedValueOnce(
        githubResponse({
          token: "opaque",
          expires_at: "2026-08-19T12:59:59.000Z",
          repository_selection: "selected",
          repositories: [{ id: 987_654 }],
          permissions: { contents: "read" },
        }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array(70_000), { status: 200 }));
    const target = sink();
    await expect(
      createGitHubSourceArchiveProvider(dependencies(fetch)).acquireExact(
        acquireInput(),
        target.value,
      ),
    ).rejects.toBeInstanceOf(GithubProviderContractError);
    expect(target.value.begin).not.toHaveBeenCalled();
  });
});
