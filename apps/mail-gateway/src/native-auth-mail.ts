import { z } from "zod";
import { parseUlid } from "@ohmyhost/platform";
import { isNativeAuthRedirectPath } from "@ohmyhost/contracts/native-auth";

const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
const appPath = z.string().max(256).refine(isNativeAuthRedirectPath);
export const nativeMailRequestSchema = z.strictObject({
  organizationId: id,
  projectId: id,
  environmentId: id,
  kind: z.enum(["verification", "password-reset", "invitation"]),
  to: z.email().max(254),
  url: z.string().url().max(8192),
  messageId: z.uuid(),
});
export const nativeMailAuthoritySchema = z.strictObject({
  organizationId: id,
  projectId: id,
  environmentId: id,
  domain: z.string().min(1).max(253),
  canonicalOrigin: z.string().url(),
  applicationName: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine((value) => !/[\r\n]/u.test(value) && !value.includes(String.fromCharCode(0))),
  allowedRedirectPaths: z.array(appPath).min(1).max(16),
  resetPasswordPath: appPath,
  invitationPath: appPath,
});

/** Private-only caller: authority resolves the current realm and authorized project sender. */
export function createNativeAuthMail(input: {
  readonly authorize: (request: z.output<typeof nativeMailRequestSchema>) => Promise<unknown>;
  readonly send: (
    request: {
      projectId: string;
      idempotencyKey: string;
      to: string;
      subject: string;
      text: string;
    },
    project: {
      organizationId: ReturnType<typeof parseUlid>;
      projectId: ReturnType<typeof parseUlid>;
      environmentId: ReturnType<typeof parseUlid>;
      domain: string;
    },
  ) => Promise<{ status: string }>;
}) {
  return async (raw: unknown): Promise<{ status: "accepted" | "uncertain" | "rejected" }> => {
    const request = nativeMailRequestSchema.parse(raw);
    const authority = nativeMailAuthoritySchema.parse(await input.authorize(request));
    if (
      authority.organizationId !== request.organizationId ||
      authority.projectId !== request.projectId ||
      authority.environmentId !== request.environmentId
    )
      throw new Error("native_mail_unavailable");
    const origin = new URL(authority.canonicalOrigin);
    if (origin.protocol !== "https:" || origin.origin !== authority.canonicalOrigin)
      throw new Error("native_mail_unavailable");
    const url = new URL(request.url);
    const expectedPath =
      request.kind === "verification"
        ? "/api/auth/v1/verify-email"
        : request.kind === "password-reset"
          ? authority.resetPasswordPath
          : authority.invitationPath;
    if (
      url.origin !== origin.origin ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== expectedPath ||
      !authority.allowedRedirectPaths.includes(authority.resetPasswordPath) ||
      !authority.allowedRedirectPaths.includes(authority.invitationPath)
    )
      throw new Error("native_mail_url_invalid");
    const allowed = request.kind === "verification" ? ["token", "callbackURL"] : ["token"];
    if (
      [...url.searchParams.keys()].some(
        (key) => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1,
      ) ||
      url.searchParams.getAll("token").length !== 1 ||
      !url.searchParams.get("token") ||
      (url.searchParams.get("token")?.length ?? 0) > 4096 ||
      /[\s\p{Cc}]/u.test(url.searchParams.get("token") ?? "")
    )
      throw new Error("native_mail_url_invalid");
    const callback = url.searchParams.get("callbackURL");
    if (callback !== null) {
      const target = new URL(callback, origin);
      if (
        target.origin !== origin.origin ||
        target.username ||
        target.password ||
        target.search ||
        target.hash ||
        !authority.allowedRedirectPaths.includes(target.pathname)
      )
        throw new Error("native_mail_url_invalid");
    }
    const subject =
      request.kind === "verification"
        ? `Verify your ${authority.applicationName} email`
        : request.kind === "password-reset"
          ? `Reset your ${authority.applicationName} password`
          : `Your invitation to ${authority.applicationName}`;
    const result = await input.send(
      {
        projectId: request.projectId,
        idempotencyKey: `native-auth:${request.environmentId}:${request.messageId.toLowerCase()}`,
        to: request.to,
        subject,
        text: `${subject}\n\n${url.href}\n`,
      },
      {
        organizationId: parseUlid(authority.organizationId),
        projectId: parseUlid(authority.projectId),
        environmentId: parseUlid(authority.environmentId),
        domain: authority.domain,
      },
    );
    if (
      result.status !== "accepted" &&
      result.status !== "uncertain" &&
      result.status !== "rejected"
    )
      throw new Error("native_mail_unavailable");
    return { status: result.status };
  };
}
