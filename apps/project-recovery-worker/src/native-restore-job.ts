import { parseRecoveryJobInput, type SealedRecoveryInput } from "@ohmyhost/platform";
import { PgcfProjectProvider } from "@ohmyhost/provider-pgcf";
import { importNativeRestore, prepareNativeRestore } from "./native-restore-import.js";
import type { createRecoveryArchiveStore } from "./r2-archives.js";

type NativeRestoreScope = {
  readonly scope: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly restoreId: string;
  };
};
export type NativeRestoreClaim = NativeRestoreScope &
  (
    | { readonly completed: true; readonly pin: NativeRestorePin }
    | {
        readonly completed: false;
        readonly inputState: "claimed" | "consumed";
        readonly pin: NativeRestorePin | null;
        readonly archive: {
          readonly bucket: string;
          readonly key: string;
          readonly bytes: number;
          readonly sha256: string;
          readonly nativeManifest: string;
          readonly nativeManifestSha256: string;
          readonly capturedAt: string;
        };
        readonly target: {
          readonly organizationId: string;
          readonly projectId: string;
          readonly databaseId: string;
          readonly providerProjectId: string;
          readonly regionId: string;
        };
        readonly phase: "preflight" | "restoring";
        readonly realms: readonly {
          readonly environmentId: string;
          readonly revocationEpoch: number;
          readonly configurationRevision: number;
          readonly canonicalOrigin: string | null;
        }[];
        readonly imported: boolean;
      }
  );
export type NativeRestorePin = {
  readonly bucket: string;
  readonly key: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly state: "reserved" | "verified";
};
export interface NativeRestoreControl {
  readRestoreClaim(): Promise<NativeRestoreClaim>;
  readRestoreInput(): Promise<SealedRecoveryInput>;
  beginRestore(): Promise<unknown>;
  reserveRestorePin(): Promise<NativeRestorePin & { readonly created: boolean }>;
  recordRestorePin(): Promise<{ readonly status: "recorded" }>;
  recordRestorePinAbsent(): Promise<{ readonly status: "recorded" }>;
  assertRestoreImportAllowed(): Promise<{ readonly allowed: true }>;
  isRestoreAcknowledged(input: {
    environmentId: string;
    kind: "offline" | "sanitized";
  }): Promise<{ readonly acknowledged: boolean }>;
  applyRestoreOffline(input: {
    environmentId: string;
    revocationEpoch: number;
    configurationRevision: number;
    canonicalOrigin: string | null;
  }): Promise<void>;
  acknowledgeRestore(input: {
    environmentId: string;
    kind: "offline" | "sanitized";
    revocationEpoch: number;
    configurationRevision: number;
  }): Promise<void>;
  isRestoreRealmImported(input: { environmentId: string }): Promise<{ readonly imported: boolean }>;
  markRestoreRealmImported(input: { environmentId: string }): Promise<{ readonly imported: true }>;
  markRestoreImported(): Promise<{ readonly status: "consumed" }>;
  revalidateRestore(input: { environmentId: string }): Promise<void>;
  sanitizeRestore(input: {
    environmentId: string;
  }): Promise<{ status: "sanitized"; revocationEpoch: number; configurationRevision: number }>;
  completeRestore(): Promise<void>;
}

/** Private, claimed restore command. All locators, targets and realm generations come from Core. */
export async function runNativeRestoreJob(input: {
  readonly scope: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly restoreId: string;
  };
  readonly control: NativeRestoreControl;
  readonly archives: Pick<
    ReturnType<typeof createRecoveryArchiveStore>,
    "readVerified" | "pinVerified" | "readRestorePin" | "removeRestorePin" | "inspectRestorePin"
  >;
  readonly provider: PgcfProjectProvider;
  readonly cipher: {
    open(
      scope: { organizationId: string; projectId: string; operationId: string },
      sealed: SealedRecoveryInput,
    ): Promise<Uint8Array>;
  };
  readonly signal: AbortSignal;
}) {
  let claim = await input.control.readRestoreClaim();
  if (
    claim.scope.organizationId !== input.scope.organizationId ||
    claim.scope.projectId !== input.scope.projectId ||
    claim.scope.restoreId !== input.scope.restoreId
  )
    throw new Error("native_restore_scope_invalid");
  if (claim.completed) {
    await input.control.completeRestore();
    await cleanupPin(input, claim.pin);
    return { status: "complete" as const, restoreId: claim.scope.restoreId };
  }
  assertRestorePhase(claim);
  let prepared: Awaited<ReturnType<typeof prepareNativeRestore>> | undefined;
  let archive: Uint8Array | undefined;
  let passphrase = "";
  if (!claim.imported) {
    const plaintext = await input.cipher.open(
      {
        organizationId: claim.scope.organizationId,
        projectId: claim.scope.projectId,
        operationId: claim.scope.restoreId,
      },
      await input.control.readRestoreInput(),
    );
    try {
      passphrase = parseRecoveryJobInput(plaintext).passphrase;
    } finally {
      plaintext.fill(0);
    }
    const hash = Uint8Array.from(claim.archive.sha256.match(/../gu) ?? [], (hex) =>
      Number.parseInt(hex, 16),
    );
    if (claim.phase === "restoring" || claim.pin?.state === "verified") {
      assertPin(claim.pin, claim);
      archive = await input.archives.readRestorePin({
        bucket: claim.archive.bucket,
        scope: claim.scope,
        bytes: claim.archive.bytes,
        sha256: hash,
        signal: input.signal,
      });
    } else {
      archive = await input.archives.readVerified({
        bucket: claim.archive.bucket,
        key: claim.archive.key,
        bytes: claim.archive.bytes,
        sha256: hash,
        signal: input.signal,
      });
    }
    prepared = await prepareNativeRestore({
      target: claim.target,
      archive,
      archiveSha256: claim.archive.sha256,
      nativeManifest: claim.archive.nativeManifest,
      nativeManifestSha256: claim.archive.nativeManifestSha256,
      passphrase,
      maximumBytes: 256 * 1024 * 1024,
      signal: input.signal,
    });
  }
  if (claim.phase === "preflight") {
    if (!archive) throw new Error("native_restore_scope_invalid");
    const pin = await input.control.reserveRestorePin();
    assertPin(pin, claim, false);
    const pinInput = {
      bucket: claim.archive.bucket,
      scope: claim.scope,
      bytes: claim.archive.bytes,
      sha256: Uint8Array.from(claim.archive.sha256.match(/../gu) ?? [], (hex) =>
        Number.parseInt(hex, 16),
      ),
      signal: input.signal,
    };
    if (pin.state === "verified") {
      if (
        (await input.archives.inspectRestorePin({ ...pinInput, allowTombstone: false })) !==
        "verified"
      )
        throw new Error("native_restore_scope_invalid");
    } else if (pin.created) {
      await input.archives.pinVerified({ ...pinInput, archive });
      await input.control.recordRestorePin();
    } else {
      throw new Error("native_restore_pin_reconciliation_required");
    }
    await input.control.beginRestore();
    claim = await input.control.readRestoreClaim();
    if (
      claim.completed ||
      claim.phase !== "restoring" ||
      claim.scope.organizationId !== input.scope.organizationId ||
      claim.scope.projectId !== input.scope.projectId ||
      claim.scope.restoreId !== input.scope.restoreId
    )
      throw new Error("native_restore_scope_invalid");
    assertRestorePhase(claim);
    assertPin(claim.pin, claim);
  }
  for (const realm of claim.realms) {
    if (
      !(
        await input.control.isRestoreAcknowledged({
          environmentId: realm.environmentId,
          kind: "offline",
        })
      ).acknowledged
    ) {
      await input.control.applyRestoreOffline(realm);
      await input.control.acknowledgeRestore({
        environmentId: realm.environmentId,
        revocationEpoch: realm.revocationEpoch,
        configurationRevision: realm.configurationRevision,
        kind: "offline",
      });
    }
  }
  if (!claim.imported) {
    await input.control.assertRestoreImportAllowed();
    if (!archive || !prepared) throw new Error("native_restore_scope_invalid");
    await importNativeRestore({
      provider: input.provider,
      target: claim.target,
      archive,
      archiveSha256: claim.archive.sha256,
      nativeManifest: claim.archive.nativeManifest,
      nativeManifestSha256: claim.archive.nativeManifestSha256,
      passphrase,
      prepared,
      maximumBytes: 256 * 1024 * 1024,
      signal: input.signal,
      authorize: async () => {
        await input.control.assertRestoreImportAllowed();
      },
      isRealmImported: async (environmentId) =>
        (await input.control.isRestoreRealmImported({ environmentId })).imported,
      recordRealmImported: async (environmentId) => {
        await input.control.markRestoreRealmImported({ environmentId });
      },
    });
    await input.control.markRestoreImported();
  }
  for (const realm of claim.realms) {
    if (
      (
        await input.control.isRestoreAcknowledged({
          environmentId: realm.environmentId,
          kind: "sanitized",
        })
      ).acknowledged
    )
      continue;
    await input.control.revalidateRestore({ environmentId: realm.environmentId });
    const result = await input.control.sanitizeRestore({ environmentId: realm.environmentId });
    if (
      result.status !== "sanitized" ||
      result.revocationEpoch !== realm.revocationEpoch ||
      result.configurationRevision !== realm.configurationRevision
    )
      throw new Error("native_restore_sanitizer_mismatch");
    await input.control.acknowledgeRestore({
      environmentId: realm.environmentId,
      revocationEpoch: realm.revocationEpoch,
      configurationRevision: realm.configurationRevision,
      kind: "sanitized",
    });
  }
  await input.control.completeRestore();
  assertPin(claim.pin, claim);
  await cleanupPin(input, claim.pin);
  return { status: "complete" as const, restoreId: claim.scope.restoreId };
}

async function cleanupPin(
  input: {
    scope: { organizationId: string; projectId: string; restoreId: string };
    control: NativeRestoreControl;
    archives: Pick<ReturnType<typeof createRecoveryArchiveStore>, "removeRestorePin">;
    signal: AbortSignal;
  },
  pin: NativeRestorePin,
) {
  if (
    pin.state !== "verified" ||
    pin.key !==
      `restore-pins/${input.scope.organizationId}/${input.scope.projectId}/${input.scope.restoreId}.zip`
  )
    throw new Error("native_restore_scope_invalid");
  await input.archives.removeRestorePin({
    bucket: pin.bucket,
    scope: input.scope,
    signal: input.signal,
  });
  await input.control.recordRestorePinAbsent();
}

function assertRestorePhase(claim: Extract<NativeRestoreClaim, { completed: false }>): void {
  if (
    claim.phase === "preflight"
      ? claim.imported || claim.inputState !== "claimed" || claim.realms.length !== 0
      : claim.realms.length < 1 ||
        claim.realms.length > 2 ||
        claim.imported !== (claim.inputState === "consumed")
  )
    throw new Error("native_restore_scope_invalid");
}

function assertPin(
  pin: NativeRestorePin | null,
  claim: Extract<NativeRestoreClaim, { completed: false }>,
  verified = true,
): asserts pin is NativeRestorePin {
  if (
    !pin ||
    (verified && pin.state !== "verified") ||
    pin.bucket !== claim.archive.bucket ||
    pin.bytes !== claim.archive.bytes ||
    pin.sha256 !== claim.archive.sha256 ||
    pin.key !==
      `restore-pins/${claim.scope.organizationId}/${claim.scope.projectId}/${claim.scope.restoreId}.zip`
  )
    throw new Error("native_restore_scope_invalid");
}
