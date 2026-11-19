import { parseUlid } from "@ohmyhost/platform";

/** The signup source a workspace's own referral link carries. */
export function workspaceReferralSource(organizationId: string): string {
  return `ref-${parseUlid(organizationId).toLowerCase()}`;
}
