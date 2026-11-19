import { createRequire, builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { OperationAuthorizationConflictError } from "@ohmyhost/database";
import { parseUlid } from "@ohmyhost/platform";
import {
  createD1RemoteMcpPersistence,
  isD1RemoteMcpRuntime,
  type D1RemoteMcpRuntime,
} from "../src/d1-remote-mcp-persistence.js";
import { createRemoteMcpComposition } from "../src/remote-mcp-composition.js";
import {
  migrate,
  activateTestCore,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { seedProject, ulidOf } from "../../control-store/test/support/platform-fixtures.js";
import type { D1Database } from "../../control-store/src/d1-types.js";

const METHODS = [
  "insertMcpHandoff",
  "findMcpHandoff",
  "consumeMcpHandoff",
  "completeMcpSecret",
  "readNativeProviderHandoffState",
  "claimNativeProviderHandoff",
  "completeNativeProviderHandoff",
  "completeMcpGithub",
  "revokeMcpConsent",
  "readMcpEnvironmentName",
  "readMcpAuthorizedMemberships",
  "ensureMcpConnectionProof",
  "readMcpMailDomainOrganization",
  "readMcpProjectOrganization",
  "readMcpGrantRevision",
  "readMcpRecoveryContext",
  "authorizeMcpExecution",
  "readMcpPlanEnvironmentName",
];
async function bundle(contents: string) {
  const result = await build({
    stdin: {
      contents,
      resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2024",
    conditions: ["source", "workerd", "worker", "browser"],
    mainFields: ["browser", "module", "main"],
    external: ["cloudflare:workers", "node:*"],
    write: false,
    logLevel: "error",
    banner: {
      js: 'import {createRequire as __r} from "node:module"; const require=__r("file:///fixture.mjs");',
    },
    plugins: [
      {
        name: "node-builtins",
        setup(builder) {
          builder.onResolve({ filter: /^[^.:/][^:]*$/ }, (args) =>
            builtinModules.includes(args.path)
              ? { path: `node:${args.path}`, external: true }
              : undefined,
          );
        },
      },
    ],
  });
  if (!result.outputFiles[0]) throw new Error("Fixture bundle missing");
  return result.outputFiles[0].text;
}
interface Harness {
  getD1Database(name: string, worker: string): Promise<unknown>;
  getWorker(name: string): Promise<{ fetch(url: string, init?: RequestInit): Promise<Response> }>;
  dispose(): Promise<void>;
}

it("uses actual Core RPC for original MCP consent and metadata reads, signed Connect scope and terminal revocation", async () => {
  const require = createRequire(import.meta.url),
    { Miniflare } = createRequire(require.resolve("../../control-store/package.json"))(
      "miniflare",
    ) as { Miniflare: new (options: unknown) => Harness };
  const mf = new Miniflare({
    workers: [
      {
        name: "core",
        modules: true,
        script: await bundle(
          'export {ControlRuntime} from "./apps/control-store/src/worker-main.ts";export default{fetch(){return new Response("private")}}',
        ),
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: { CONTROL_CORE: "mcp-core" },
      },
      {
        name: "bridge",
        modules: true,
        compatibilityDate: "2026-08-06",
        script: `const methods=${JSON.stringify(METHODS)};export default{async fetch(request,env){const {method,input}=await request.json();if(!methods.includes(method))return new Response(null,{status:404});try{return Response.json({value:await env.CORE[method](input)??null});}catch(error){return Response.json({error:error instanceof Error?error.message:'MCP unavailable'},{status:409});}}};`,
        serviceBindings: { CORE: { name: "core", entrypoint: "ControlRuntime" } },
      },
    ],
  });
  try {
    const db = (await mf.getD1Database("CONTROL_CORE", "core")) as D1Database;
    await migrate(db, "core");
    await activateTestCore(db);
    const control: TestControl = {
        core: db,
        directory: db,
        bindings: { CONTROL_CORE: db },
        shards: { CONTROL_SHARD_0000: db },
        dispose: async () => {},
      },
      p = await seedProject(control),
      now = "2026-10-29T07:00:00.000Z",
      userId = "user_mcpnative";
    await db
      .prepare("UPDATE organizations SET beta_admitted_at=?2 WHERE organization_id=?1")
      .bind(p.organizationId, "2026-10-28T10:00:00.000000Z")
      .run();
    await db
      .prepare(
        "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,?2,'owner','active',1,zeroblob(32),'2026-10-28T10:00:00.000000Z','event_mcp')",
      )
      .bind(p.organizationId, userId)
      .run();
    await db
      .prepare(
        "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user',?3,'owner',?4)",
      )
      .bind(
        p.organizationId,
        ulidOf("native-grant", 1),
        `user:${userId}`,
        "2026-10-29T07:00:00.000000Z",
      )
      .run();
    const bridge = await mf.getWorker("bridge"),
      runtime = Object.fromEntries(
        METHODS.map((method) => [
          method,
          async (input: unknown) => {
            const response = await bridge.fetch("https://fixture/rpc", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ method, input }),
              }),
              result = (await response.json()) as { value?: unknown; error?: string };
            if (!response.ok) throw new Error(result.error);
            return result.value;
          },
        ]),
      ) as unknown as D1RemoteMcpRuntime;
    expect(isD1RemoteMcpRuntime(runtime)).toBe(true);
    expect(isD1RemoteMcpRuntime({})).toBe(false);
    const target = createD1RemoteMcpPersistence(runtime),
      identity = {
        organizationId: p.organizationId,
        userId,
        clientId: "client_native",
        consentHash: createHash("sha256").update("app_consent_native").digest("hex"),
      },
      handoff = {
        ...identity,
        requestHash: "a".repeat(64),
        kind: "grant" as const,
        projectIds: [p.projectId],
        allowCreate: true,
        allowPublish: true,
        secretTarget: null,
        createdAt: now,
        expiresAt: "2026-10-29T08:00:00.000Z",
        consumedAt: null,
        outcome: null,
      };
    const port = target;
    expect(
      await port.authorizedMemberships({
        userId: identity.userId,
        clientId: identity.clientId,
        consentHash: identity.consentHash,
      }),
    ).toMatchObject({ disconnected: false, organizationIds: [p.organizationId] });
    const grant = await port.store.ensureConnectionProof(identity, p.projectId, now);
    if (!grant) throw new Error("Connection proof absent");
    expect(
      await port.environmentName({
        organizationId: p.organizationId,
        projectId: p.projectId,
        environmentId: p.prodEnvironmentId,
      }),
    ).toBe("prod");
    expect(await port.projectOrganization(p.projectId, true)).toBe(p.organizationId);
    expect(await port.projectOrganization(p.projectId, false)).toBe(p.organizationId);
    expect(await port.grantRevision(grant.grantId)).toBe("1");
    expect(await port.planEnvironmentName(ulidOf("absent-plan", 1), p.projectId)).toBeNull();
    expect(await port.recoveryContext(ulidOf("absent-op", 2), [p.organizationId])).toEqual([]);
    await port.authorizeExecution({
      organizationId: p.organizationId,
      projectId: p.projectId,
      operationId: ulidOf("absent-op", 2),
    });
    const changed = createD1RemoteMcpPersistence({
      ...runtime,
      authorizeMcpExecution: async () => {
        throw Object.assign(new Error("Queued operation authorization changed"), {
          code: "operation_authorization_changed",
        });
      },
    });
    await expect(
      changed.authorizeExecution({
        organizationId: p.organizationId,
        projectId: p.projectId,
        operationId: ulidOf("absent-op", 3),
      }),
    ).rejects.toBeInstanceOf(OperationAuthorizationConflictError);
    for (const kind of ["secret", "github"] as const) {
      const handoffGrant = await port.store.ensureConnectionProof(
        identity,
        kind === "secret" ? p.projectId : null,
        now,
      );
      if (!handoffGrant) throw new Error("Handoff proof absent");
      const item = {
        ...handoff,
        requestHash: (kind === "secret" ? "b" : "c").repeat(64),
        kind,
        authority: {
          grantId: handoffGrant.grantId,
          clientId: handoffGrant.clientId,
          consentHash: handoffGrant.consentHash,
          action: kind === "secret" ? ("secrets:write" as const) : ("sources:link" as const),
        },
        expiresAt: "2026-10-29T07:10:00.000Z",
        projectIds: kind === "secret" ? [p.projectId] : [],
        allowCreate: false,
        allowPublish: false,
        secretTarget:
          kind === "secret"
            ? {
                projectId: p.projectId,
                environmentId: p.devEnvironmentId,
                environment: "dev" as const,
                name: "PRIVATE_VALUE",
              }
            : null,
        ...(kind === "github" ? { githubTarget: { idempotencyKey: "github-native" } } : {}),
      };
      await port.store.insertHandoff(item);
      expect(
        await port.store.consumeHandoff({
          requestHash: item.requestHash,
          userId,
          organizationId: p.organizationId,
          now,
          approve: true,
          publish: false,
        }),
      ).not.toBeNull();
      if (kind === "secret") await port.store.completeSecret(item.requestHash, false);
      else await port.store.completeGithub(item.requestHash, false);
      expect(await port.store.findHandoff(item.requestHash)).toMatchObject({
        outcome: kind + "_failed",
      });
    }
    const nativeHash = "d".repeat(64),
      attempt = ulidOf("native-attempt", 1),
      nativeScope = { organizationId: p.organizationId, userId, requestHash: nativeHash };
    const freshProof = await port.store.ensureConnectionProof(
      identity,
      p.projectId,
      new Date().toISOString(),
    );
    if (!freshProof) throw new Error("Native handoff proof absent");
    await port.store.insertHandoff({
      ...handoff,
      requestHash: nativeHash,
      kind: "secret",
      allowCreate: false,
      allowPublish: false,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      authority: {
        grantId: freshProof.grantId,
        clientId: identity.clientId,
        consentHash: identity.consentHash,
        action: "auth:manage",
      },
      secretTarget: {
        projectId: p.projectId,
        environmentId: p.devEnvironmentId,
        environment: "dev",
        name: "NATIVE_AUTH_GOOGLE_CLIENT_SECRET",
        nativeProvider: { provider: "google", configurationRevision: 1, enabled: true },
      },
    });
    expect(await port.store.readNativeProviderHandoffState(nativeScope)).toBe("retryable");
    expect(
      await port.store.claimNativeProviderHandoff({
        ...nativeScope,
        userId: "user_foreign",
        valueSha256: "ab".repeat(32),
        attemptId: attempt,
      }),
    ).toBeNull();
    expect(
      await port.store.claimNativeProviderHandoff({
        ...nativeScope,
        valueSha256: "ab".repeat(32),
        attemptId: attempt,
      }),
    ).not.toBeNull();
    expect(await port.store.readNativeProviderHandoffState(nativeScope)).toBe("pending");
    expect(
      await port.store.completeNativeProviderHandoff({
        organizationId: p.organizationId,
        requestHash: nativeHash,
        attemptId: attempt,
        succeeded: true,
      }),
    ).toBe(true);
    expect(await port.store.readNativeProviderHandoffState(nativeScope)).toBe("succeeded");
    const keys = await crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      ),
      issuer = "https://connect.example.test",
      origin = "https://app.ohmyho.st",
      jwks = {
        keys: [
          {
            ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
            kid: "mcp-native",
            alg: "RS256",
            use: "sig",
          },
        ],
      },
      header = Buffer.from(
        JSON.stringify({ alg: "RS256", kid: "mcp-native", typ: "JWT" }),
      ).toString("base64url"),
      payload = Buffer.from(
        JSON.stringify({
          iss: issuer,
          aud: origin + "/mcp",
          sub: userId,
          client_id: identity.clientId,
          sid: "app_consent_native",
          scope: "openid",
          iat: Date.parse(now) / 1000,
          exp: Date.parse(now) / 1000 + 300,
        }),
      ).toString("base64url"),
      token =
        header +
        "." +
        payload +
        "." +
        Buffer.from(
          await crypto.subtle.sign(
            "RSASSA-PKCS1-v1_5",
            keys.privateKey,
            new TextEncoder().encode(header + "." + payload),
          ),
        ).toString("base64url");
    const remote = createRemoteMcpComposition({
      persistence: target,
      clock: { now: () => new Date(now) },
      origin,
      issuer,
      jwks: { load: async () => jwks },
      authentication: { authenticate: async () => null },
      authorization: { check: async () => "allow" },
      resolveOrganization: async () => parseUlid(p.organizationId),
      dispatch: async () =>
        Response.json({
          items: [
            { id: p.projectId, organization_id: p.organizationId },
            { id: ulidOf("foreign-project", 1), organization_id: p.organizationId },
          ],
          next_cursor: null,
        }),
    });
    const principal = await remote.authenticate(token);
    if (!principal) throw new Error("Signed Connect principal unavailable");
    expect(principal.organizationIds).toEqual([p.organizationId]);
    expect(
      await remote.remoteAuthorization(
        principal,
        {
          kind: "project",
          organizationId: parseUlid(p.organizationId),
          projectId: parseUlid(p.projectId),
        },
        "sources:read",
      ),
    ).toBe(true);
    expect(await remote.remoteDelegation(principal, p.projectId)).toMatchObject({
      clientId: identity.clientId,
      grantRevision: 1,
    });
    expect(
      await (await remote.dispatch(new Request(origin + "/v1/projects"), principal)).json(),
    ).toEqual({
      items: [
        { id: p.projectId, organization_id: p.organizationId },
        { id: ulidOf("foreign-project", 1), organization_id: p.organizationId },
      ],
      next_cursor: null,
    });
    await target.store.revoke(identity, now);
    expect(await target.store.ensureConnectionProof(identity, p.projectId, now)).toBeNull();
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await mf.dispose();
  }
}, 120000);
