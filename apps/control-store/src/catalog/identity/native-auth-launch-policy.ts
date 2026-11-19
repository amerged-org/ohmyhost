import { z } from "zod";
import { ulid, type CatalogContext } from "../common.js";

const policySchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("disabled") }),
  z.strictObject({
    mode: z.literal("allowlist"),
    projects: z.array(z.strictObject({ organizationId: ulid, projectId: ulid })).max(1000),
  }),
  z.strictObject({ mode: z.literal("password-general-availability") }),
]);
export type NativeAuthLaunchPolicy = z.infer<typeof policySchema>;

/** Private deployment configuration; absent or invalid configuration never grants access. */
export function parseNativeAuthLaunchPolicy(value: unknown): NativeAuthLaunchPolicy {
  try {
    const parsed = policySchema.safeParse(typeof value === "string" ? JSON.parse(value) : null);
    return parsed.success ? parsed.data : { mode: "disabled" };
  } catch {
    return { mode: "disabled" };
  }
}

export function nativeAuthSocialAllowed(
  context: CatalogContext,
  organizationId: string,
  projectId: string,
): boolean {
  const policy = context.nativeAuthLaunchPolicy;
  return (
    policy?.mode === "allowlist" &&
    policy.projects.some(
      (project) => project.organizationId === organizationId && project.projectId === projectId,
    )
  );
}

export function nativeAuthLaunchAllowed(
  context: CatalogContext,
  organizationId: string,
  projectId: string,
): boolean {
  return (
    context.nativeAuthLaunchPolicy?.mode === "password-general-availability" ||
    nativeAuthSocialAllowed(context, organizationId, projectId)
  );
}

export function assertNativeAuthLaunchAllowed(
  context: CatalogContext,
  organizationId: string,
  projectId: string,
): void {
  if (!nativeAuthLaunchAllowed(context, organizationId, projectId))
    throw new Error("native_auth_launch_unavailable");
}
