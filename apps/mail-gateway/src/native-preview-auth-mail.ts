import { z } from "zod";
import {
  createNativeAuthMail,
  nativeMailAuthoritySchema,
  nativeMailRequestSchema,
} from "./native-auth-mail.js";

const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
const previewId = z.string().regex(/^[a-f0-9]{32}$/u);
const epoch = z.number().int().min(1).max(2_147_483_647);
const requestSchema = nativeMailRequestSchema.extend({
  previewId,
  authGeneration: epoch,
  kind: z.enum(["verification", "password-reset"]),
});
const scopeSchema = z.strictObject({
  platform: z.literal("development"),
  fixture: z.literal("next-native-auth"),
  organizationId: id,
  projectId: id,
  environmentId: id,
  recipients: z
    .array(z.email().max(254))
    .min(2)
    .max(8)
    .refine(
      (recipients) =>
        new Set(recipients.map((value) => value.toLowerCase())).size === recipients.length,
    ),
});
const previewAuthoritySchema = z.strictObject({
  platform: z.literal("development"),
  organizationId: id,
  projectId: id,
  environmentId: id,
  region: z.literal("eu"),
  previewId,
  previewOrigin: z.string().max(256),
  authGeneration: epoch,
  devAccessEpoch: epoch,
  revocationEpoch: epoch,
  configurationRevision: epoch,
  enabled: z.literal(true),
  sourceCapable: z.literal(true),
  paidAllowed: z.literal(true),
  runtimeAllowed: z.literal(true),
});
type Send = Parameters<typeof createNativeAuthMail>[0]["send"];

/** Development-only caller: both the isolated Preview identity and the current sender are required. */
export function createNativePreviewAuthMail(input: {
  readonly scope: string;
  readonly resolve: (identity: { previewId: string; authGeneration: number }) => Promise<unknown>;
  readonly authorize: (scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
  }) => Promise<unknown>;
  readonly send: Send;
}) {
  return async (raw: unknown): Promise<{ status: "accepted" | "uncertain" | "rejected" }> => {
    const request = requestSchema.parse(raw);
    if (typeof input.scope !== "string" || input.scope.length > 4096)
      throw new Error("native_mail_unavailable");
    const scope = scopeSchema.parse(JSON.parse(input.scope) as unknown);
    if (
      request.organizationId !== scope.organizationId ||
      request.projectId !== scope.projectId ||
      request.environmentId !== scope.environmentId ||
      !scope.recipients.includes(request.to)
    )
      throw new Error("native_mail_unavailable");
    const identity = { previewId: request.previewId, authGeneration: request.authGeneration };
    const coreScope = {
      organizationId: request.organizationId,
      projectId: request.projectId,
      environmentId: request.environmentId,
    };
    async function snapshot() {
      const preview = previewAuthoritySchema.parse(await input.resolve(identity));
      const sender = nativeMailAuthoritySchema.parse(await input.authorize(coreScope));
      if (
        preview.organizationId !== scope.organizationId ||
        preview.projectId !== scope.projectId ||
        preview.environmentId !== scope.environmentId ||
        preview.previewId !== identity.previewId ||
        preview.authGeneration !== identity.authGeneration ||
        sender.organizationId !== scope.organizationId ||
        sender.projectId !== scope.projectId ||
        sender.environmentId !== scope.environmentId ||
        !new RegExp(
          `^https://${identity.previewId}-[a-f0-9]{24}\\.preview\\.dev\\.omh\\.st$`,
          "u",
        ).test(preview.previewOrigin)
      )
        throw new Error("native_mail_unavailable");
      const canonical = new URL(sender.canonicalOrigin);
      if (canonical.protocol !== "https:" || canonical.origin !== sender.canonicalOrigin)
        throw new Error("native_mail_unavailable");
      return { preview, sender };
    }
    const first = await snapshot();
    const stable = async () => JSON.stringify(await snapshot()) === JSON.stringify(first);
    const dispatch = createNativeAuthMail({
      // The real sender's approved canonical origin remains validated above. Only this private
      // Preview operation substitutes the independently authorized exact Preview origin.
      authorize: async () => ({ ...first.sender, canonicalOrigin: first.preview.previewOrigin }),
      send: async (mail, project) => {
        if (!(await stable())) throw new Error("native_mail_unavailable");
        try {
          const result = await input.send(
            {
              ...mail,
              idempotencyKey: `native-preview:${identity.previewId}:${identity.authGeneration}:${request.messageId.toLowerCase()}`,
            },
            project,
          );
          if (!(await stable())) return { status: "uncertain" };
          return result;
        } catch {
          // A started provider send or its reply can be lost; do not invent rejection or retry.
          return { status: "uncertain" };
        }
      },
    });
    return dispatch({
      ...coreScope,
      kind: request.kind,
      to: request.to,
      url: request.url,
      messageId: request.messageId,
    });
  };
}
