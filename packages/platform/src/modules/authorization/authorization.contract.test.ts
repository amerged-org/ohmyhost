import { describe, expect, it, vi } from "vitest";

import * as platform from "../../index.js";
import { parseUlid } from "../../shared/index.js";
import type { AuthorizationCheck, AuthorizationPort } from "../../ports/index.js";

type UnknownAsyncFunction = (...arguments_: readonly unknown[]) => Promise<unknown>;

function requireAuthorizeProjectAction(): UnknownAsyncFunction {
  const candidate = (platform as Record<string, unknown>)["authorizeProjectAction"];
  expect(candidate, "Expected @ohmyhost/platform to export authorizeProjectAction").toBeTypeOf(
    "function",
  );
  return candidate as UnknownAsyncFunction;
}

const check: AuthorizationCheck = {
  principal: { kind: "user", subjectId: "user:user_01" },
  resource: {
    kind: "project",
    organizationId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    projectId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
  },
  action: "deployments:create",
};

describe("project authorization policy", () => {
  it("denies when the selected backend denies", async () => {
    const port: AuthorizationPort = { check: vi.fn().mockResolvedValue("deny") };

    await expect(
      requireAuthorizeProjectAction()({ port, check, transferState: "active" }),
    ).resolves.toEqual({ decision: "deny", reason: "BACKEND_DENIED" });
  });

  it("fails closed when the selected backend cannot decide", async () => {
    const port: AuthorizationPort = {
      check: vi.fn().mockRejectedValue(new Error("authorization backend unavailable")),
    };

    await expect(
      requireAuthorizeProjectAction()({ port, check, transferState: "active" }),
    ).resolves.toEqual({ decision: "deny", reason: "AUTHORIZATION_BACKEND_UNAVAILABLE" });
  });

  it("does not reuse a stale allow decision after a backend failure", async () => {
    const port: AuthorizationPort = {
      check: vi
        .fn()
        .mockResolvedValueOnce("allow")
        .mockRejectedValueOnce(new Error("authorization backend unavailable")),
    };
    const authorizeProjectAction = requireAuthorizeProjectAction();

    await expect(authorizeProjectAction({ port, check, transferState: "active" })).resolves.toEqual(
      { decision: "allow" },
    );
    await expect(authorizeProjectAction({ port, check, transferState: "active" })).resolves.toEqual(
      { decision: "deny", reason: "AUTHORIZATION_BACKEND_UNAVAILABLE" },
    );
    expect(port.check).toHaveBeenCalledTimes(2);
  });

  it("denies a transfer-frozen project even when the backend would allow it", async () => {
    const port: AuthorizationPort = { check: vi.fn().mockResolvedValue("allow") };

    await expect(
      requireAuthorizeProjectAction()({ port, check, transferState: "frozen" }),
    ).resolves.toEqual({ decision: "deny", reason: "PROJECT_FROZEN" });
    expect(port.check).not.toHaveBeenCalled();
  });

  it("denies an unknown backend decision", async () => {
    const port = { check: vi.fn().mockResolvedValue("unknown") } as unknown as AuthorizationPort;

    await expect(
      requireAuthorizeProjectAction()({ port, check, transferState: "active" }),
    ).resolves.toEqual({ decision: "deny", reason: "INVALID_BACKEND_DECISION" });
  });
});
