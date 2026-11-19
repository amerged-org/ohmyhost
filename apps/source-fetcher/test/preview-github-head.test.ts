import { describe, expect, it } from "vitest";
import { createPreviewGithubHeadReader } from "../src/preview-github-head.js";

describe("GitHub preview head observation", () => {
  it("uses a repository-scoped installation token and reports the verified default branch and exact head", async () => {
    const requests: { url: string; authorization: string | null; body: unknown }[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(url),
        authorization: headers.get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (String(url).endsWith("/access_tokens"))
        return Response.json(
          {
            token: "private-test-token",
            expires_at: "2026-11-16T01:00:00.000Z",
            repository_selection: "selected",
            permissions: { contents: "read" },
            repositories: [{ id: 42 }],
          },
          { status: 201 },
        );
      if (String(url).endsWith("/repos/owner/repo"))
        return Response.json({ id: 42, full_name: "owner/repo", default_branch: "main" });
      return Response.json({
        ref: "refs/heads/main",
        object: { type: "commit", sha: "a".repeat(40) },
      });
    };
    const read = createPreviewGithubHeadReader({
      fetch,
      now: () => new Date("2026-11-16T00:00:00.000Z"),
      appJwtIssuer: { issue: async () => "app-jwt" },
      userAgent: "test",
      requestTimeoutMs: 1000,
    });
    const result = await read({
      installationId: "7",
      repositoryId: "42",
      repositoryFullName: "owner/repo",
      ref: "refs/heads/main",
    });
    expect(result).toEqual({ defaultBranch: "refs/heads/main", head: "a".repeat(40) });
    await expect(
      read({
        installationId: "7",
        repositoryId: "42",
        repositoryFullName: "owner/repo",
        ref: null,
      }),
    ).resolves.toEqual(result);
    expect(requests[0]?.body).toEqual({ repository_ids: [42], permissions: { contents: "read" } });
    expect(JSON.stringify(result)).not.toContain("private-test-token");
    await expect(
      read({
        installationId: "7",
        repositoryId: "42",
        repositoryFullName: "owner/repo",
        ref: "refs/heads/../secret",
      }),
    ).rejects.toThrow();
  });
});
