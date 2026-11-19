function mustFixtureValue<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}
import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { KnownExchangeRejection } from "../src/adapter.js";
import { createBroker } from "../src/authorization.js";
import { makeRegistration } from "../src/registry.js";
import type { CoreConnectionPort } from "../src/ports.js";
import { createControlStore } from "../../control-store/src/store.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { seedProject, STORED_NOW } from "../../control-store/test/support/platform-fixtures.js";
test("browser handoff, one exchange, encrypted pending grant and same-session confirmation use Core authority", async () => {
  const control = await createTestControl();
  try {
    const p = await seedProject(control);
    await control.core.batch([
      control.core
        .prepare("UPDATE organizations SET beta_admitted_at=?2 WHERE organization_id=?1")
        .bind(p.organizationId, STORED_NOW),
      control.core
        .prepare(
          "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,'user_connect','owner','active',1,unhex(?2),?3,'evt')",
        )
        .bind(p.organizationId, "00".repeat(32), STORED_NOW),
      control.core
        .prepare(
          "INSERT INTO local_authorization_grants(organization_id,grant_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,'user','user:user_connect','owner',?3)",
        )
        .bind(p.organizationId, newUlid(), STORED_NOW),
    ]);
    const scope = {
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId: p.devEnvironmentId,
      principalId: "user:user_connect",
      sessionId: "session_connect",
      browserSession: {
        sessionId: "session_connect",
        userId: "user_connect",
        organizationId: null,
        tokenExpiresAt: 4102444800,
      },
    };
    const production = makeRegistration("production");
    const productionBroker = createBroker({
      environment: "production",
      registration: production,
      registry: [production],
      secrets: { clientId: "client", clientSecret: "secret", vaultKey: btoa("x".repeat(32)) },
      qualified: true,
      core: {} as never,
      observer: {} as never,
      adapter: {} as never,
    });
    const productionFailure = await productionBroker.callback(
      new Request("https://connect.ohmyho.st/oauth/callback?state=private-state&code=private-code"),
    );
    expect(productionFailure.status).toBe(303);
    expect(productionFailure.headers.get("location")).toBe(
      "https://app.ohmyho.st/connections/complete",
    );
    expect(productionFailure.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await productionFailure.text()).toBe("");
    let exchanges = 0,
      observations = 0;
    for (const registration of [
      makeRegistration("development"),
      {
        ...makeRegistration("development"),
        provider: "fixture",
        noncePolicy: "required" as const,
        registration: "fixture-development-1",
        clientSecretReference: "FIXTURE_SECRET",
      },
    ]) {
      const originatingCredential =
        registration.provider === "fixture"
          ? {
              kind: "session" as const,
              sessionId: "cli_origin",
              userId: "user_connect",
              workosOrganizationId: null,
              tokenExpiresAt: 4102444800,
            }
          : undefined;
      const actorScope = {
        ...scope,
        ...(originatingCredential === undefined ? {} : { originatingCredential }),
      };
      const service = createBroker({
        environment: "development",
        registration,
        registry: [registration],
        secrets: { clientId: "client", clientSecret: "secret", vaultKey: btoa("x".repeat(32)) },
        qualified: true,
        core: createControlStore(control.bindings).connections as unknown as CoreConnectionPort,
        observer: {
          async observeIntegrationMutation() {},
          async observeConnectionOrigin(input) {
            observations++;
            expect(input.principalId).toBe(scope.principalId);
            expect(input.originatingCredential).toEqual(originatingCredential);
            expect(input.browserSession.sessionId).toBe("session_connect");
          },
        },
        adapter: {
          async authorizationUrl(_registration, _client, state) {
            return `https://provider.test/authorize?state=${state}`;
          },
          async exchange() {
            exchanges++;
            return {
              accessToken: "access",
              refreshToken: "refresh",
              idToken: "signed",
              expiresIn: 300,
            };
          },
          async refresh() {
            throw new Error("not_used");
          },
          async revoke() {
            throw new Error("not_used");
          },
          async verifyIdentity(_idToken, _clientId, nonce) {
            if (registration.provider === "make") expect(nonce).toBeNull();
            else expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
            return "subject";
          },
        },
      });
      expect((await service.providerReadiness({ provider: registration.provider })).state).toBe(
        "available",
      );
      const begin = await service.beginBrowser(actorScope);
      const start = await service.start(new Request(begin.url));
      expect(start.status).toBe(302);
      const cookie = mustFixtureValue(
        mustFixtureValue(start.headers.get("set-cookie")).split(";")[0],
      );
      expect(start.headers.get("set-cookie")).toContain("Secure; HttpOnly; SameSite=Lax");
      const state = mustFixtureValue(
        new URL(mustFixtureValue(start.headers.get("location"))).searchParams.get("state"),
      );
      const callbackUrl = `https://dev.connect.ohmyho.st/oauth/callback?state=${state}&code=fixture`;
      const missingCookie = await service.callback(new Request(callbackUrl));
      expect(missingCookie.status).toBe(303);
      expect(missingCookie.headers.get("location")).toBe(
        "https://dev.app.ohmyho.st/connections/complete",
      );
      expect(missingCookie.headers.get("referrer-policy")).toBe("no-referrer");
      const callback = await service.callback(new Request(callbackUrl, { headers: { cookie } }));
      expect(callback.status).toBe(302);
      const result = mustFixtureValue(
        new URL(mustFixtureValue(callback.headers.get("location"))).searchParams.get("result"),
      );
      expect(
        (await service.callback(new Request(callbackUrl, { headers: { cookie } }))).status,
      ).toBe(303);
      const confirmation = {
        result,
        principalId: scope.principalId,
        sessionId: scope.sessionId,
        handoffHash: createHash("sha256")
          .update(mustFixtureValue(new URL(begin.url).searchParams.get("handoff")))
          .digest("hex"),
      };
      expect(await service.matchesConfirmation(confirmation)).toBe(true);
      for (const changed of [
        { handoffHash: "0".repeat(64) },
        { sessionId: "other" },
        { principalId: "other" },
        { result: "a".repeat(43) },
      ]) {
        expect(await service.matchesConfirmation({ ...confirmation, ...changed })).toBe(false);
      }
      await expect(
        service.complete({ result, principalId: scope.principalId, sessionId: "other" }),
      ).rejects.toThrow();
      expect(
        await service.complete({
          result,
          principalId: scope.principalId,
          sessionId: scope.sessionId,
        }),
      ).toMatchObject({ state: "active", grantId: expect.any(String) });
      expect(
        await service.complete({
          result,
          principalId: scope.principalId,
          sessionId: scope.sessionId,
        }),
      ).toMatchObject({ state: "active", grantId: expect.any(String) });
    }
    expect(exchanges).toBe(2);
    expect(observations).toBeGreaterThanOrEqual(4);
    const registration = makeRegistration("development");
    let originFresh = true;
    const staleOrigin = createBroker({
      environment: "development",
      registration,
      registry: [registration],
      secrets: { clientId: "client", clientSecret: "secret", vaultKey: btoa("x".repeat(32)) },
      qualified: true,
      core: createControlStore(control.bindings).connections as unknown as CoreConnectionPort,
      observer: {
        async observeIntegrationMutation() {},
        async observeConnectionOrigin(input) {
          expect(input.originatingCredential?.kind).toBe("session");
          if (!originFresh) throw new Error("revoked");
        },
      },
      adapter: {
        async authorizationUrl(_r, _c, state) {
          return `https://provider.test/?state=${state}`;
        },
        async exchange() {
          exchanges++;
          return {
            accessToken: "access",
            refreshToken: "refresh",
            idToken: "signed",
            expiresIn: 300,
          };
        },
        async verifyIdentity() {
          return "subject";
        },
        async refresh() {
          throw new Error();
        },
        async revoke() {
          throw new Error();
        },
      },
    });
    const cliActor = {
      ...scope,
      originatingCredential: {
        kind: "session" as const,
        sessionId: "cli_revoked",
        userId: "user_connect",
        workosOrganizationId: null,
        tokenExpiresAt: 4102444800,
      },
    };
    const staleStart = await staleOrigin.start(
      new Request((await staleOrigin.beginBrowser(cliActor)).url),
    );
    const staleState = mustFixtureValue(
        new URL(mustFixtureValue(staleStart.headers.get("location"))).searchParams.get("state"),
      ),
      staleCookie = mustFixtureValue(
        mustFixtureValue(staleStart.headers.get("set-cookie")).split(";")[0],
      );
    originFresh = false;
    expect(
      (
        await staleOrigin.callback(
          new Request(
            `https://dev.connect.ohmyho.st/oauth/callback?state=${staleState}&code=fixture`,
            { headers: { cookie: staleCookie } },
          ),
        )
      ).status,
    ).toBe(303);
    expect(exchanges).toBe(2);
    originFresh = true;
    const activationStart = await staleOrigin.start(
      new Request((await staleOrigin.beginBrowser(cliActor)).url),
    );
    const activationState = mustFixtureValue(
        new URL(mustFixtureValue(activationStart.headers.get("location"))).searchParams.get(
          "state",
        ),
      ),
      activationCookie = mustFixtureValue(
        mustFixtureValue(activationStart.headers.get("set-cookie")).split(";")[0],
      );
    const pending = await staleOrigin.callback(
      new Request(
        `https://dev.connect.ohmyho.st/oauth/callback?state=${activationState}&code=fixture`,
        { headers: { cookie: activationCookie } },
      ),
    );
    expect(pending.status).toBe(302);
    const pendingResult = mustFixtureValue(
      new URL(mustFixtureValue(pending.headers.get("location"))).searchParams.get("result"),
    );
    originFresh = false;
    await expect(
      staleOrigin.complete({
        result: pendingResult,
        principalId: scope.principalId,
        sessionId: scope.sessionId,
      }),
    ).rejects.toThrow("revoked");
    expect(exchanges).toBe(3);
    const outcomes: string[] = [];
    const baseCore = createControlStore(control.bindings).connections;
    const rejection = createBroker({
      environment: "development",
      registration,
      registry: [registration],
      secrets: { clientId: "client", clientSecret: "secret", vaultKey: btoa("x".repeat(32)) },
      qualified: true,
      core: {
        ...baseCore,
        async terminateConnectionAttempt(
          input: Parameters<CoreConnectionPort["terminateConnectionAttempt"]>[0],
        ) {
          outcomes.push(input.outcome);
          return baseCore.terminateConnectionAttempt(input);
        },
      } as unknown as CoreConnectionPort,
      observer: { async observeIntegrationMutation() {}, async observeConnectionOrigin() {} },
      adapter: {
        async authorizationUrl(_r, _c, state) {
          return `https://provider.test/?state=${state}`;
        },
        async exchange() {
          throw new KnownExchangeRejection();
        },
        async verifyIdentity() {
          throw Error();
        },
        async refresh() {
          throw Error();
        },
        async revoke() {
          throw Error();
        },
      },
    });
    const rejectedStart = await rejection.start(
      new Request((await rejection.beginBrowser(scope)).url),
    );
    const rejectedState = mustFixtureValue(
      new URL(mustFixtureValue(rejectedStart.headers.get("location"))).searchParams.get("state"),
    );
    const rejectedCookie = mustFixtureValue(
      mustFixtureValue(rejectedStart.headers.get("set-cookie")).split(";")[0],
    );
    await rejection.callback(
      new Request(
        `https://dev.connect.ohmyho.st/oauth/callback?state=${rejectedState}&code=fixture`,
        { headers: { cookie: rejectedCookie } },
      ),
    );
    expect(outcomes).toEqual(["denied"]);
    let revoked = 0;
    const invalid = createBroker({
      environment: "development",
      registration,
      registry: [registration],
      secrets: { clientId: "client", clientSecret: "secret", vaultKey: btoa("x".repeat(32)) },
      qualified: true,
      core: {
        ...createControlStore(control.bindings).connections,
        async retainConnectionOrphan() {
          throw new Error("storage unavailable");
        },
      } as unknown as CoreConnectionPort,
      observer: { async observeIntegrationMutation() {}, async observeConnectionOrigin() {} },
      adapter: {
        async authorizationUrl(_r, _c, state) {
          return `https://provider.test/?state=${state}`;
        },
        async exchange() {
          return {
            accessToken: "access",
            refreshToken: "refresh",
            idToken: "signed",
            expiresIn: Number.MAX_SAFE_INTEGER,
          };
        },
        async verifyIdentity() {
          return "subject";
        },
        async refresh() {
          throw new Error();
        },
        async revoke() {
          revoked++;
        },
      },
    });
    const badStart = await invalid.start(new Request((await invalid.beginBrowser(scope)).url));
    const badState = mustFixtureValue(
        new URL(mustFixtureValue(badStart.headers.get("location"))).searchParams.get("state"),
      ),
      badCookie = mustFixtureValue(
        mustFixtureValue(badStart.headers.get("set-cookie")).split(";")[0],
      );
    expect(
      (
        await invalid.callback(
          new Request(
            `https://dev.connect.ohmyho.st/oauth/callback?state=${badState}&code=fixture`,
            { headers: { cookie: badCookie } },
          ),
        )
      ).status,
    ).toBe(303);
    expect(revoked).toBe(1);
    let omitIdToken = false;
    const failedIdentity = createBroker({
      environment: "development",
      registration,
      registry: [registration],
      secrets: { clientId: "client", clientSecret: "secret", vaultKey: btoa("x".repeat(32)) },
      qualified: true,
      core: createControlStore(control.bindings).connections as unknown as CoreConnectionPort,
      observer: { async observeIntegrationMutation() {}, async observeConnectionOrigin() {} },
      adapter: {
        async authorizationUrl(_r, _c, state) {
          return `https://provider.test/?state=${state}`;
        },
        async exchange() {
          return {
            accessToken: "issued_access",
            refreshToken: "issued_refresh",
            ...(omitIdToken ? {} : { idToken: "bad" }),
            expiresIn: 300,
          };
        },
        async verifyIdentity() {
          throw new Error();
        },
        async refresh() {
          throw new Error();
        },
        async revoke() {
          throw new Error();
        },
      },
    });
    const failedStart = await failedIdentity.start(
      new Request((await failedIdentity.beginBrowser(scope)).url),
    );
    const failedState = mustFixtureValue(
        new URL(mustFixtureValue(failedStart.headers.get("location"))).searchParams.get("state"),
      ),
      failedCookie = mustFixtureValue(
        mustFixtureValue(failedStart.headers.get("set-cookie")).split(";")[0],
      );
    expect(
      (
        await failedIdentity.callback(
          new Request(
            `https://dev.connect.ohmyho.st/oauth/callback?state=${failedState}&code=fixture`,
            { headers: { cookie: failedCookie } },
          ),
        )
      ).status,
    ).toBe(303);
    const orphan = await control.core
      .prepare(
        "SELECT state,hex(token_ciphertext) AS ciphertext FROM connection_orphan_grants WHERE state='outcome_unknown'",
      )
      .first<{
        state: string;
        ciphertext: string;
      }>();
    expect(orphan?.state).toBe("outcome_unknown");
    expect(orphan?.ciphertext).not.toContain(
      Buffer.from("issued_refresh").toString("hex").toUpperCase(),
    );
    omitIdToken = true;
    const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const missingStart = await failedIdentity.start(
        new Request((await failedIdentity.beginBrowser(scope)).url),
      );
      const missingState = mustFixtureValue(
        new URL(mustFixtureValue(missingStart.headers.get("location"))).searchParams.get("state"),
      );
      const missingCookie = mustFixtureValue(
        mustFixtureValue(missingStart.headers.get("set-cookie")).split(";")[0],
      );
      const response = await failedIdentity.callback(
        new Request(
          `https://dev.connect.ohmyho.st/oauth/callback?state=${missingState}&code=private-code`,
          { headers: { cookie: missingCookie } },
        ),
      );
      expect(response.status).toBe(303);
      expect(diagnostics.mock.calls.map(([value]) => JSON.parse(String(value)))).toContainEqual({
        event: "connection_broker_failure",
        phase: "callback",
        reason: "missing_id_token",
      });
      expect(JSON.stringify(diagnostics.mock.calls)).not.toMatch(
        /private-code|issued_access|issued_refresh|user_connect/,
      );
    } finally {
      diagnostics.mockRestore();
    }
  } finally {
    await control.dispose();
  }
}, 120000);
