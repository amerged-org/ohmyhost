import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { createEmailVerificationToken } from "better-auth/api";
import { Pool } from "pg";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
} from "@ohmyhost/contracts/native-auth";
import { expect, it } from "vitest";
import { createProjectRecoveryArchiveV2 } from "../../../packages/project-recovery/src/index.js";
import { readNativeRestoreArchive } from "../../../packages/project-recovery/src/native-restore-archive.js";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { sanitizeRestoredNativeRealm } from "../src/restore.js";
import { createNativePasswordHandler } from "../src/password-handler.js";
import { createNativeSocialHandler } from "../src/social-handler.js";
import { createNativePostgresPolicy } from "../src/policy.js";
import { validateNativeSessionPolicy } from "../src/session-policy.js";

const run = promisify(execFile);
it("sanitizes a same-realm restored encrypted PostgreSQL snapshot without losing identities", async () => {
  const db = await startTestPostgres();
  const schema = "omh_auth_00000000000000000000000004";
  const connectionString = db.pool.options.connectionString;
  if (!connectionString) throw new Error("missing_test_postgres_url");
  const directory = await mkdtemp(join(tmpdir(), "omh-native-restore-"));
  await db.pool.query(`create schema ${schema}`);
  let realm = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try {
    await realm.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    await realm.query(
      await readFile(
        new URL("../migrations/002-invitation-receipt-digest.sql", import.meta.url),
        "utf8",
      ),
    );
    await realm.query(
      await readFile(new URL("../migrations/003-social-flow.sql", import.meta.url), "utf8"),
    );
    const active = randomUUID(),
      pending = randomUUID(),
      session = randomUUID();
    const password = await hashPassword("correct-horse-battery-123");
    await realm.query(
      "insert into native_realm_policy (enabled,revocation_epoch,configuration_revision) values (true,3,4)",
    );
    await realm.query(
      'insert into "user" (id,name,email,"emailVerified") values ($1,$2,$3,true),($4,$5,$6,true)',
      [active, "Active", "active@example.test", pending, "Pending", "pending@example.test"],
    );
    await realm.query(
      "insert into native_user_policy (user_id,status,recovery_verified_at) values ($1,'active',now()),($2,'pending',now())",
      [active, pending],
    );
    await realm.query(
      'insert into "account" ("userId","providerId","accountId","password","updatedAt") values ($1,\'credential\',$1::uuid::text,$2,now()),($3,\'google\',\'subject\',null,now())',
      [active, password, pending],
    );
    await realm.query(
      'insert into "session" (id,"userId",token,"expiresAt","updatedAt") values ($1,$2,$3,now()+interval \'1 day\',now())',
      [session, active, "old-session-token"],
    );
    await realm.query(
      "insert into native_session_policy (session_id,realm_epoch,user_epoch,authenticated_at) values ($1,3,0,now())",
      [session],
    );
    await realm.query(
      'insert into "verification" (identifier,value,"expiresAt") values ($1,$2,now()+interval \'1 hour\')',
      ["old-oauth-state", "old-reset-user"],
    );
    const oldVerificationToken = await createEmailVerificationToken(
      "test-secret-at-least-32-characters-long",
      "pending@example.test",
      undefined,
      3600,
      { jti: randomUUID() },
    );
    const oldResetToken = randomBytes(32).toString("base64url");
    const oldInvitationToken = randomBytes(32).toString("base64url");
    const oldState = randomBytes(32).toString("base64url");
    const invitation = createHash("sha256").update(oldInvitationToken).digest();
    await realm.query(
      "insert into native_invitation (token_digest,user_id,realm_epoch,configuration_revision,user_epoch,expires_at) values ($1,$2,3,4,0,now()+interval '1 hour')",
      [invitation, pending],
    );
    await realm.query(
      "insert into native_social_pending (user_id,provider,subject,realm_epoch,configuration_revision,invitation_digest) values ($1,'google','subject',3,4,$2)",
      [pending, invitation],
    );
    await realm.query(
      "insert into native_mail_challenge (token_digest,user_id,purpose,realm_epoch,configuration_revision,user_epoch,expires_at) values ($1,$2,'verification',3,4,0,now()+interval '1 hour')",
      [createHash("sha256").update(oldVerificationToken).digest(), pending],
    );
    await realm.query(
      "insert into native_mail_challenge (token_digest,user_id,purpose,realm_epoch,configuration_revision,user_epoch,expires_at) values ($1,$2,'password-reset',3,4,0,now()+interval '1 hour')",
      [createHash("sha256").update(oldResetToken).digest(), active],
    );
    await realm.query(
      "insert into native_social_flow (state_digest,provider,intent,realm_epoch,configuration_revision,expires_at) values ($1,'google','login',3,4,now()+interval '1 hour')",
      [createHash("sha256").update(oldState).digest()],
    );
    await realm.query(
      "insert into native_admin_receipt (request_id,request_digest,response) values ('old-admin',$1,$2)",
      [randomBytes(32), { status: "old" }],
    );
    await realm.query(
      "insert into native_admin_audit (request_id,action,user_id) values ('old-admin','suspend',$1)",
      [active],
    );
    await realm.query(
      "insert into native_mail_outbox (message_id,request_id,user_id,kind,sealed_payload,token_digest,lease_id,lease_expires_at) values ($1,'old-admin',$2,'invitation',$3,$4,$5,now()+interval '1 hour')",
      [randomUUID(), pending, Buffer.from("sealed"), invitation, randomUUID()],
    );
    await realm.query(
      "insert into native_auth_mail_outbox (message_id,request_id,kind,sealed_payload,user_id,token_digest,realm_epoch,configuration_revision,lease_id,lease_expires_at) values ($1,'old-mail','verification',$2,$3,$4,3,4,$5,now()+interval '1 hour')",
      [randomUUID(), Buffer.from("sealed"), pending, randomBytes(32), randomUUID()],
    );
    await realm.query(
      "insert into native_invitation_accept_receipt (request_id,token_digest,user_id,request_digest) values ('old-accept',$1,$2,$3)",
      [invitation, pending, randomBytes(32)],
    );
    await realm.query(
      "insert into native_password_receipt (request_id,request_digest,response_body,response_status) values ('old-password',$1,'{\"status\":true}',200)",
      [randomBytes(32)],
    );
    const dumpPath = join(directory, "source.dump");
    await run("pg_dump", [
      "--format=custom",
      "--no-owner",
      "--no-acl",
      `--schema=${schema}`,
      "--file",
      dumpPath,
      connectionString,
    ]);
    const dump = await readFile(dumpPath);
    const resource = { kind: "native_auth_database" as const, databaseId: "a1234567890123456789" };
    const scope = {
      organizationId: "00000000000000000000000001",
      projectId: "00000000000000000000000002",
      environmentId: "00000000000000000000000004",
    };
    const archivePath = join(directory, "backup.zip");
    const digest = `sha256:${createHash("sha256").update(dump).digest("hex")}`;
    const receipt = await createProjectRecoveryArchiveV2({
      scope: {
        schemaVersion: "ohmyhost.recovery-scope/v2",
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        backupId: "00000000000000000000000003",
        dataMode: "isolated",
        environments: { dev: scope.environmentId, prod: "00000000000000000000000005" },
        resources: [resource],
        nativeManifest: {
          schemaVersion: "ohmyhost.native-auth-inventory/v1",
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          databaseId: resource.databaseId,
          migrationVersion: NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
          migrationDigest: NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
          realms: [
            {
              environmentId: scope.environmentId,
              schemaName: schema,
              revocationEpoch: 3,
              configurationRevision: 4,
              dumpOffset: 0,
              dumpBytes: dump.length,
              dumpSha256: digest.slice(7),
            },
          ],
        },
      },
      files: [{ resource, path: "source.dump", bytes: dump.length, sha256: digest }],
      inputDirectory: directory,
      archivePath,
      passphrase: "fixture-passphrase",
      capturedAt: "2026-11-04T00:00:00.000Z",
      maximumBytes: 10485760,
    });
    if (!receipt.nativeManifest || !receipt.nativeManifestSha256)
      throw new Error("missing_manifest");
    const { sql: restoredDump } = await readNativeRestoreArchive({
      archive: await readFile(archivePath),
      archiveSha256: receipt.sha256.slice(7),
      nativeManifest: JSON.stringify(receipt.nativeManifest),
      nativeManifestSha256: receipt.nativeManifestSha256.slice(7),
      passphrase: "fixture-passphrase",
      maximumBytes: 10485760,
    });
    const restoredPath = join(directory, "restored.dump");
    await writeFile(restoredPath, restoredDump, { mode: 0o600 });
    await realm.end();
    await db.pool.query(`drop schema ${schema} cascade`);
    await run("pg_restore", [
      "--no-owner",
      "--no-acl",
      "--exit-on-error",
      "--dbname",
      connectionString,
      restoredPath,
    ]);
    realm = new Pool({ connectionString, options: `-c search_path=${schema}` });
    const core = {
      scope,
      restoreId: "restore-operation-1",
      claimId: "current-claim",
      databaseId: "a1234567890123456789",
      offline: true,
      revocationEpoch: 4,
      configurationRevision: 5,
      acceptedMutationEpoch: 4,
    };
    const base = {
      pool: realm,
      scope,
      restoreId: core.restoreId,
      claimId: core.claimId,
      databaseId: core.databaseId,
      receiptKey: "private-restore-receipt-key-long-enough",
    };
    await expect(
      sanitizeRestoredNativeRealm({
        ...base,
        authority: { current: async () => ({ ...core, offline: false }) },
      }),
    ).rejects.toThrow("native_restore_authority_invalid");
    await expect(
      sanitizeRestoredNativeRealm({
        ...base,
        authority: {
          current: async () => ({ ...core, scope: { ...scope, environmentId: "wrong" } }),
        },
      }),
    ).rejects.toThrow("native_restore_authority_invalid");
    await expect(
      sanitizeRestoredNativeRealm({
        ...base,
        authority: { current: async () => ({ ...core, acceptedMutationEpoch: 3 }) },
      }),
    ).rejects.toThrow("native_restore_authority_invalid");
    let reads = 0;
    await expect(
      sanitizeRestoredNativeRealm({
        ...base,
        authority: {
          current: async () =>
            ++reads === 1 ? core : { ...core, revocationEpoch: 5, acceptedMutationEpoch: 5 },
        },
      }),
    ).rejects.toThrow("native_restore_authority_changed");
    expect((await realm.query('select id from "session"')).rowCount).toBe(1);
    const lockKey = `ohmyho-native-restore/v1:${scope.organizationId}:${scope.projectId}:${core.databaseId}`;
    const waitForLock = async () => {
      for (let i = 0; i < 200; i++) {
        const waiters = await db.pool.query<{ waiting: boolean }>(
          "select exists(select 1 from pg_locks where locktype='advisory' and not granted) as waiting",
        );
        if (waiters.rows[0]?.waiting) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("restore_lock_wait_not_observed");
    };
    const holder = await realm.connect();
    try {
      await holder.query("begin");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
      let staleReads = 0;
      const stale = sanitizeRestoredNativeRealm({
        ...base,
        claimId: "old-claim",
        authority: {
          current: async () => {
            staleReads++;
            return core;
          },
        },
      });
      const staleRejection = expect(stale).rejects.toThrow("native_restore_authority_invalid");
      await waitForLock();
      expect(staleReads).toBe(0);
      await holder.query("commit");
      await staleRejection;
      expect((await realm.query('select id from "session"')).rowCount).toBe(1);
      await holder.query("begin");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
      await holder.query('update "user" set name=$2 where id=$1', [active, "settled-old-commit"]);
      let freshReads = 0;
      const pending = sanitizeRestoredNativeRealm({
        ...base,
        authority: {
          current: async () => {
            freshReads++;
            return core;
          },
        },
      });
      await waitForLock();
      expect(freshReads).toBe(0);
      await holder.query("commit");
      const first = await pending;
      const replay = await sanitizeRestoredNativeRealm({
        ...base,
        authority: { current: async () => core },
      });
      expect(
        (await realm.query('select name from "user" where id=$1', [active])).rows[0].name,
      ).toBe("settled-old-commit");
      expect(first).toEqual({ status: "sanitized", revocationEpoch: 4, configurationRevision: 5 });
      expect(replay).toEqual(first);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
    const first = { status: "sanitized", revocationEpoch: 4, configurationRevision: 5 };
    const replay = await sanitizeRestoredNativeRealm({
      ...base,
      authority: { current: async () => core },
    });
    expect(first).toEqual({ status: "sanitized", revocationEpoch: 4, configurationRevision: 5 });
    expect(replay).toEqual(first);
    const savedRestore = await realm.query<{
      request_id: string;
      request_digest: Buffer;
      response: typeof first;
    }>(
      "select request_id,request_digest,response from native_admin_receipt where request_id like 'native-restore:%' order by request_id",
    );
    expect(savedRestore.rows).toHaveLength(1);
    const oldReceipt = savedRestore.rows[0];
    if (!oldReceipt) throw new Error("missing_native_restore_receipt");
    const replacementReceiptKey = "replacement-restore-receipt-key-long-enough";
    const rotatedRestore = {
      ...base,
      receiptKey: replacementReceiptKey,
      additionalReceiptKeys: [base.receiptKey, base.receiptKey, replacementReceiptKey],
      authority: { current: async () => core },
    };
    // A replay must find the old receipt before any sanitization, including after a master change.
    await realm.query(
      'insert into "verification" (identifier,value,"expiresAt") values ($1,$2,now()+interval \'1 hour\')',
      ["post-sanitization-sentinel", "must-survive-replay"],
    );
    expect(await sanitizeRestoredNativeRealm(rotatedRestore)).toEqual(first);
    expect(
      (
        await realm.query('select 1 from "verification" where identifier=$1', [
          "post-sanitization-sentinel",
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await realm.query(
          "select request_id,request_digest,response from native_admin_receipt where request_id like 'native-restore:%' order by request_id",
        )
      ).rows,
    ).toEqual(savedRestore.rows);
    await expect(
      sanitizeRestoredNativeRealm({
        ...rotatedRestore,
        additionalReceiptKeys: ["wrong-historical-receipt-key-long-enough"],
      }),
    ).rejects.toThrow("native_restore_generation_not_advanced");
    await expect(
      sanitizeRestoredNativeRealm({
        ...rotatedRestore,
        additionalReceiptKeys: Array<string>(9).fill(base.receiptKey),
      }),
    ).rejects.toThrow("invalid_native_restore_scope");
    await expect(
      sanitizeRestoredNativeRealm({ ...rotatedRestore, additionalReceiptKeys: ["short"] }),
    ).rejects.toThrow("invalid_native_restore_scope");
    await expect(
      sanitizeRestoredNativeRealm({
        ...rotatedRestore,
        scope: { ...scope, environmentId: "wrong-environment" },
      }),
    ).rejects.toThrow("native_restore_authority_invalid");
    let replayAuthorityReads = 0;
    await expect(
      sanitizeRestoredNativeRealm({
        ...rotatedRestore,
        authority: {
          current: async () =>
            ++replayAuthorityReads === 1
              ? core
              : { ...core, revocationEpoch: 5, acceptedMutationEpoch: 5 },
        },
      }),
    ).rejects.toThrow("native_restore_authority_changed");
    await realm.query("update native_admin_receipt set request_digest=$2 where request_id=$1", [
      oldReceipt.request_id,
      randomBytes(32),
    ]);
    await expect(sanitizeRestoredNativeRealm(rotatedRestore)).rejects.toThrow(
      "native_restore_receipt_conflict",
    );
    await realm.query("update native_admin_receipt set request_digest=$2 where request_id=$1", [
      oldReceipt.request_id,
      oldReceipt.request_digest,
    ]);
    const canonicalRestore = JSON.stringify([
      scope.organizationId,
      scope.projectId,
      scope.environmentId,
      core.databaseId,
      core.restoreId,
    ]);
    const newReceiptId = `native-restore:${createHmac("sha256", replacementReceiptKey)
      .update("native-restore-id-v1\0")
      .update(canonicalRestore)
      .digest("hex")}`;
    const newFingerprint = createHmac("sha256", replacementReceiptKey)
      .update("native-restore-receipt-v1\0")
      .update(canonicalRestore)
      .digest();
    await realm.query(
      "insert into native_admin_receipt (request_id,request_digest,response) values ($1,$2,$3)",
      [newReceiptId, newFingerprint, first],
    );
    await expect(sanitizeRestoredNativeRealm(rotatedRestore)).rejects.toThrow(
      "native_restore_receipt_conflict",
    );
    await realm.query("delete from native_admin_receipt where request_id=$1", [newReceiptId]);
    expect(
      (
        await realm.query('select 1 from "verification" where identifier=$1', [
          "post-sanitization-sentinel",
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await realm.query(
          "select request_id,request_digest,response from native_admin_receipt where request_id like 'native-restore:%' order by request_id",
        )
      ).rows,
    ).toEqual(savedRestore.rows);
    await realm.query('delete from "verification" where identifier=$1', [
      "post-sanitization-sentinel",
    ]);
    for (const table of [
      '"session"',
      "native_session_policy",
      '"verification"',
      "native_mail_challenge",
      "native_invitation",
      "native_social_flow",
      "native_auth_mail_outbox",
      "native_mail_outbox",
      "native_invitation_accept_receipt",
    ])
      expect((await realm.query(`select 1 from ${table}`)).rowCount).toBe(0);
    expect(
      (
        await realm.query(
          "select enabled,revocation_epoch,configuration_revision from native_realm_policy",
        )
      ).rows[0],
    ).toMatchObject({ enabled: false, revocation_epoch: "4", configuration_revision: "5" });
    expect(
      (
        await realm.query(
          "select response_status,response_body from native_password_receipt where request_id='old-password'",
        )
      ).rows[0],
    ).toMatchObject({ response_status: 409, response_body: '{"error":"restore_invalidated"}' });
    expect(
      (await realm.query("select 1 from native_admin_audit where request_id='old-admin'")).rowCount,
    ).toBe(1);
    const account = await realm.query<{ password: string }>(
      'select password from "account" where "userId"=$1 and "providerId"=\'credential\'',
      [active],
    );
    expect(
      await verifyPassword({
        hash: account.rows[0]?.password ?? "",
        password: "correct-horse-battery-123", // gitleaks:allow -- disposable local test password
      }),
    ).toBe(true);
    expect(
      (
        await realm.query(
          'select "userId" from "account" where "providerId"=\'google\' and "accountId"=\'subject\'',
        )
      ).rows[0].userId,
    ).toBe(pending);
    const pendingState = await realm.query(
      'select p.status,p.recovery_verified_at,u."emailVerified",s.invitation_digest from native_user_policy p join "user" u on u.id=p.user_id join native_social_pending s on s.user_id=p.user_id where p.user_id=$1',
      [pending],
    );
    expect(pendingState.rows[0]).toMatchObject({
      status: "pending",
      recovery_verified_at: null,
      emailVerified: false,
      invitation_digest: invitation,
    });
    expect(
      await validateNativeSessionPolicy(
        realm,
        {
          user: { id: active, email: "active@example.test" },
          session: { id: session, expiresAt: new Date(Date.now() + 60000).toISOString() },
        },
        4,
      ),
    ).toBeNull();
    // Simulate the separately authorized Owner activation in this disposable realm.
    await realm.query("update native_realm_policy set enabled=true where singleton=true");
    const liveAuthority = async () => ({
      enabled: true,
      revocationEpoch: 4,
      configurationRevision: 5,
      signupMode: "open" as const,
    });
    const passwordHandler = createNativePasswordHandler({
      pool: realm,
      canonicalOrigin: "https://restore.example.test",
      applicationName: "Restore",
      secret: "test-secret-at-least-32-characters-long",
      ports: {
        admitAttempt: async () => true,
        currentAuthority: liveAuthority,
        sealMail: async () => new Uint8Array([1]),
        deliverMail: async () => {},
      },
    });
    const oldVerifyUrl = new URL("https://restore.example.test/api/auth/v1/verify-email");
    oldVerifyUrl.searchParams.set("token", oldVerificationToken);
    expect((await passwordHandler.handle(new Request(oldVerifyUrl))).status).toBe(400);
    expect(
      (
        await passwordHandler.handle(
          new Request("https://restore.example.test/api/auth/v1/reset-password", {
            method: "POST",
            headers: { origin: "https://restore.example.test", "content-type": "application/json" },
            body: JSON.stringify({
              token: oldResetToken,
              newPassword: "replacement-long-password",
            }),
          }),
        )
      ).status,
    ).toBe(400);
    const policy = createNativePostgresPolicy(
      realm,
      { currentAuthority: liveAuthority },
      "private-restore-receipt-key-long-enough",
    );
    expect(
      await policy.acceptInvitation({
        token: oldInvitationToken,
        password: "new-password-long-enough",
        requestId: randomUUID(),
      }),
    ).toBe(false);
    const social = createNativeSocialHandler({
      pool: realm,
      canonicalOrigin: "https://restore.example.test",
      applicationName: "Restore",
      secret: "test-secret-at-least-32-characters-long",
      ports: {
        admitAttempt: async () => true,
        currentAuthority: liveAuthority,
        provider: async () => ({
          enabled: true,
          clientId: "client",
          clientSecret: "secret",
          configurationRevision: 5,
        }),
        sealMail: async () => new Uint8Array([1]),
        deliverMail: async () => {},
        recordProviderSuccess: async () => {},
      },
    });
    expect(
      (
        await social.handle(
          new Request(
            `https://restore.example.test/api/auth/v1/callback/google?code=old&state=${encodeURIComponent(oldState)}`,
          ),
        )
      ).status,
    ).toBe(403);
    const nextRestore = {
      ...core,
      restoreId: "restore-operation-2",
      claimId: "next-claim",
      revocationEpoch: 5,
      configurationRevision: 6,
      acceptedMutationEpoch: 5,
    };
    expect(
      await sanitizeRestoredNativeRealm({
        ...base,
        restoreId: nextRestore.restoreId,
        claimId: nextRestore.claimId,
        receiptKey: replacementReceiptKey,
        additionalReceiptKeys: [base.receiptKey],
        authority: { current: async () => nextRestore },
      }),
    ).toEqual({ status: "sanitized", revocationEpoch: 5, configurationRevision: 6 });
    const nextCanonical = JSON.stringify([
      scope.organizationId,
      scope.projectId,
      scope.environmentId,
      core.databaseId,
      nextRestore.restoreId,
    ]);
    const nextId = (key: string) =>
      `native-restore:${createHmac("sha256", key)
        .update("native-restore-id-v1\0")
        .update(nextCanonical)
        .digest("hex")}`;
    expect(
      (
        await realm.query(
          "select request_id,request_digest from native_admin_receipt where request_id=any($1::text[])",
          [[nextId(replacementReceiptKey), nextId(base.receiptKey)]],
        )
      ).rows,
    ).toEqual([
      {
        request_id: nextId(replacementReceiptKey),
        request_digest: createHmac("sha256", replacementReceiptKey)
          .update("native-restore-receipt-v1\0")
          .update(nextCanonical)
          .digest(),
      },
    ]);
  } finally {
    await realm.end();
    await db.pool.query(`drop schema if exists ${schema} cascade`);
    await db.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
