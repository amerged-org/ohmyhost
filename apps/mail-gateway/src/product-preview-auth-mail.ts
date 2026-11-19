import type { ProjectPreviewRuntime } from "@ohmyhost/contracts/previews";
import { z } from "zod";
import {
  createNativeAuthMail,
  nativeMailAuthoritySchema,
  nativeMailRequestSchema,
} from "./native-auth-mail.js";

const requestSchema = nativeMailRequestSchema.extend({
  previewId: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
  authGeneration: z.number().int().positive().safe(),
  kind: z.enum(["verification", "password-reset"]),
});
type Sender = Parameters<typeof createNativeAuthMail>[0]["send"];
const unavailable = () => new Error("native_mail_unavailable");

/** Current capability and sender checks; signing keys and provider credentials stay private. */
export function createProductPreviewAuthMail(input: {
  readonly platform: "development" | "production";
  readonly preview: Pick<ProjectPreviewRuntime, "resolveTokenHash" | "authorizeRuntime">;
  readonly authorize: (scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
  }) => Promise<unknown>;
  readonly send: Sender;
}) {
  return async (raw: unknown): Promise<{ status: "accepted" | "uncertain" | "rejected" }> => {
    const request = requestSchema.parse(raw);
    const url = new URL(request.url);
    const suffix = input.platform === "development" ? "preview.dev.omh.st" : "preview.omh.st";
    const token = url.hostname.slice(0, -(suffix.length + 1));
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.hostname !== `${token}.${suffix}` ||
      !/^[a-z2-7]{51}[aq]$/u.test(token)
    )
      throw unavailable();
    const tokenHash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const scope = {
      organizationId: request.organizationId,
      projectId: request.projectId,
      environmentId: request.environmentId,
    };
    async function snapshot() {
      const selected = await input.preview.resolveTokenHash({ tokenHash });
      if (
        !selected ||
        selected.previewId !== request.previewId ||
        selected.authGeneration !== request.authGeneration ||
        selected.organizationId !== scope.organizationId ||
        selected.projectId !== scope.projectId ||
        selected.environmentId !== scope.environmentId
      )
        throw unavailable();
      const current = await input.preview.authorizeRuntime({
        previewId: selected.previewId,
        runtimeGeneration: selected.runtimeGeneration,
        tokenGeneration: selected.tokenGeneration,
      });
      if (
        !current ||
        current.runtimeGeneration !== selected.runtimeGeneration ||
        current.tokenGeneration !== selected.tokenGeneration ||
        current.authGeneration !== selected.authGeneration ||
        current.retirement !== "none" ||
        !["starting", "ready"].includes(current.state)
      )
        throw unavailable();
      const sender = nativeMailAuthoritySchema.parse(await input.authorize(scope));
      return {
        sender,
        authority: [
          current.previewId,
          current.organizationId,
          current.projectId,
          current.environmentId,
          current.runtimeGeneration,
          current.tokenGeneration,
          current.authGeneration,
          current.assignmentVersion,
          current.dataEnvironmentId,
          current.ownershipVersion,
          current.lifecycleVersion,
          current.billingEpochId,
          current.targetSource,
          current.appliedSource,
        ],
      };
    }
    const initial = await snapshot();
    const stable = async () => JSON.stringify(await snapshot()) === JSON.stringify(initial);
    return createNativeAuthMail({
      authorize: async () => ({ ...initial.sender, canonicalOrigin: url.origin }),
      send: async (mail, project) => {
        if (!(await stable())) throw unavailable();
        try {
          const result = await input.send(
            {
              ...mail,
              idempotencyKey: `native-preview:${request.previewId}:${request.authGeneration}:${request.messageId.toLowerCase()}`,
            },
            project,
          );
          return (await stable()) ? result : { status: "uncertain" };
        } catch {
          return { status: "uncertain" };
        }
      },
    })({
      ...scope,
      kind: request.kind,
      to: request.to,
      url: request.url,
      messageId: request.messageId,
    });
  };
}
