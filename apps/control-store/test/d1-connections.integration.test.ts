import { expect, test } from "vitest";
import { createControlStore } from "../src/store.js";
import { bucketOf } from "../src/router.js";
import { newUlid } from "../src/catalog/common.js";
import { createTestControl } from "./support/control-d1.js";
import { seedProject, STORED_NOW } from "./support/platform-fixtures.js";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Required fixture missing");
  return value;
}

test("browser handoffs and callback claims are one-use and enforce current owner authority", async () => {
  const control = await createTestControl();
  try {
    const p = await seedProject(control);
    const delegatedGrantId = crypto.randomUUID(),
      consentHash = "ad".repeat(32);
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
      control.core
        .prepare(
          "INSERT INTO mcp_client_grants(organization_id,grant_id,user_id,client_id,consent_hash,allow_publish,revision,created_at) VALUES(?1,?2,'user_connect','client-connect',?3,0,1,?4)",
        )
        .bind(p.organizationId, delegatedGrantId, consentHash, STORED_NOW),
    ]);
    const store = createControlStore(control.bindings).connections;
    const handoffHash = "01".repeat(32),
      stateHash = "02".repeat(32),
      cookieHash = "03".repeat(32);
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
        tokenExpiresAt: 1,
      },
      handoffHash,
      registration: "make-development-2",
      originatingDelegation: {
        grantId: delegatedGrantId,
        clientId: "client-connect",
        consentHash,
        action: "integrations:manage" as const,
      },
    };
    const { projectId: _projectId, environmentId: _environmentId, ...workspaceScope } = scope;
    void _projectId;
    void _environmentId;
    const workspaceHash = "fa".repeat(32);
    expect(
      await store.createConnectionHandoff({ ...workspaceScope, handoffHash: workspaceHash }),
    ).toBe(true);
    const workspaceHandoff = await store.consumeConnectionHandoff({ handoffHash: workspaceHash });
    expect(workspaceHandoff).not.toHaveProperty("projectId");
    expect(workspaceHandoff).not.toHaveProperty("ownershipVersion");
    const workspaceAttempt = {
      handoffHash: workspaceHash,
      attemptId: newUlid(),
      stateHash: "fb".repeat(32),
      cookieHash: "fc".repeat(32),
      encryptedVerifier: { nonce: "04".repeat(12), ciphertext: "05".repeat(32), keyVersion: 1 },
      oidcNonce: "nonce",
    };
    expect(await store.createConnectionAttempt(workspaceAttempt)).toBe(true);
    expect(
      await store.readConnectionAttemptOrigin({
        stateHash: workspaceAttempt.stateHash,
        cookieHash: workspaceAttempt.cookieHash,
        registration: scope.registration,
      }),
    ).not.toHaveProperty("projectId");
    const competingHash = "ec".repeat(32);
    expect(
      await store.createConnectionHandoff({ ...workspaceScope, handoffHash: competingHash }),
    ).toBe(true);
    expect(await store.consumeConnectionHandoff({ handoffHash: competingHash })).not.toBeNull();
    const competingAttempt = {
      ...workspaceAttempt,
      handoffHash: competingHash,
      attemptId: newUlid(),
      stateHash: "ed".repeat(32),
      cookieHash: "ee".repeat(32),
    };
    expect(await store.createConnectionAttempt(competingAttempt)).toBe(true);
    const claims = await Promise.all(
      [workspaceAttempt, competingAttempt].map((attempt) =>
        store.claimConnectionAttempt({
          stateHash: attempt.stateHash,
          cookieHash: attempt.cookieHash,
          registration: scope.registration,
        }),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winningAttemptId = required(claims.find(Boolean)).attemptId;
    const workspaceGrantId = newUlid();
    const workspaceResultHash = "fd".repeat(32);
    expect(
      await store.persistConnectionPendingGrant({
        attemptId: winningAttemptId,
        grantId: workspaceGrantId,
        subject: "subject",
        encryptedTokens: { nonce: "04".repeat(12), ciphertext: "05".repeat(32), keyVersion: 1 },
        resultHash: workspaceResultHash,
      }),
    ).toBe(true);
    const confirmation = await store.readConnectionConfirmationOrigin({
      resultHash: workspaceResultHash,
    });
    expect(confirmation).toMatchObject({
      organizationId: scope.organizationId,
      principalId: scope.principalId,
    });
    expect(confirmation).not.toHaveProperty("projectId");
    expect(
      await store.activateConnectionGrant({
        resultHash: workspaceResultHash,
        principalId: scope.principalId,
        sessionId: scope.sessionId,
      }),
    ).toEqual({ state: "active", grantId: workspaceGrantId });
    const activeWorkspaceGrant = await store.readActiveConnectionGrant({
      organizationId: scope.organizationId,
      principalId: scope.principalId,
      grantId: workspaceGrantId,
    });
    expect(activeWorkspaceGrant).not.toHaveProperty("projectId");
    expect(activeWorkspaceGrant).toMatchObject({ grantId: workspaceGrantId });
    expect(
      await store.listConnectionGrantMetadata({
        organizationId: scope.organizationId,
        principalId: scope.principalId,
        workspaceOnly: true,
      }),
    ).toMatchObject([{ grantId: workspaceGrantId, state: "active" }]);
    const importInput = {
      organizationId: scope.organizationId,
      principalId: scope.principalId,
      grantId: workspaceGrantId,
      projectId: p.projectId,
      environmentId: p.devEnvironmentId,
      providerOrganizationId: 123,
      teamId: 456,
      connectionId: 789,
      idempotencyKey: "import-key",
      mutationAuthority: {
        kind: "session" as const,
        sessionId: scope.sessionId,
        userId: "user_connect",
        workosOrganizationId: null,
        tokenExpiresAt: 1,
      },
    };
    const imported = await store.createConnectionImport(importInput);
    expect(imported).toMatchObject({ importId: expect.any(String) });
    expect(await store.createConnectionImport(importInput)).toEqual(imported);
    expect(
      await store.createConnectionImport({ ...importInput, idempotencyKey: "another-key" }),
    ).toEqual(imported);
    await expect(
      store.createConnectionImport({ ...importInput, connectionId: 790 }),
    ).rejects.toThrow("integration_idempotency_conflict");
    expect(
      await store.createConnectionImport({
        ...importInput,
        idempotencyKey: "other-key",
        principalId: "user:user_other",
      }),
    ).toBeNull();
    const bindingInput = {
      organizationId: scope.organizationId,
      principalId: scope.principalId,
      projectId: p.projectId,
      environmentId: p.devEnvironmentId,
      importId: required(imported).importId,
      bindingId: newUlid(),
      capabilityDigest: "ab".repeat(32),
      idempotencyKey: "binding-key",
      mutationAuthority: importInput.mutationAuthority,
      action: {
        kind: "endpoint" as const,
        appName: "example",
        appVersion: 1,
        endpointName: "create",
      },
    };
    expect(await store.createMakeActionBinding(bindingInput)).toEqual({
      bindingId: bindingInput.bindingId,
    });
    expect(await store.createMakeActionBinding(bindingInput)).toEqual({
      bindingId: bindingInput.bindingId,
    });
    await expect(
      store.createMakeActionBinding({
        ...bindingInput,
        action: { ...bindingInput.action, endpointName: "other" },
      }),
    ).rejects.toThrow("integration_idempotency_conflict");
    expect(
      await store.createMakeActionBinding({
        ...bindingInput,
        bindingId: newUlid(),
        environmentId: p.prodEnvironmentId,
        idempotencyKey: "wrong-env",
      }),
    ).toBeNull();
    const shellBinding = {
      ...bindingInput,
      bindingId: newUlid(),
      idempotencyKey: "shell-binding",
      action: {
        kind: "scenario" as const,
        scenarioId: 42,
        method: "POST" as const,
        pathPrefix: "/orders",
      },
    };
    expect(await store.createMakeActionBinding(shellBinding)).toEqual({
      bindingId: shellBinding.bindingId,
    });
    expect(
      await store.readMakeActionBinding({
        organizationId: scope.organizationId,
        bindingId: shellBinding.bindingId,
        capabilityDigest: shellBinding.capabilityDigest,
      }),
    ).toMatchObject({ action: shellBinding.action });
    for (const pathPrefix of [
      "orders",
      "//host/path",
      "/orders?x=1",
      "/orders#x",
      "/a/../b",
      "/a/./b",
      "/a/%2e%2e/b",
      "/a%252fb",
      "/a%2fb",
      "/a%5cb",
      "/a\\b",
    ]) {
      await expect(
        store.createMakeActionBinding({
          ...shellBinding,
          bindingId: newUlid(),
          idempotencyKey: `invalid-${pathPrefix}`,
          action: { ...shellBinding.action, pathPrefix },
        }),
      ).rejects.toThrow();
    }
    const bindingRef = {
      organizationId: scope.organizationId,
      bindingId: bindingInput.bindingId,
      capabilityDigest: bindingInput.capabilityDigest,
    };
    expect(await store.readMakeActionBinding(bindingRef)).toEqual({
      organizationId: scope.organizationId,
      principalId: scope.principalId,
      projectId: p.projectId,
      environmentId: p.devEnvironmentId,
      grantId: workspaceGrantId,
      providerOrganizationId: 123,
      teamId: 456,
      connectionId: 789,
      action: bindingInput.action,
    });
    expect(
      await store.readMakeActionBinding({ ...bindingRef, capabilityDigest: "ac".repeat(32) }),
    ).toBeNull();
    const execution = {
      ...bindingRef,
      executionId: "de".repeat(32),
      inputDigest: "af".repeat(32),
      grantGeneration: 1,
    };
    const admissions = await Promise.all([
      store.admitMakeActionExecution(execution),
      store.admitMakeActionExecution(execution),
    ]);
    expect(admissions.sort()).toEqual(["admitted", "running"]);
    expect(
      await store.admitMakeActionExecution({ ...execution, inputDigest: "bc".repeat(32) }),
    ).toBe("conflict");
    expect(
      await store.admitMakeActionExecution({
        ...execution,
        executionId: "df".repeat(32),
        grantGeneration: 2,
      }),
    ).toBe("denied");
    await store.finishMakeActionExecution({
      organizationId: scope.organizationId,
      bindingId: bindingInput.bindingId,
      executionId: execution.executionId,
      state: "completed",
    });
    expect(await store.admitMakeActionExecution(execution)).toBe("completed");
    expect(
      await control.core
        .prepare("SELECT count(*) AS n FROM make_action_executions WHERE binding_id=?1")
        .bind(bindingInput.bindingId)
        .first(),
    ).toEqual({ n: 1 });
    const refreshClaimId = newUlid();
    expect(
      await store.claimConnectionRefresh({ grantId: workspaceGrantId, claimId: refreshClaimId }),
    ).toMatchObject({ grantId: workspaceGrantId, generation: 1 });
    expect(
      await store.markConnectionRefreshDispatched({
        grantId: workspaceGrantId,
        claimId: refreshClaimId,
        generation: 1,
      }),
    ).toBe(true);
    expect(
      await store.commitConnectionRefresh({
        grantId: workspaceGrantId,
        claimId: refreshClaimId,
        generation: 1,
        encryptedTokens: { nonce: "04".repeat(12), ciphertext: "06".repeat(32), keyVersion: 1 },
      }),
    ).toBe(true);
    expect(
      await store.disconnectConnectionGrant({
        organizationId: scope.organizationId,
        principalId: scope.principalId,
        grantId: workspaceGrantId,
        idempotencyKey: "workspace-disconnect",
        mutationAuthority: importInput.mutationAuthority,
      }),
    ).toBe(true);
    expect(await store.createConnectionImport(importInput)).toBeNull();
    expect(await store.readMakeActionBinding(bindingRef)).toBeNull();
    expect(
      await store.admitMakeActionExecution({
        ...execution,
        executionId: "dd".repeat(32),
        grantGeneration: 2,
      }),
    ).toBe("denied");
    expect(await store.createMakeActionBinding(bindingInput)).toBeNull();
    expect(await store.listDisconnectingConnectionGrants({ limit: 100 })).toContain(
      workspaceGrantId,
    );
    const revocationClaimId = newUlid();
    expect(
      await store.claimConnectionRevocation({
        grantId: workspaceGrantId,
        claimId: revocationClaimId,
      }),
    ).toBe(true);
    expect(
      await store.markConnectionRevocationDispatched({
        grantId: workspaceGrantId,
        claimId: revocationClaimId,
      }),
    ).toBe(true);
    expect(
      await store.finishConnectionDisconnect({
        grantId: workspaceGrantId,
        claimId: revocationClaimId,
        outcome: "revoked",
      }),
    ).toBe(true);
    expect(
      await control.core
        .prepare(
          "SELECT 1 FROM workspace_connection_slots WHERE organization_id=?1 AND principal_id=?2",
        )
        .bind(scope.organizationId, scope.principalId)
        .first(),
    ).toBeNull();
    const retryAttempt =
      winningAttemptId === workspaceAttempt.attemptId ? competingAttempt : workspaceAttempt;
    expect(
      await store.claimConnectionAttempt({
        stateHash: retryAttempt.stateHash,
        cookieHash: retryAttempt.cookieHash,
        registration: scope.registration,
      }),
    ).toMatchObject({ attemptId: retryAttempt.attemptId });
    expect(
      await store.terminateConnectionAttempt({
        attemptId: retryAttempt.attemptId,
        outcome: "denied",
      }),
    ).toBe(true);
    expect(
      await control.core
        .prepare(
          "SELECT 1 FROM workspace_connection_slots WHERE organization_id=?1 AND principal_id=?2",
        )
        .bind(scope.organizationId, scope.principalId)
        .first(),
    ).toBeNull();
    expect(await store.createConnectionHandoff(scope)).toBe(true);
    const legacyClaims = await Promise.all([
      store.consumeConnectionHandoff({ handoffHash }),
      store.consumeConnectionHandoff({ handoffHash }),
    ]);
    expect(legacyClaims.filter(Boolean)).toHaveLength(1);
    expect(legacyClaims.find(Boolean)).toMatchObject({
      originatingDelegation: scope.originatingDelegation,
    });
    await expect(
      store.createConnectionAttempt({
        handoffHash,
        attemptId: newUlid(),
        stateHash,
        cookieHash,
        encryptedVerifier: { nonce: "04".repeat(12), ciphertext: "05".repeat(8193), keyVersion: 1 },
        oidcNonce: "nonce",
      }),
    ).rejects.toThrow();
    expect(
      await store.createConnectionAttempt({
        handoffHash,
        attemptId: newUlid(),
        stateHash,
        cookieHash,
        encryptedVerifier: { nonce: "04".repeat(12), ciphertext: "05".repeat(32), keyVersion: 1 },
        oidcNonce: "nonce",
      }),
    ).toBe(true);
    expect(
      await store.claimConnectionAttempt({
        stateHash,
        cookieHash: "06".repeat(32),
        registration: "make-development-2",
      }),
    ).toBeNull();
    expect(
      await store.claimConnectionAttempt({
        stateHash,
        cookieHash,
        registration: "make-development-1",
      }),
    ).toBeNull();
    const bucket = await bucketOf(p.organizationId);
    await control.core
      .prepare(
        "INSERT INTO bucket_fences(bucket,state,move_id,fenced_at) VALUES(?1,'moving',?2,?3)",
      )
      .bind(bucket, newUlid(), STORED_NOW)
      .run();
    await expect(
      store.claimConnectionAttempt({ stateHash, cookieHash, registration: "make-development-2" }),
    ).rejects.toThrow();
    await control.core.prepare("DELETE FROM bucket_fences WHERE bucket=?1").bind(bucket).run();
    const results = await Promise.all([
      store.claimConnectionAttempt({ stateHash, cookieHash, registration: "make-development-2" }),
      store.claimConnectionAttempt({ stateHash, cookieHash, registration: "make-development-2" }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const claimed = required(results.find(Boolean));
    const grantId = newUlid(),
      resultHash = "09".repeat(32);
    const tokenBytes = new TextEncoder().encode(
      JSON.stringify({ accessToken: "€".repeat(16384), refreshToken: "€".repeat(16384) }),
    );
    expect(tokenBytes.byteLength).toBeGreaterThan(98_000);
    const testKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
    ]);
    const ciphertext = Array.from(
      new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: new Uint8Array(12) },
          testKey,
          tokenBytes,
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const pending = {
      attemptId: claimed.attemptId,
      grantId,
      subject: "provider-subject",
      encryptedTokens: { nonce: "0a".repeat(12), ciphertext, keyVersion: 1 },
      resultHash,
    };
    await expect(
      store.persistConnectionPendingGrant({
        ...pending,
        encryptedTokens: { ...pending.encryptedTokens, ciphertext: "ab".repeat(262_161) },
      }),
    ).rejects.toThrow();
    const pendingResults = await Promise.all([
      store.persistConnectionPendingGrant(pending),
      store.persistConnectionPendingGrant(pending),
    ]);
    expect(pendingResults.filter(Boolean)).toHaveLength(1);
    expect(
      await store.activateConnectionGrant({
        resultHash,
        principalId: scope.principalId,
        sessionId: "another-session",
      }),
    ).toBeNull();
    const activations = await Promise.all([
      store.activateConnectionGrant({
        resultHash,
        principalId: scope.principalId,
        sessionId: scope.sessionId,
      }),
      store.activateConnectionGrant({
        resultHash,
        principalId: scope.principalId,
        sessionId: scope.sessionId,
      }),
    ]);
    expect(activations).toEqual([
      { state: "active", grantId },
      { state: "active", grantId },
    ]);
    await control.core.batch([
      control.core
        .prepare(
          "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,'user_member','member','active',1,unhex(?2),?3,'evt-member')",
        )
        .bind(p.organizationId, "00".repeat(32), STORED_NOW),
      control.core
        .prepare(
          "INSERT INTO local_authorization_grants(organization_id,grant_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,'user','user:user_member','member',?3)",
        )
        .bind(p.organizationId, newUlid(), STORED_NOW),
    ]);
    const metadata = await store.listConnectionGrantMetadata({
      organizationId: p.organizationId,
      principalId: "user:user_member",
    });
    expect(metadata).toEqual([
      { grantId, provider: "make", state: "active", createdAt: expect.any(String) },
    ]);
    expect(
      await store.listConnectionGrantMetadata({
        organizationId: newUlid(),
        principalId: "user:user_member",
      }),
    ).toEqual([]);
    // Provider denial consumes the callback once; it cannot be exchanged on replay.
    const deniedHandoff = "41".repeat(32),
      deniedAttempt = newUlid(),
      deniedState = "42".repeat(32),
      deniedCookie = "43".repeat(32);
    expect(await store.createConnectionHandoff({ ...scope, handoffHash: deniedHandoff })).toBe(
      true,
    );
    expect(await store.consumeConnectionHandoff({ handoffHash: deniedHandoff })).not.toBeNull();
    expect(
      await store.createConnectionAttempt({
        handoffHash: deniedHandoff,
        attemptId: deniedAttempt,
        stateHash: deniedState,
        cookieHash: deniedCookie,
        encryptedVerifier: { nonce: "44".repeat(12), ciphertext: "45".repeat(32), keyVersion: 1 },
        oidcNonce: "nonce",
      }),
    ).toBe(true);
    expect(
      await store.claimConnectionAttempt({
        stateHash: deniedState,
        cookieHash: deniedCookie,
        registration: scope.registration,
      }),
    ).not.toBeNull();
    expect(
      await store.terminateConnectionAttempt({ attemptId: deniedAttempt, outcome: "denied" }),
    ).toBe(true);
    expect(
      await store.terminateConnectionAttempt({ attemptId: deniedAttempt, outcome: "denied" }),
    ).toBe(false);
    expect(
      await store.claimConnectionAttempt({
        stateHash: deniedState,
        cookieHash: deniedCookie,
        registration: scope.registration,
      }),
    ).toBeNull();
    // A provider invalid_grant makes a distinct active grant reconnect-required.
    const failHandoff = "51".repeat(32),
      failAttempt = newUlid(),
      failState = "52".repeat(32),
      failCookie = "53".repeat(32),
      failGrant = newUlid(),
      failResult = "54".repeat(32);
    expect(await store.createConnectionHandoff({ ...scope, handoffHash: failHandoff })).toBe(true);
    expect(await store.consumeConnectionHandoff({ handoffHash: failHandoff })).not.toBeNull();
    expect(
      await store.createConnectionAttempt({
        handoffHash: failHandoff,
        attemptId: failAttempt,
        stateHash: failState,
        cookieHash: failCookie,
        encryptedVerifier: { nonce: "55".repeat(12), ciphertext: "56".repeat(32), keyVersion: 1 },
        oidcNonce: "nonce",
      }),
    ).toBe(true);
    expect(
      await store.claimConnectionAttempt({
        stateHash: failState,
        cookieHash: failCookie,
        registration: scope.registration,
      }),
    ).not.toBeNull();
    expect(
      await store.persistConnectionPendingGrant({
        attemptId: failAttempt,
        grantId: failGrant,
        subject: "subject",
        encryptedTokens: { nonce: "57".repeat(12), ciphertext: "58".repeat(32), keyVersion: 1 },
        resultHash: failResult,
      }),
    ).toBe(true);
    expect(
      await store.activateConnectionGrant({
        resultHash: failResult,
        principalId: scope.principalId,
        sessionId: scope.sessionId,
      }),
    ).toEqual({ state: "active", grantId: failGrant });
    const failedClaim = await store.claimConnectionRefresh({
      grantId: failGrant,
      claimId: newUlid(),
    });
    const failedFence = {
      grantId: failGrant,
      claimId: required(failedClaim).claimId,
      generation: required(failedClaim).generation,
    };
    expect(await store.markConnectionRefreshDispatched(failedFence)).toBe(true);
    expect(await store.failConnectionRefresh({ ...failedFence, outcome: "rate_limited" })).toBe(
      true,
    );
    const retried = required(
      await store.claimConnectionRefresh({ grantId: failGrant, claimId: newUlid() }),
    );
    const retryFence = {
      grantId: failGrant,
      claimId: retried.claimId,
      generation: retried.generation,
    };
    expect(await store.failConnectionRefresh({ ...failedFence, outcome: "rate_limited" })).toBe(
      false,
    );
    expect(await store.markConnectionRefreshDispatched(retryFence)).toBe(true);
    expect(await store.failConnectionRefresh({ ...retryFence, outcome: "invalid_grant" })).toBe(
      true,
    );
    expect(await store.failConnectionRefresh({ ...failedFence, outcome: "invalid_grant" })).toBe(
      false,
    );
    expect(
      await store.claimConnectionRefresh({ grantId: failGrant, claimId: newUlid() }),
    ).toBeNull();
    expect(
      await store.listConnectionGrantMetadata({
        organizationId: p.organizationId,
        principalId: "user:user_member",
      }),
    ).toContainEqual({
      grantId: failGrant,
      provider: "make",
      state: "reconnect_required",
      createdAt: expect.any(String),
    });
    const refreshClaims = await Promise.all([
      store.claimConnectionRefresh({ grantId, claimId: newUlid() }),
      store.claimConnectionRefresh({ grantId, claimId: newUlid() }),
    ]);
    const refresh = required(refreshClaims.find(Boolean));
    expect(refreshClaims.filter(Boolean)).toHaveLength(1);
    expect(refresh.encryptedTokens.ciphertext).toBe(ciphertext);
    const fence = { grantId, claimId: refresh.claimId, generation: refresh.generation };
    expect(await store.markConnectionRefreshDispatched(fence)).toBe(true);
    expect(await store.markConnectionRefreshDispatched(fence)).toBe(false);
    const replacement = { nonce: "21".repeat(12), ciphertext, keyVersion: 1 };
    expect(await store.commitConnectionRefresh({ ...fence, encryptedTokens: replacement })).toBe(
      true,
    );
    expect(await store.commitConnectionRefresh({ ...fence, encryptedTokens: replacement })).toBe(
      true,
    );
    expect(
      await store.retainConnectionRefreshOrphan({ ...fence, encryptedTokens: replacement }),
    ).toBe("committed");
    await control.core
      .prepare("UPDATE mcp_client_grants SET revoked_at=?1 WHERE grant_id=?2")
      .bind(STORED_NOW, delegatedGrantId)
      .run();
    await control.core
      .prepare(
        "INSERT INTO revocations(kind,resource_id,workos_user_id,source_event_id,effective_at) VALUES('session','session_connect','user_connect','evt-session-logout',?1)",
      )
      .bind(STORED_NOW)
      .run();
    const newScope = {
      ...scope,
      originatingDelegation: undefined,
      sessionId: "session_next",
      browserSession: { ...scope.browserSession, sessionId: "session_next" },
    };
    await control.core
      .prepare(
        "UPDATE organization_memberships SET role='member' WHERE organization_id=?1 AND workos_user_id='user_connect'",
      )
      .bind(p.organizationId)
      .run();
    expect(
      await store.listConnectionGrantMetadata({
        organizationId: p.organizationId,
        principalId: "user:user_member",
      }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ grantId, state: "reconnect_required" })]),
    );
    await expect(
      store.readActiveConnectionGrant({
        organizationId: p.organizationId,
        principalId: scope.principalId,
        grantId,
      }),
    ).rejects.toThrow();
    await expect(store.claimConnectionRefresh({ grantId, claimId: newUlid() })).rejects.toThrow();
    await control.core
      .prepare(
        "UPDATE organization_memberships SET role='owner' WHERE organization_id=?1 AND workos_user_id='user_connect'",
      )
      .bind(p.organizationId)
      .run();
    expect(
      await store.readActiveConnectionGrant({
        organizationId: p.organizationId,
        principalId: scope.principalId,
        grantId,
      }),
    ).toMatchObject({ grantId, generation: 2 });
    const second = await store.claimConnectionRefresh({ grantId, claimId: newUlid() });
    expect(second?.generation).toBe(2);
    const nextFence = {
      grantId,
      claimId: required(second).claimId,
      generation: required(second).generation,
    };
    expect(await store.markConnectionRefreshDispatched(nextFence)).toBe(true);
    const freshGrantId = crypto.randomUUID();
    await control.core
      .prepare(
        "INSERT INTO mcp_client_grants(organization_id,grant_id,user_id,client_id,consent_hash,allow_publish,revision,created_at) VALUES(?1,?2,'user_connect','client-current',?3,0,1,?4)",
      )
      .bind(p.organizationId, freshGrantId, consentHash, STORED_NOW)
      .run();
    const disconnect = {
      organizationId: p.organizationId,
      grantId,
      principalId: scope.principalId,
      idempotencyKey: "disconnect-1",
      mutationAuthority: {
        kind: "session" as const,
        sessionId: "session_disconnect",
        userId: "user_connect",
        workosOrganizationId: null,
        tokenExpiresAt: 1,
      },
    };
    expect(
      await store.disconnectConnectionGrant({
        ...disconnect,
        idempotencyKey: "restricted",
        mutationAuthority: {
          kind: "mcp",
          grantId: freshGrantId,
          clientId: "client-current",
          consentHash,
          action: "integrations:manage",
          authorizationRestriction: { projectIds: [p.projectId] },
        },
      }),
    ).toBe(false);
    expect(await store.disconnectConnectionGrant(disconnect)).toBe(true);
    expect(await store.disconnectConnectionGrant(disconnect)).toBe(true);
    expect(
      await store.disconnectConnectionGrant({
        ...disconnect,
        mutationAuthority: { ...disconnect.mutationAuthority, tokenExpiresAt: 2 },
      }),
    ).toBe(true);
    await expect(
      store.disconnectConnectionGrant({
        ...disconnect,
        mutationAuthority: { ...disconnect.mutationAuthority, sessionId: "another_session" },
      }),
    ).rejects.toThrow("integration_idempotency_conflict");
    await control.core
      .prepare(
        "INSERT INTO revocations(kind,resource_id,workos_user_id,source_event_id,effective_at) VALUES('session','session_disconnect','user_connect','evt-disconnect-logout',?1)",
      )
      .bind(STORED_NOW)
      .run();
    expect(await store.disconnectConnectionGrant(disconnect)).toBe(false);
    expect(
      await store.commitConnectionRefresh({ ...nextFence, encryptedTokens: replacement }),
    ).toBe(false);
    expect(await store.readConnectionGrantForRevocation({ grantId })).toMatchObject({
      revocationStatus: "pending",
      generation: 2,
      encryptedTokens: replacement,
    });
    const revocationClaim = newUlid();
    expect(await store.listDisconnectingConnectionGrants({ limit: 100 })).toContain(grantId);
    expect(await store.claimConnectionRevocation({ grantId, claimId: revocationClaim })).toBe(true);
    expect(await store.claimConnectionRevocation({ grantId, claimId: newUlid() })).toBe(false);
    expect(
      await store.markConnectionRevocationDispatched({ grantId, claimId: revocationClaim }),
    ).toBe(true);
    expect(
      await store.markConnectionRevocationDispatched({ grantId, claimId: revocationClaim }),
    ).toBe(false);
    expect(
      await store.finishConnectionDisconnect({
        grantId,
        claimId: revocationClaim,
        outcome: "revoked",
      }),
    ).toBe(true);
    expect(await store.readConnectionGrantForRevocation({ grantId })).toBeNull();
    expect(
      await store.readConnectionGrantStatus({
        organizationId: p.organizationId,
        principalId: scope.principalId,
        grantId,
        mutationAuthority: { ...disconnect.mutationAuthority, sessionId: "session_next" },
      }),
    ).toEqual({ state: "disconnected" });
    expect(
      await store.readConnectionGrantStatus({
        organizationId: p.organizationId,
        principalId: scope.principalId,
        grantId,
        mutationAuthority: disconnect.mutationAuthority,
      }),
    ).toBeNull();
    const rotated = { nonce: "23".repeat(12), ciphertext, keyVersion: 1 };
    expect(
      await store.retainConnectionRefreshOrphan({ ...nextFence, encryptedTokens: rotated }),
    ).toBe("retained");
    expect(
      await store.retainConnectionRefreshOrphan({ ...nextFence, encryptedTokens: rotated }),
    ).toBe("retained");
    expect(
      await store.readConnectionRefreshOrphan({ grantId, claimId: nextFence.claimId }),
    ).toMatchObject({ generation: 3, state: "revocation_pending", encryptedTokens: rotated });
    expect(await store.listConnectionRefreshOrphans({ limit: 100 })).toContainEqual({
      grantId,
      claimId: nextFence.claimId,
    });
    const rotatedRevoke = { grantId, claimId: nextFence.claimId, revocationClaimId: newUlid() };
    expect(await store.claimConnectionRefreshOrphanRevocation(rotatedRevoke)).toBe(true);
    expect(await store.markConnectionRefreshOrphanRevocationDispatched(rotatedRevoke)).toBe(true);
    expect(
      await store.finishConnectionRefreshOrphanRevocation({
        ...rotatedRevoke,
        outcome: "outcome_unknown",
      }),
    ).toBe(true);
    expect(
      await store.claimConnectionRefreshOrphanRevocation({
        ...rotatedRevoke,
        revocationClaimId: newUlid(),
      }),
    ).toBe(false);
    const pendingClaim = "7" + "Z".repeat(25);
    await control.core.batch([
      ...Array.from({ length: 30 }, (_, index) =>
        control.core
          .prepare(
            "INSERT INTO connection_refresh_orphans(grant_id,claim_id,previous_generation,token_nonce,token_ciphertext,key_version,state,created_at) VALUES(?1,?2,2,'aa','bb',1,'outcome_unknown',?3)",
          )
          .bind(grantId, "0".repeat(24) + String(index).padStart(2, "0"), STORED_NOW),
      ),
      control.core
        .prepare(
          "INSERT INTO connection_refresh_orphans(grant_id,claim_id,previous_generation,token_nonce,token_ciphertext,key_version,state,created_at) VALUES(?1,?2,2,'aa','bb',1,'revocation_pending',?3)",
        )
        .bind(grantId, pendingClaim, STORED_NOW),
    ]);
    expect(await store.listConnectionRefreshOrphans({ limit: 1 })).toEqual([
      { grantId, claimId: pendingClaim },
    ]);
    const workosOrg = required(
      await control.core
        .prepare("SELECT workos_organization_id FROM organizations WHERE organization_id=?1")
        .bind(p.organizationId)
        .first<{ workos_organization_id: string }>(),
    ).workos_organization_id;
    const origin = {
      kind: "api_key" as const,
      keyId: "api_key_test",
      userId: "user_connect",
      workosOrganizationId: workosOrg,
      authorizationRestriction: {
        actions: ["integrations:manage" as const],
        organizationIds: [p.organizationId],
      },
    };
    const originHash = "0c".repeat(32);
    expect(
      await store.createConnectionHandoff({
        ...newScope,
        handoffHash: originHash,
        originatingCredential: origin,
      }),
    ).toBe(true);
    expect(await store.consumeConnectionHandoff({ handoffHash: originHash })).toMatchObject({
      browserSession: newScope.browserSession,
      originatingCredential: origin,
    });
    await expect(
      store.createConnectionHandoff({
        ...newScope,
        handoffHash: "0d".repeat(32),
        originatingCredential: {
          ...origin,
          authorizationRestriction: { projectIds: [p.projectId] },
        },
      }),
    ).rejects.toThrow();
    await expect(
      store.createConnectionHandoff({
        ...newScope,
        handoffHash: "0e".repeat(32),
        originatingCredential: { ...origin, userId: "user_other" },
      }),
    ).rejects.toThrow();
    expect(
      await store.createConnectionHandoff({
        ...newScope,
        handoffHash: "07".repeat(32),
        organizationId: newUlid(),
      }),
    ).toBe(false);
    const orphanAttemptId = newUlid(),
      orphanState = "12".repeat(32),
      orphanCookie = "13".repeat(32);
    expect(
      await store.createConnectionAttempt({
        handoffHash: originHash,
        attemptId: orphanAttemptId,
        stateHash: orphanState,
        cookieHash: orphanCookie,
        encryptedVerifier: { nonce: "14".repeat(12), ciphertext: "15".repeat(32), keyVersion: 1 },
        oidcNonce: "nonce",
      }),
    ).toBe(true);
    expect(
      await store.claimConnectionAttempt({
        stateHash: orphanState,
        cookieHash: orphanCookie,
        registration: scope.registration,
      }),
    ).not.toBeNull();
    const abandonedHash = "30".repeat(32),
      abandonedState = "31".repeat(32),
      abandonedCookie = "32".repeat(32),
      abandonedAttempt = newUlid(),
      abandonedGrant = newUlid(),
      abandonedResult = "33".repeat(32);
    expect(await store.createConnectionHandoff({ ...newScope, handoffHash: abandonedHash })).toBe(
      true,
    );
    expect(await store.consumeConnectionHandoff({ handoffHash: abandonedHash })).not.toBeNull();
    expect(
      await store.createConnectionAttempt({
        handoffHash: abandonedHash,
        attemptId: abandonedAttempt,
        stateHash: abandonedState,
        cookieHash: abandonedCookie,
        encryptedVerifier: { nonce: "34".repeat(12), ciphertext: "35".repeat(32), keyVersion: 1 },
        oidcNonce: "nonce",
      }),
    ).toBe(true);
    expect(
      await store.claimConnectionAttempt({
        stateHash: abandonedState,
        cookieHash: abandonedCookie,
        registration: newScope.registration,
      }),
    ).not.toBeNull();
    expect(
      await store.persistConnectionPendingGrant({
        attemptId: abandonedAttempt,
        grantId: abandonedGrant,
        subject: "subject",
        encryptedTokens: { nonce: "36".repeat(12), ciphertext: "37".repeat(32), keyVersion: 1 },
        resultHash: abandonedResult,
      }),
    ).toBe(true);
    await control.core
      .prepare(
        "UPDATE connection_grants SET confirmation_expires_at='2020-01-01T00:00:00.000000Z' WHERE grant_id=?1",
      )
      .bind(abandonedGrant)
      .run();
    expect(await store.listExpiredConnectionGrants({ limit: 100 })).toContain(abandonedGrant);
    expect(await store.claimExpiredConnectionGrant({ grantId: abandonedGrant })).toBe(true);
    expect(await store.claimExpiredConnectionGrant({ grantId: abandonedGrant })).toBe(false);
    expect(
      await store.activateConnectionGrant({
        resultHash: abandonedResult,
        principalId: newScope.principalId,
        sessionId: newScope.sessionId,
      }),
    ).toBeNull();
    expect(await store.readConnectionGrantForRevocation({ grantId: abandonedGrant })).toMatchObject(
      { revocationStatus: "pending" },
    );
    await control.core
      .prepare(
        "UPDATE organization_memberships SET state='revoked' WHERE organization_id=?1 AND workos_user_id='user_connect'",
      )
      .bind(p.organizationId)
      .run();
    const orphan = {
      attemptId: orphanAttemptId,
      grantId: newUlid(),
      subject: null,
      encryptedTokens: { nonce: "16".repeat(12), ciphertext, keyVersion: 1 },
    };
    expect(
      await store.persistConnectionPendingGrant({
        ...orphan,
        subject: "subject",
        resultHash: "18".repeat(32),
      }),
    ).toBe(false);
    expect(await store.retainConnectionOrphan(orphan)).toBe(true);
    expect(await store.retainConnectionOrphan(orphan)).toBe(true);
    expect(await store.readConnectionOrphan({ attemptId: orphanAttemptId })).toMatchObject({
      state: "revocation_pending",
      subject: null,
      encryptedTokens: orphan.encryptedTokens,
    });
    const orphanClaimId = newUlid();
    expect(await store.listConnectionOrphans({ limit: 100 })).toContain(orphanAttemptId);
    expect(
      await store.claimConnectionOrphanRevocation({
        attemptId: orphanAttemptId,
        claimId: orphanClaimId,
      }),
    ).toBe(true);
    expect(
      await store.markConnectionOrphanRevocationDispatched({
        attemptId: orphanAttemptId,
        claimId: orphanClaimId,
      }),
    ).toBe(true);
    expect(
      await store.finishConnectionOrphanRevocation({
        attemptId: orphanAttemptId,
        claimId: orphanClaimId,
        outcome: "outcome_unknown",
      }),
    ).toBe(true);
    expect(
      await store.claimConnectionOrphanRevocation({
        attemptId: orphanAttemptId,
        claimId: newUlid(),
      }),
    ).toBe(false);
    expect(await store.readConnectionOrphan({ attemptId: orphanAttemptId })).toMatchObject({
      state: "outcome_unknown",
    });
    // A bounded sweep must reach actionable work even with many older uncertain outcomes.
    const morePending = "7" + "Y".repeat(25);
    const seedStatements = Array.from({ length: 31 }, (_, index) => {
      const identity = index === 30 ? morePending : "0".repeat(24) + String(index).padStart(2, "0");
      const handoff = (index + 2000).toString(16).padStart(64, "0"),
        state = (index + 3000).toString(16).padStart(64, "0"),
        result = (index + 4000).toString(16).padStart(64, "0");
      return [
        control.core
          .prepare(
            "INSERT INTO connection_handoffs(handoff_hash,organization_id,project_id,environment_id,principal_id,session_id,browser_session,registration,originating_delegation,originating_credential,ownership_version,billing_epoch_id,created_at,expires_at) SELECT ?1,organization_id,project_id,environment_id,principal_id,session_id,browser_session,registration,originating_delegation,originating_credential,ownership_version,billing_epoch_id,created_at,expires_at FROM connection_handoffs WHERE handoff_hash=?2",
          )
          .bind(handoff, handoffHash),
        control.core
          .prepare(
            "INSERT INTO connection_attempts(attempt_id,handoff_hash,state_hash,cookie_hash,verifier_nonce,verifier_ciphertext,key_version,oidc_nonce,state,created_at,expires_at) SELECT ?1,?2,?3,cookie_hash,verifier_nonce,verifier_ciphertext,key_version,oidc_nonce,'outcome_unknown',created_at,expires_at FROM connection_attempts WHERE attempt_id=?4",
          )
          .bind(identity, handoff, state, claimed.attemptId),
        control.core
          .prepare(
            "INSERT INTO connection_orphan_grants(attempt_id,grant_id,subject,token_nonce,token_ciphertext,key_version,state,created_at) VALUES(?1,?1,NULL,'aa','bb',1,?2,?3)",
          )
          .bind(identity, index === 30 ? "revocation_pending" : "outcome_unknown", STORED_NOW),
        control.core
          .prepare(
            "INSERT INTO connection_grants(grant_id,attempt_id,subject,token_nonce,token_ciphertext,key_version,generation,result_hash,state,confirmation_expires_at,created_at,revocation_status) VALUES(?1,?1,'subject','aa','bb',1,1,?2,'disconnecting',?3,?3,?4)",
          )
          .bind(identity, result, STORED_NOW, index === 30 ? "pending" : "outcome_unknown"),
      ];
    }).flat();
    await control.core
      .prepare("UPDATE connection_grants SET revocation_status='outcome_unknown' WHERE grant_id=?1")
      .bind(abandonedGrant)
      .run();
    for (let start = 0; start < seedStatements.length; start += 40)
      await control.core.batch(seedStatements.slice(start, start + 40));
    expect(await store.listConnectionOrphans({ limit: 1 })).toEqual([morePending]);
    expect(await store.listDisconnectingConnectionGrants({ limit: 1 })).toEqual([morePending]);

    expect(
      await store.createConnectionHandoff({
        ...newScope,
        handoffHash: "08".repeat(32),
      }),
    ).toBe(false);
  } finally {
    await control.dispose();
  }
}, 120_000);

test("protected portal handoff retains origin, permits only the initiating human and consumes once", async () => {
  const control = await createTestControl();
  try {
    const p = await seedProject(control);
    const selectedWorkspace = await seedProject(control);
    await control.core.batch([
      control.core
        .prepare("UPDATE organizations SET beta_admitted_at=?2 WHERE organization_id=?1")
        .bind(p.organizationId, STORED_NOW),
      control.core
        .prepare(
          "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,'user_portal','owner','active',1,unhex(?2),?3,'evt')",
        )
        .bind(p.organizationId, "00".repeat(32), STORED_NOW),
      control.core
        .prepare(
          "INSERT INTO local_authorization_grants(organization_id,grant_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,'user','user:user_portal','owner',?3)",
        )
        .bind(p.organizationId, newUlid(), STORED_NOW),
    ]);
    const org = required(
      await control.core
        .prepare("SELECT workos_organization_id AS id FROM organizations WHERE organization_id=?1")
        .bind(p.organizationId)
        .first<{ id: string }>(),
    ).id;
    await control.core.batch([
      control.core
        .prepare("UPDATE organizations SET beta_admitted_at=?2 WHERE organization_id=?1")
        .bind(selectedWorkspace.organizationId, STORED_NOW),
      control.core
        .prepare(
          "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,'user_portal','owner','active',1,unhex(?2),?3,'evt-selected')",
        )
        .bind(selectedWorkspace.organizationId, "00".repeat(32), STORED_NOW),
      control.core
        .prepare(
          "INSERT INTO local_authorization_grants(organization_id,grant_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,'user','user:user_portal','owner',?3)",
        )
        .bind(selectedWorkspace.organizationId, newUlid(), STORED_NOW),
    ]);
    const selectedOrg = required(
      await control.core
        .prepare("SELECT workos_organization_id AS id FROM organizations WHERE organization_id=?1")
        .bind(selectedWorkspace.organizationId)
        .first<{ id: string }>(),
    ).id;
    const s = createControlStore(control.bindings).connections;
    const input = {
      handoffHash: "ab".repeat(32),
      organizationId: p.organizationId,
      projectId: p.projectId,
      environmentId: p.devEnvironmentId,
      principalId: "user:user_portal",
      registration: "make-development-1",
      credentialId: "api_key_portal",
      idempotencyKeyHash: "cd".repeat(32),
      requestDigest: "ef".repeat(32),
      originatingCredential: {
        kind: "api_key" as const,
        keyId: "api_key_portal",
        userId: "user_portal",
        workosOrganizationId: org,
      },
    };
    const { projectId: _projectId, environmentId: _environmentId, ...workspaceScope } = input;
    void _projectId;
    void _environmentId;
    const workspaceInput = {
      ...workspaceScope,
      handoffHash: "aa".repeat(32),
      idempotencyKeyHash: "bb".repeat(32),
    };
    expect(await s.createIntegrationPortalHandoff(workspaceInput)).toBe("created");
    expect(await s.createIntegrationPortalHandoff(workspaceInput)).toBe("replay");
    const workspaceHandoff = await s.consumeIntegrationPortalHandoff({
      handoffHash: workspaceInput.handoffHash,
      principalId: workspaceInput.principalId,
    });
    expect(workspaceHandoff).toMatchObject({ organizationId: p.organizationId });
    expect(workspaceHandoff).not.toHaveProperty("projectId");
    expect(workspaceHandoff).not.toHaveProperty("environmentId");
    expect(await s.createIntegrationPortalHandoff(input)).toBe("created");
    expect(await s.createIntegrationPortalHandoff(input)).toBe("replay");
    expect(await s.createIntegrationPortalHandoff({ ...input, handoffHash: "11".repeat(32) })).toBe(
      "conflict",
    );
    expect(
      await s.readIntegrationPortalHandoff({
        handoffHash: input.handoffHash,
        principalId: "user:user_other",
      }),
    ).toBeNull();
    expect(
      await s.readIntegrationPortalHandoff({
        handoffHash: input.handoffHash,
        principalId: input.principalId,
      }),
    ).toMatchObject({ userId: "user_portal", originatingCredential: input.originatingCredential });
    const results = await Promise.all([
      s.consumeIntegrationPortalHandoff({
        handoffHash: input.handoffHash,
        principalId: input.principalId,
      }),
      s.consumeIntegrationPortalHandoff({
        handoffHash: input.handoffHash,
        principalId: input.principalId,
      }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await s.readIntegrationPortalStatus({
        handoffHash: input.handoffHash,
        principalId: input.principalId,
        credentialId: "api_key_other",
      }),
    ).toBeNull();
    expect(
      await s.readIntegrationPortalStatus({
        handoffHash: input.handoffHash,
        principalId: input.principalId,
        credentialId: input.credentialId,
      }),
    ).toMatchObject({ state: "consumed" });
    const sessionOrigin = {
      kind: "session" as const,
      sessionId: "device_session_1",
      userId: "user_portal",
      workosOrganizationId: selectedOrg,
      tokenExpiresAt: 1800000000,
    };
    const device = {
      ...input,
      handoffHash: "81".repeat(32),
      idempotencyKeyHash: "82".repeat(32),
      requestDigest: "83".repeat(32),
      credentialId: sessionOrigin.sessionId,
      originatingCredential: sessionOrigin,
    };
    await expect(
      s.createIntegrationPortalHandoff({
        ...input,
        handoffHash: "b1".repeat(32),
        idempotencyKeyHash: "b2".repeat(32),
        originatingCredential: {
          ...input.originatingCredential,
          workosOrganizationId: selectedOrg,
        },
      }),
    ).rejects.toThrow();
    await expect(
      s.createIntegrationPortalHandoff({
        ...device,
        handoffHash: "b3".repeat(32),
        idempotencyKeyHash: "b4".repeat(32),
        originatingCredential: {
          ...sessionOrigin,
          authorizationRestriction: { organizationIds: [selectedWorkspace.organizationId] },
        },
      }),
    ).rejects.toThrow();
    await control.core
      .prepare(
        "UPDATE organization_memberships SET role='member' WHERE organization_id=?1 AND workos_user_id='user_portal'",
      )
      .bind(p.organizationId)
      .run();
    await expect(
      s.createIntegrationPortalHandoff({
        ...device,
        handoffHash: "b5".repeat(32),
        idempotencyKeyHash: "b6".repeat(32),
      }),
    ).rejects.toThrow();
    await control.core
      .prepare(
        "UPDATE organization_memberships SET role='owner' WHERE organization_id=?1 AND workos_user_id='user_portal'",
      )
      .bind(p.organizationId)
      .run();
    expect(await s.createIntegrationPortalHandoff(device)).toBe("created");
    await expect(
      s.createIntegrationPortalHandoff({
        ...device,
        handoffHash: "a1".repeat(32),
        idempotencyKeyHash: "a2".repeat(32),
        originatingCredential: { ...sessionOrigin, userId: "user_other" },
      }),
    ).rejects.toThrow();
    await expect(
      s.createIntegrationPortalHandoff({
        ...device,
        handoffHash: "a3".repeat(32),
        idempotencyKeyHash: "a4".repeat(32),
        originatingCredential: {
          ...sessionOrigin,
          authorizationRestriction: { projectIds: [p.projectId] },
        },
      }),
    ).rejects.toThrow();

    expect(
      await s.createIntegrationPortalHandoff({
        ...device,
        originatingCredential: { ...sessionOrigin, tokenExpiresAt: 1900000000 },
      }),
    ).toBe("replay");
    expect(
      await s.createIntegrationPortalHandoff({
        ...device,
        originatingCredential: {
          ...sessionOrigin,
          authorizationRestriction: { actions: ["integrations:manage"] },
        },
      }),
    ).toBe("conflict");
    expect(
      await s.readIntegrationPortalStatus({
        handoffHash: device.handoffHash,
        principalId: device.principalId,
        credentialId: sessionOrigin.sessionId,
      }),
    ).toMatchObject({ state: "pending", originatingCredential: sessionOrigin });
    const accepted = await s.consumeIntegrationPortalHandoff({
      handoffHash: device.handoffHash,
      principalId: device.principalId,
    });
    expect(accepted).toMatchObject({ originatingCredential: sessionOrigin });
    const browserSession = {
      sessionId: "different_browser_session",
      userId: "user_portal",
      organizationId: selectedOrg,
      tokenExpiresAt: 1900000000,
    };
    const browserHandoff = "84".repeat(32),
      attemptId = newUlid(),
      stateHash = "85".repeat(32),
      cookieHash = "86".repeat(32);
    expect(
      await s.createConnectionHandoff({
        organizationId: p.organizationId,
        projectId: p.projectId,
        environmentId: p.devEnvironmentId,
        principalId: device.principalId,
        sessionId: browserSession.sessionId,
        browserSession,
        handoffHash: browserHandoff,
        registration: device.registration,
        originatingCredential: sessionOrigin,
      }),
    ).toBe(true);
    expect(await s.consumeConnectionHandoff({ handoffHash: browserHandoff })).toMatchObject({
      browserSession,
      originatingCredential: sessionOrigin,
    });
    expect(
      await s.createConnectionAttempt({
        handoffHash: browserHandoff,
        attemptId,
        stateHash,
        cookieHash,
        encryptedVerifier: { nonce: "87".repeat(12), ciphertext: "88".repeat(32), keyVersion: 1 },
        oidcNonce: "nonce",
      }),
    ).toBe(true);
    expect(
      await s.claimConnectionAttempt({ stateHash, cookieHash, registration: "make-development-2" }),
    ).toBeNull();
    expect(
      await s.claimConnectionAttempt({ stateHash, cookieHash, registration: device.registration }),
    ).toMatchObject({ originatingCredential: sessionOrigin });
    const connectedGrant = newUlid(),
      resultHash = "89".repeat(32);
    expect(
      await s.persistConnectionPendingGrant({
        attemptId,
        grantId: connectedGrant,
        subject: "subject",
        encryptedTokens: { nonce: "8a".repeat(12), ciphertext: "8b".repeat(32), keyVersion: 1 },
        resultHash,
      }),
    ).toBe(true);
    const preclaimHandoff = "8c".repeat(32),
      preclaimAttempt = newUlid(),
      preclaimState = "8d".repeat(32),
      preclaimCookie = "8e".repeat(32);
    expect(
      await s.createConnectionHandoff({
        organizationId: p.organizationId,
        projectId: p.projectId,
        environmentId: p.devEnvironmentId,
        principalId: device.principalId,
        sessionId: browserSession.sessionId,
        browserSession,
        handoffHash: preclaimHandoff,
        registration: device.registration,
        originatingCredential: sessionOrigin,
      }),
    ).toBe(true);
    expect(await s.consumeConnectionHandoff({ handoffHash: preclaimHandoff })).not.toBeNull();
    expect(
      await s.createConnectionAttempt({
        handoffHash: preclaimHandoff,
        attemptId: preclaimAttempt,
        stateHash: preclaimState,
        cookieHash: preclaimCookie,
        encryptedVerifier: { nonce: "8f".repeat(12), ciphertext: "90".repeat(32), keyVersion: 1 },
        oidcNonce: "nonce",
      }),
    ).toBe(true);
    await control.core
      .prepare(
        "INSERT INTO revocations(kind,resource_id,workos_user_id,source_event_id,effective_at) VALUES('session',?1,'user_portal','evt-device-revoke',?2)",
      )
      .bind(sessionOrigin.sessionId, STORED_NOW)
      .run();
    await expect(
      s.claimConnectionAttempt({
        stateHash: preclaimState,
        cookieHash: preclaimCookie,
        registration: device.registration,
      }),
    ).rejects.toThrow();
    await expect(
      s.activateConnectionGrant({
        resultHash,
        principalId: device.principalId,
        sessionId: browserSession.sessionId,
      }),
    ).rejects.toThrow();
    await expect(
      s.readIntegrationPortalStatus({
        handoffHash: device.handoffHash,
        principalId: device.principalId,
        credentialId: sessionOrigin.sessionId,
      }),
    ).rejects.toThrow();
    const secondOrigin = { ...sessionOrigin, sessionId: "device_session_2" };
    const secondDevice = {
      ...device,
      handoffHash: "91".repeat(32),
      idempotencyKeyHash: "92".repeat(32),
      requestDigest: "93".repeat(32),
      credentialId: secondOrigin.sessionId,
      originatingCredential: secondOrigin,
    };
    expect(await s.createIntegrationPortalHandoff(secondDevice)).toBe("created");
    expect(
      await s.consumeIntegrationPortalHandoff({
        handoffHash: secondDevice.handoffHash,
        principalId: secondDevice.principalId,
      }),
    ).toMatchObject({ originatingCredential: secondOrigin });
    const secondHandoff = "94".repeat(32),
      secondAttempt = newUlid(),
      secondState = "95".repeat(32),
      secondCookie = "96".repeat(32),
      secondGrant = newUlid(),
      secondResult = "97".repeat(32);
    expect(
      await s.createConnectionHandoff({
        organizationId: p.organizationId,
        projectId: p.projectId,
        environmentId: p.devEnvironmentId,
        principalId: secondDevice.principalId,
        sessionId: browserSession.sessionId,
        browserSession,
        handoffHash: secondHandoff,
        registration: secondDevice.registration,
        originatingCredential: secondOrigin,
      }),
    ).toBe(true);
    expect(await s.consumeConnectionHandoff({ handoffHash: secondHandoff })).not.toBeNull();
    expect(
      await s.createConnectionAttempt({
        handoffHash: secondHandoff,
        attemptId: secondAttempt,
        stateHash: secondState,
        cookieHash: secondCookie,
        encryptedVerifier: { nonce: "98".repeat(12), ciphertext: "99".repeat(32), keyVersion: 1 },
        oidcNonce: "nonce",
      }),
    ).toBe(true);
    expect(
      await s.claimConnectionAttempt({
        stateHash: secondState,
        cookieHash: secondCookie,
        registration: secondDevice.registration,
      }),
    ).not.toBeNull();
    expect(
      await s.persistConnectionPendingGrant({
        attemptId: secondAttempt,
        grantId: secondGrant,
        subject: "subject",
        encryptedTokens: { nonce: "9a".repeat(12), ciphertext: "9b".repeat(32), keyVersion: 1 },
        resultHash: secondResult,
      }),
    ).toBe(true);
    expect(
      await s.activateConnectionGrant({
        resultHash: secondResult,
        principalId: secondDevice.principalId,
        sessionId: browserSession.sessionId,
      }),
    ).toEqual({ state: "active", grantId: secondGrant });
    await control.core
      .prepare(
        "INSERT INTO revocations(kind,resource_id,workos_user_id,source_event_id,effective_at) VALUES('session',?1,'user_portal','evt-device-revoke-2',?2)",
      )
      .bind(secondOrigin.sessionId, STORED_NOW)
      .run();
    expect(
      await s.readActiveConnectionGrant({
        organizationId: p.organizationId,
        principalId: secondDevice.principalId,
        grantId: secondGrant,
      }),
    ).toMatchObject({ grantId: secondGrant });
    const disconnectScope = {
      organizationId: p.organizationId,
      principalId: secondDevice.principalId,
      grantId: secondGrant,
      idempotencyKey: "workspace-b-disconnect",
    };
    const sessionAuthority = {
      kind: "session" as const,
      sessionId: browserSession.sessionId,
      userId: browserSession.userId,
      workosOrganizationId: selectedOrg,
      tokenExpiresAt: browserSession.tokenExpiresAt,
    };
    expect(
      await s.disconnectConnectionGrant({
        ...disconnectScope,
        mutationAuthority: {
          kind: "api_key",
          keyId: "api_key_other",
          userId: "user_portal",
          workosOrganizationId: selectedOrg,
        },
      }),
    ).toBe(false);
    expect(
      await s.disconnectConnectionGrant({
        ...disconnectScope,
        mutationAuthority: {
          ...sessionAuthority,
          authorizationRestriction: { organizationIds: [selectedWorkspace.organizationId] },
        },
      }),
    ).toBe(false);
    expect(
      await s.disconnectConnectionGrant({
        ...disconnectScope,
        mutationAuthority: { ...sessionAuthority, userId: "user_other" },
      }),
    ).toBe(false);
    await control.core
      .prepare(
        "UPDATE organization_memberships SET role='member' WHERE organization_id=?1 AND workos_user_id='user_portal'",
      )
      .bind(p.organizationId)
      .run();
    expect(
      await s.disconnectConnectionGrant({
        ...disconnectScope,
        mutationAuthority: sessionAuthority,
      }),
    ).toBe(false);
    await control.core
      .prepare(
        "UPDATE organization_memberships SET role='owner' WHERE organization_id=?1 AND workos_user_id='user_portal'",
      )
      .bind(p.organizationId)
      .run();
    expect(
      await s.disconnectConnectionGrant({
        ...disconnectScope,
        mutationAuthority: sessionAuthority,
      }),
    ).toBe(true);
  } finally {
    await control.dispose();
  }
}, 120_000);
