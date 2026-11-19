import { describe, expect, it } from "vitest";

import * as provider from "./index.js";

describe("GitHub provider public root", () => {
  it("loads the current package surface", () => {
    expect(provider).toMatchObject({
      createGitHubAppWebhookConfigurationProvider: expect.any(Function),
      createGitHubAppJwtIssuer: expect.any(Function),
      createGitHubSourceArchiveProvider: expect.any(Function),
    });
    expect(provider).not.toHaveProperty("requestGithubInstallationToken");
    expect(provider).not.toHaveProperty("fetchExactGithubArchive");
  });
});
