import { expect, test, vi } from "vitest";
import { sealGrantTokens } from "../src/grant-vault.js";
import { runMakeAction } from "../src/make-action.js";

const organizationId = "01M145HEM4JWAP8KJBG92BSCGE";
const bindingId = "01M700GSJ36CCXDS2ZBATQ9ZFT";
const grantId = "01M400GSJ36CCXDS2ZBATQ9ZFT";
const principalId = "user:user_test";
const registration = "make-development-3";
const key = new Uint8Array(32);
const shaHex = (b64: string) =>
  Array.from(atob(b64), (character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join(
    "",
  );

test("uses encrypted scope, team and connection authority and never dispatches a completed intent twice", async () => {
  const sealed = await sealGrantTokens(
    {
      environment: "development",
      workspace: organizationId,
      human: principalId,
      provider: "make",
      registration,
      grantId,
      generation: 1,
      keyVersion: "1",
    },
    { accessToken: "fake", scopes: ["apps:read", "endpoints:read", "endpoints:run"] },
    key,
  );
  const readActiveConnectionGrant = vi.fn().mockResolvedValue({
    organizationId,
    principalId,
    grantId,
    registration,
    generation: 1,
    encryptedTokens: {
      nonce: shaHex(sealed.nonce),
      ciphertext: shaHex(sealed.ciphertext),
      keyVersion: 1,
    },
  });
  const readMakeActionBinding = vi.fn().mockResolvedValue({
    organizationId,
    principalId,
    grantId,
    providerOrganizationId: 6,
    teamId: 7,
    connectionId: 8,
    action: {
      kind: "endpoint",
      appName: "microsoft-email",
      appVersion: 2,
      endpointName: "listMessages",
    },
  });
  const admitMakeActionExecution = vi
    .fn()
    .mockResolvedValueOnce("admitted")
    .mockResolvedValueOnce("completed");
  const finishMakeActionExecution = vi.fn().mockResolvedValue(undefined);
  const dispatch = vi.fn();
  const fetcher = vi.fn((url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/organizations"))
      return Promise.resolve(
        Response.json({ organizations: [{ id: 6, name: "Test", zone: "eu1" }] }),
      );
    if (path.endsWith("/teams"))
      return Promise.resolve(
        Response.json({ teams: [{ id: 7, name: "Test", organizationId: 6 }] }),
      );
    if (path.endsWith("/endpoints-usable"))
      return Promise.resolve(
        Response.json({
          packages: [
            {
              name: "microsoft-email",
              versions: [
                {
                  version: 2,
                  endpoints: [
                    { name: "listMessages", private: false, credentialsAvailable: [{ id: 8 }] },
                  ],
                },
              ],
            },
          ],
        }),
      );
    dispatch();
    return Promise.resolve(Response.json({ output: { value: [] } }));
  });
  const input = {
    key: `omh_make_v1.${organizationId}.${bindingId}.${"B".repeat(43)}`,
    idempotencyKey: "intent-1",
    input: { top: 1 },
  };
  const dependencies = {
    environment: "development" as const,
    registration,
    key,
    fetcher: fetcher as typeof fetch,
    core: {
      readActiveConnectionGrant,
      readMakeActionBinding,
      admitMakeActionExecution,
      finishMakeActionExecution,
    },
  };
  expect(await runMakeAction(input, dependencies)).toEqual({
    state: "completed",
    output: { output: { value: [] } },
  });
  expect(await runMakeAction(input, dependencies)).toEqual({ state: "already_completed" });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(finishMakeActionExecution).toHaveBeenCalledWith(
    expect.objectContaining({ state: "completed", organizationId, bindingId }),
  );
  expect(admitMakeActionExecution).toHaveBeenCalledWith(
    expect.objectContaining({ organizationId, bindingId, grantGeneration: 1 }),
  );
});
