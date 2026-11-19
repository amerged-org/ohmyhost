import { expect, it } from "vitest";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { runProductionCli, createAuthenticatedProductTransport } from "../src/composition.js";
import { GeneratedSdkProductApi } from "../src/product-api.js";
import type { ProfileRegistry } from "../src/profile-store.js";

it("uses the supplied user token through the SDK without reading, refreshing or changing native credentials", async () => {
  const token = `sk_${"b".repeat(46)}`;
  const identity = {
    actor_id: "user:agent_owner",
    email: "owner@example.test",
    organization_ids: ["00000000000000000000000001"],
    organizations: [{ id: "00000000000000000000000001", name: "Workspace" }],
  };
  const transport = new MockAgent();
  transport.disableNetConnect();
  transport
    .get("https://app.ohmyho.st")
    .intercept({
      path: "/v1/me",
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    })
    .reply(200, identity, { headers: { "content-type": "application/json" } })
    .times(2);
  transport
    .get("https://app.ohmyho.st")
    .intercept({
      path: "/v1/me",
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    })
    .reply(
      401,
      {
        type: "https://ohmyho.st/problems/unauthenticated",
        title: "Authentication required",
        status: 401,
        code: "unauthenticated",
        request_id: "token-revocation-test",
        retryable: false,
        suggested_action: "Run 'ohmyhost login'.",
      },
      { headers: { "content-type": "application/problem+json" } },
    );
  const previous = getGlobalDispatcher();
  setGlobalDispatcher(transport);
  class SavedLoginsMustStayUnused implements ProfileRegistry {
    async list(): Promise<never> {
      throw new Error("Unexpected saved-login read");
    }
    credential(): never {
      throw new Error("Unexpected native credential access");
    }
    legacy(): never {
      throw new Error("Unexpected legacy credential access");
    }
    async save(): Promise<never> {
      throw new Error("Unexpected saved-login write");
    }
    async remove(): Promise<never> {
      throw new Error("Unexpected saved-login deletion");
    }
  }
  try {
    const output: string[] = [];
    const io = {
      writeStdout: (s: string) => output.push(s),
      writeStderr: (s: string) => output.push(s),
    };
    const profiles = new SavedLoginsMustStayUnused();
    const environment = { OHMYHOST_TOKEN: token };
    expect(
      await runProductionCli(["whoami", "--json"], environment, io, new AbortController().signal, {
        profiles,
      }),
      output.join(""),
    ).toBe(0);
    expect(JSON.parse(output[0] ?? "")).toMatchObject({ status: "authenticated", identity });
    const wire = await createAuthenticatedProductTransport(new AbortController().signal, {
      environment,
      profiles,
    });
    expect(
      await new GeneratedSdkProductApi(
        wire.baseUrl,
        wire.accessToken,
        wire.fetch,
      ).getCurrentIdentity(),
    ).toEqual(identity);
    for (const command of [
      ["login", "--json"],
      ["logout", "--json"],
    ]) {
      output.length = 0;
      expect(
        await runProductionCli(command, environment, io, new AbortController().signal, {
          profiles,
        }),
      ).toBe(2);
      expect(output.join("")).toContain("environment_token_active");
    }
    // A user token belongs to one workspace: it can neither create nor select another, before any request.
    for (const command of [
      ["organization", "create", "--name", "Other", "--idempotency-key", "token-only", "--json"],
      ["organization", "list", "--json"],
      ["organization", "use", "--organization", "00000000000000000000000001", "--json"],
    ]) {
      output.length = 0;
      expect(
        await runProductionCli(command, environment, io, new AbortController().signal, {
          profiles,
        }),
      ).toBe(2);
      expect(output.join("")).toContain("interactive_login_required");
    }
    output.length = 0;
    expect(
      await runProductionCli(
        ["whoami", "--json"],
        { OHMYHOST_TOKEN: "invalid secret" },
        io,
        new AbortController().signal,
        { profiles },
      ),
    ).toBe(2);
    expect(output.join("")).not.toContain("invalid secret");
    expect(output.join("")).not.toContain(token);
    output.length = 0;
    expect(
      await runProductionCli(["whoami", "--json"], environment, io, new AbortController().signal, {
        profiles,
      }),
    ).toBe(7);
    const revoked = JSON.parse(output.at(-1) ?? "");
    expect(revoked.error.code).toBe("unauthenticated");
    expect(revoked.error.suggested_action).toContain("OHMYHOST_TOKEN is set");
    expect(revoked.error.suggested_action).toContain("unset it and run 'ohmyhost login --json'");
    expect(revoked.error.suggested_action).toContain("OHMYHOST_ENVIRONMENT selects");
    expect(output.join("")).not.toContain(token);
  } finally {
    setGlobalDispatcher(previous);
    await transport.close();
  }
});
