import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  GithubProviderAuthenticationError,
  GithubProviderContractError,
  GithubProviderInputError,
  GithubProviderRateLimitError,
  GithubProviderTransportError,
} from "./errors.js";
import { fetchExactGithubArchive } from "./archive.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TOKEN = "ghs_installation_secret";
const ARCHIVE = new TextEncoder().encode("archive bytes");

function commitResponse(sha = SHA): Response {
  return new Response(sha, {
    status: 200,
    headers: { "Content-Type": "application/vnd.github.sha" },
  });
}

function redirectResponse(
  location = `https://codeload.github.com/acme/widget/legacy.tar.gz/${SHA}`,
): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

function archiveResponse(bytes = ARCHIVE, declaredLength = bytes.byteLength): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "Content-Length": String(declaredLength) },
  });
}

function input(fetch: typeof globalThis.fetch, overrides: Record<string, unknown> = {}) {
  return {
    owner: "acme",
    repository: "widget",
    repositoryId: 987_654,
    requestedSha: SHA,
    installationToken: TOKEN,
    userAgent: "ohmyhost-test",
    maxArchiveBytes: 1_024,
    requestTimeoutMs: 1_000,
    overallTimeoutMs: 2_500,
    fetch,
    ...overrides,
  };
}

describe("exact GitHub archive fetch", () => {
  it("resolves only the requested commit and strips credentials at the one allowed redirect", async () => {
    const fetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = request.toString();
      const call = fetch.mock.calls.length;
      if (call === 1) return commitResponse();
      if (call === 2) {
        expect(url).toBe(`https://api.github.com/repos/acme/widget/tarball/${SHA}`);
        expect(init?.redirect).toBe("manual");
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
        return redirectResponse();
      }
      expect(url).toBe(`https://codeload.github.com/acme/widget/legacy.tar.gz/${SHA}`);
      const headers = new Headers(init?.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("cookie")).toBe(false);
      return archiveResponse();
    });

    await expect(fetchExactGithubArchive(input(fetch))).resolves.toEqual({
      bytes: ARCHIVE,
      byteLength: ARCHIVE.byteLength,
      sha256: createHash("sha256").update(ARCHIVE).digest("hex"),
      owner: "acme",
      repository: "widget",
      repositoryId: 987_654,
      requestedSha: SHA,
      resolvedCommitSha: SHA,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      `https://api.github.com/repos/acme/widget/commits/${SHA}`,
    );
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("accept")).toBe(
      "application/vnd.github.sha",
    );
  });

  it.each([
    ["noncanonical owner", { owner: "acme/org" }],
    ["unsafe repository ID", { repositoryId: 0 }],
    ["uppercase SHA", { requestedSha: SHA.toUpperCase() }],
    ["zero SHA", { requestedSha: "0".repeat(40) }],
    ["invalid archive cap", { maxArchiveBytes: 0 }],
    ["invalid timeouts", { requestTimeoutMs: 2_500, overallTimeoutMs: 2_000 }],
  ])("rejects invalid input: %s", async (_name, overrides) => {
    await expect(fetchExactGithubArchive(input(vi.fn(), overrides))).rejects.toBeInstanceOf(
      GithubProviderInputError,
    );
  });

  it("rejects a resolved commit mismatch without falling back", async () => {
    const fetch = vi.fn(async () => commitResponse("f".repeat(40)));
    await expect(fetchExactGithubArchive(input(fetch))).rejects.toMatchObject({
      code: "commit_sha_mismatch",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reports an unavailable requested commit as a permanent source mistake without treating a 404 as proof of access", async () => {
    await expect(
      fetchExactGithubArchive(input(async () => new Response(null, { status: 422 }))),
    ).rejects.toMatchObject({ code: "requested_commit_not_found" });
    await expect(
      fetchExactGithubArchive(input(async () => new Response(null, { status: 404 }))),
    ).rejects.toBeInstanceOf(GithubProviderAuthenticationError);
  });

  it.each([
    ["permanent redirect", 301, `https://codeload.github.com/acme/widget/tar.gz/${SHA}`],
    ["wrong host", 302, `https://example.com/acme/widget/tar.gz/${SHA}`],
    ["userinfo", 302, `https://user@codeload.github.com/acme/widget/tar.gz/${SHA}`],
    ["query", 302, `https://codeload.github.com/acme/widget/tar.gz/${SHA}?secret=1`],
    ["fragment", 307, `https://codeload.github.com/acme/widget/tar.gz/${SHA}#fragment`],
  ])("rejects an unsafe redirect: %s", async (_name, status, location) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(commitResponse())
      .mockResolvedValueOnce(new Response(null, { status, headers: { Location: location } }));
    await expect(fetchExactGithubArchive(input(fetch))).rejects.toBeInstanceOf(
      GithubProviderContractError,
    );
  });

  it("accepts a chunked archive without Content-Length and still computes its digest", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(commitResponse())
      .mockResolvedValueOnce(redirectResponse())
      .mockResolvedValueOnce(new Response(ARCHIVE, { status: 200 }));
    await expect(fetchExactGithubArchive(input(fetch))).resolves.toMatchObject({
      byteLength: ARCHIVE.byteLength,
      sha256: createHash("sha256").update(ARCHIVE).digest("hex"),
    });
  });

  it("rejects malformed, zero, and oversized declared archive lengths", async () => {
    for (const responseValue of [
      new Response(ARCHIVE, { status: 200, headers: { "Content-Length": "invalid" } }),
      archiveResponse(new Uint8Array(), 0),
      archiveResponse(ARCHIVE, 1_025),
    ]) {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(commitResponse())
        .mockResolvedValueOnce(redirectResponse())
        .mockResolvedValueOnce(responseValue);
      await expect(fetchExactGithubArchive(input(fetch))).rejects.toBeInstanceOf(
        GithubProviderContractError,
      );
    }
  });

  it("rejects a declared length that does not match the streamed bytes", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(commitResponse())
      .mockResolvedValueOnce(redirectResponse())
      .mockResolvedValueOnce(archiveResponse(ARCHIVE, 1));
    await expect(fetchExactGithubArchive(input(fetch))).rejects.toMatchObject({
      code: "archive_content_length_mismatch",
    });
  });

  it.each([
    `https://codeload.github.com/other/widget/legacy.tar.gz/${SHA}`,
    `https://codeload.github.com/acme/other/legacy.tar.gz/${SHA}`,
    `https://codeload.github.com/acme/widget/legacy.tar.gz/${"f".repeat(40)}`,
    `https://codeload.github.com/acme/widget/tar.gz/${SHA}`,
  ])("rejects a codeload path not bound to the exact source (%s)", async (location) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(commitResponse())
      .mockResolvedValueOnce(redirectResponse(location));
    await expect(fetchExactGithubArchive(input(fetch))).rejects.toMatchObject({
      code: "unsafe_archive_redirect",
    });
  });

  it("enforces the streaming cap even when Content-Length lies", async () => {
    const bytes = new Uint8Array(1_025);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(commitResponse())
      .mockResolvedValueOnce(redirectResponse())
      .mockResolvedValueOnce(archiveResponse(bytes, 1));
    await expect(fetchExactGithubArchive(input(fetch))).rejects.toMatchObject({
      code: "archive_stream_too_large",
    });
  });

  it("classifies private-repository 404 as authentication rather than not-found", async () => {
    await expect(
      fetchExactGithubArchive(input(vi.fn(async () => new Response("missing", { status: 404 })))),
    ).rejects.toBeInstanceOf(GithubProviderAuthenticationError);
  });

  it("classifies rate limits and GET transport failures", async () => {
    await expect(
      fetchExactGithubArchive(input(vi.fn(async () => new Response("limited", { status: 429 })))),
    ).rejects.toBeInstanceOf(GithubProviderRateLimitError);
    await expect(
      fetchExactGithubArchive(
        input(
          vi.fn(async () => {
            throw new Error(`network ${TOKEN}`);
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(GithubProviderTransportError);
  });

  it("aborts a request at its configured deadline", async () => {
    const fetch = vi.fn(
      (_request: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    await expect(
      fetchExactGithubArchive(input(fetch, { requestTimeoutMs: 5, overallTimeoutMs: 50 })),
    ).rejects.toMatchObject({ code: "github_request_timeout" });
  });
});
