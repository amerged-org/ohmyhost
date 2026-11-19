import { describe, expect, it } from "vitest";

import {
  parseDeviceTokens,
  WORKOS_AUTHKIT_DEVICE_AUTHORIZATION_ENDPOINT,
  WORKOS_AUTHKIT_DEVICE_TOKEN_ENDPOINT,
  WorkosContractError,
  WorkosDeviceFlowClient,
  type WorkosPublicHttpRequest,
} from "./index.js";

describe("WorkOS public Device Flow", () => {
  it("polls RFC 8628 without sending a client secret and applies slow_down", async () => {
    let now = new Date("2026-08-18T10:00:00.000Z");
    const requests: WorkosPublicHttpRequest[] = [];
    const responses = [
      {
        status: 200,
        body: JSON.stringify({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.example.test/device",
          expires_in: 600,
          interval: 5,
        }),
      },
      { status: 400, body: JSON.stringify({ error: "slow_down" }) },
      {
        status: 200,
        body: JSON.stringify({
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          token_type: "Bearer",
        }),
      },
    ];
    const untrustedConfig = {
      clientId: "client_public",
      verificationUri: "https://auth.example.test/device",
      authorizationEndpoint: "https://attacker.example/authorize",
      tokenEndpoint: "https://attacker.example/token",
    };
    const client = new WorkosDeviceFlowClient(
      untrustedConfig,
      {
        async send(request) {
          requests.push(request);
          const response = responses.shift();
          if (response === undefined) throw new Error("Fixture response exhausted");
          return response;
        },
      },
      { now: () => now },
    );

    const session = await client.authorize();
    now = new Date(now.getTime() + 5_000);
    await expect(session.poll()).resolves.toEqual({
      state: "pending",
      nextPollAt: new Date("2026-08-18T10:00:15.000Z"),
    });
    now = new Date(now.getTime() + 10_000);
    await expect(session.poll()).resolves.toMatchObject({
      state: "complete",
      tokens: {
        provenance: { kind: "workos_authkit_device_flow", clientId: "client_public" },
      },
    });

    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.redirect === "error")).toBe(true);
    expect(requests.map((request) => request.url)).toEqual([
      WORKOS_AUTHKIT_DEVICE_AUTHORIZATION_ENDPOINT,
      WORKOS_AUTHKIT_DEVICE_TOKEN_ENDPOINT,
      WORKOS_AUTHKIT_DEVICE_TOKEN_ENDPOINT,
    ]);
    expect(requests.map((request) => request.body).join("&")).not.toMatch(
      /client_secret|api_key|management/u,
    );
    expect(requests[2]?.body).toContain("urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
  });

  it("rejects provider-management credential material without reflecting its value", () => {
    const value = "provider-secret-that-must-not-leak";
    let caught: unknown;
    try {
      parseDeviceTokens({ access_token: "a", refresh_token: "r", api_key: value });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkosContractError);
    expect(String(caught)).not.toContain(value);
  });

  it("fails closed for untrusted verification origins, early polls, denial, and expiry", async () => {
    let now = new Date("2026-08-18T10:00:00Z");
    const authorization = (verificationUri = "https://auth.example.test/device", expiresIn = 300) =>
      ({
        status: 200,
        body: JSON.stringify({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: verificationUri,
          expires_in: expiresIn,
          interval: 5,
        }),
      }) as const;
    const makeClient = (responses: Array<{ status: number; body: string }>) =>
      new WorkosDeviceFlowClient(
        { clientId: "client_public", verificationUri: "https://auth.example.test/device" },
        {
          async send() {
            const response = responses.shift();
            if (response === undefined) throw new Error("Fixture response exhausted");
            return response;
          },
        },
        { now: () => now },
      );

    await expect(
      makeClient([authorization("https://attacker.example/device")]).authorize(),
    ).rejects.toMatchObject({ code: "unexpected_verification_uri" });

    const pendingSession = await makeClient([
      authorization(),
      { status: 400, body: JSON.stringify({ error: "access_denied" }) },
    ]).authorize();
    await expect(pendingSession.poll()).rejects.toMatchObject({ code: "poll_too_soon" });
    now = new Date(now.getTime() + 5_000);
    await expect(pendingSession.poll()).rejects.toMatchObject({ code: "access_denied" });

    const expiredSession = await makeClient([authorization(undefined, 1)]).authorize();
    now = new Date(now.getTime() + 1_000);
    await expect(expiredSession.poll()).rejects.toMatchObject({ code: "expired_token" });

    now = new Date(Number.NaN);
    await expect(makeClient([authorization()]).authorize()).rejects.toMatchObject({
      code: "invalid_clock",
    });
  });
});
