import type { NativeAuthRealmContext } from "@ohmyhost/contracts/native-auth";
import type {
  PreviewRuntimeFence,
  PreviewRuntimeRecord,
  SourceVersion,
} from "@ohmyhost/contracts/previews";

interface PreviewNativePolicy {
  readonly organizationId: string;
  readonly realm: Omit<NativeAuthRealmContext, "canonicalOrigin"> & {
    readonly canonicalOrigin: string | null;
  };
  readonly ownerEnabled: boolean;
  readonly storageReady: boolean;
  readonly paidAllowed: boolean;
  readonly runtimeAllowed: boolean;
  readonly revocationEpoch: number;
  readonly applicationName: string;
  readonly signupPolicy: "open" | "invite-only";
  readonly allowedRedirectPaths: readonly string[];
  readonly resetPasswordPath: string;
  readonly invitationPath: string;
}
export interface PreviewNativeAuthorityPorts {
  resolveTokenHash(input: { tokenHash: string }): Promise<PreviewRuntimeRecord | null>;
  resolveNative(input: PreviewRuntimeFence): Promise<{
    preview: PreviewRuntimeRecord;
    authority: PreviewNativePolicy;
    registration: unknown | null;
    launchAllowed: boolean;
  } | null>;
}
export interface ProductPreviewContext {
  readonly fence: PreviewRuntimeFence;
  readonly publicOrigin: string;
  readonly source: SourceVersion;
  readonly authGeneration: number;
}
export function samePreviewSource(a: SourceVersion | null, b: SourceVersion | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.sourceConnectionId === b.sourceConnectionId &&
    a.sourceGeneration === b.sourceGeneration &&
    a.sequence === b.sequence &&
    a.commitSha === b.commitSha
  );
}
function sameFence(record: PreviewRuntimeRecord, fence: PreviewRuntimeFence): boolean {
  return (
    record.previewId === fence.previewId &&
    record.runtimeGeneration === fence.runtimeGeneration &&
    record.tokenGeneration === fence.tokenGeneration &&
    record.retirement === "none"
  );
}
/** Both Core reads stay private; the capability itself is never sent to Core. */
export async function resolveProductPreviewAuthority(
  ports: PreviewNativeAuthorityPorts,
  input: {
    readonly fence: PreviewRuntimeFence;
    readonly publicOrigin: string;
    readonly hostSuffix: "preview.dev.omh.st" | "preview.omh.st";
    readonly region: "eu" | "us";
    readonly expected?: { readonly source: SourceVersion; readonly authGeneration: number };
  },
) {
  const suffix = input.hostSuffix.replaceAll(".", "\\.");
  const match = new RegExp(`^https://([a-z2-7]{51}[aq])\\.${suffix}$`, "u").exec(
    input.publicOrigin,
  );
  if (!match) throw new Error("auth_unavailable");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(match[1]));
  const tokenHash = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  const first = await ports.resolveTokenHash({ tokenHash });
  if (!first || !sameFence(first, input.fence)) throw new Error("auth_unavailable");
  const snapshot = await ports.resolveNative(input.fence);
  if (
    !snapshot ||
    !sameFence(snapshot.preview, input.fence) ||
    snapshot.preview.region !== input.region ||
    !samePreviewSource(snapshot.preview.targetSource, snapshot.preview.appliedSource) ||
    !snapshot.launchAllowed ||
    !snapshot.registration
  )
    throw new Error("auth_unavailable");
  const { preview, authority } = snapshot;
  const source = preview.targetSource;
  if (
    !source ||
    first.authGeneration !== preview.authGeneration ||
    first.organizationId !== preview.organizationId ||
    authority.organizationId !== preview.organizationId ||
    authority.realm.projectId !== preview.projectId ||
    authority.realm.environmentId !== preview.environmentId ||
    !authority.ownerEnabled ||
    !authority.storageReady ||
    !authority.paidAllowed ||
    !authority.runtimeAllowed ||
    (input.expected !== undefined &&
      (input.expected.authGeneration !== preview.authGeneration ||
        !samePreviewSource(input.expected.source, preview.targetSource)))
  )
    throw new Error("auth_unavailable");
  const last = await ports.resolveTokenHash({ tokenHash });
  if (
    !last ||
    !sameFence(last, input.fence) ||
    last.authGeneration !== preview.authGeneration ||
    !samePreviewSource(last.targetSource, preview.targetSource) ||
    !samePreviewSource(last.appliedSource, preview.appliedSource)
  )
    throw new Error("auth_unavailable");
  return {
    ...authority,
    enabled: true,
    sourceCapable: true,
    realm: { ...authority.realm, canonicalOrigin: input.publicOrigin },
    preview: { previewId: preview.previewId, authGeneration: preview.authGeneration },
    product: {
      fence: input.fence,
      publicOrigin: input.publicOrigin,
      source,
      authGeneration: preview.authGeneration,
    } satisfies ProductPreviewContext,
  };
}
