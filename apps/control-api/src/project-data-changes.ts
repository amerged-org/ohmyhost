// P1: keep plan validation and operation acceptance together, including protected-link renewal.
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import {
  planProjectDataChangeTransition,
  ProjectDataEnvironmentConflictError,
  type ProjectDataAssignments,
  type ProjectDataChangeSnapshot,
} from "@ohmyhost/database";
import { parseUlid, type Ulid } from "@ohmyhost/platform";
import { type ProjectDataChangeKind } from "@ohmyhost/contracts/project-data-changes";
import {
  ProductSurfaceConflictError,
  type ProductSurfaceContext,
  type ProductSurfaceMutationContext,
  type ProductSurfaceResult,
} from "./contracts.js";
import type { createEnvironmentSecretCipherKeyring } from "./environment-secret-cipher.js";

export type Cipher = ReturnType<typeof createEnvironmentSecretCipherKeyring>;
export interface State {
  readonly lifecycleVersion: number;
  readonly billingEpochId: Ulid;
  readonly assignments: ProjectDataAssignments;
  readonly environmentHeads: ProjectDataChangeSnapshot["environmentHeads"];
  readonly registrationGenerations: ProjectDataChangeSnapshot["registrationGenerations"];
  readonly prodDatabaseReady: boolean;
}

export interface ProjectDataChangesPort {
  plan(
    request: ProductSurfaceContext & { readonly change: ProjectDataChangeKind },
  ): Promise<ProductSurfaceResult | null>;
  change(
    request: ProductSurfaceMutationContext & {
      readonly change: ProjectDataChangeKind;
      readonly ifMatch: string;
      readonly confirmationToken: string;
    },
  ): Promise<ProductSurfaceResult | null>;
}

export function assertApplicable(state: State, change: ProjectDataChangeKind, id: string) {
  try {
    return planProjectDataChangeTransition({
      change,
      assignments: state.assignments,
      newDataEnvironmentId: id,
      prodDatabaseReady: state.prodDatabaseReady,
    });
  } catch (error) {
    if (error instanceof ProjectDataEnvironmentConflictError)
      throw new ProductSurfaceConflictError("data_change_not_applicable");
    throw error;
  }
}
export function etag(
  scope: ProductSurfaceContext,
  state: State,
  change: ProjectDataChangeKind,
): string {
  const canonical = canonicalize as unknown as (value: unknown) => string;
  return `"sha256-${createHash("sha256")
    .update(
      canonical({
        projectId: scope.projectId,
        change,
        lifecycleVersion: state.lifecycleVersion,
        assignments: state.assignments,
        environmentHeads: state.environmentHeads,
        registrationGenerations: state.registrationGenerations,
      }),
    )
    .digest("hex")}"`;
}
export function digest(value: string) {
  return createHash("sha256").update(value).digest();
}
export function derivedId(value: string): Ulid {
  let number = BigInt(`0x${digest(value).toString("hex").slice(0, 32)}`),
    result = "";
  for (let index = 0; index < 26; index += 1) {
    result = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Number(number & 31n)] + result;
    number >>= 5n;
  }
  return parseUlid(result);
}
export function effects(change: ProjectDataChangeKind) {
  const base = {
    risks: [
      "Existing logins and connections of the changing environment are revoked.",
      "Deploy the named environment again before its application can use the new data area.",
      "Data and files are never copied; export SQL before a change that removes Dev data.",
    ],
  };
  if (change === "isolate_prod_keeps_data")
    return {
      ...base,
      effects: [
        "Prod keeps its database and associated files.",
        "Dev gets a new empty database and file area on its next deployment.",
      ],
      destructive_effects: [],
    };
  if (change === "isolate_dev_keeps_data")
    return {
      ...base,
      effects: [
        "Dev keeps its database and associated files.",
        "Prod gets a new empty database and file area on its next deployment.",
      ],
      destructive_effects: [],
    };
  if (change === "share_prod_keeps_data")
    return {
      ...base,
      effects: ["Prod's database and files become the shared data area."],
      destructive_effects: [
        "Dev's database, files and deployment are removed; its protected share link is renewed.",
      ],
    };
  return {
    ...base,
    effects: [
      "Prod, customer secrets and Dev access mode are preserved.",
      "Dev gets a new empty data area on its next deployment.",
    ],
    destructive_effects: [
      "Dev's database, files and deployment are removed; its protected share link is renewed.",
    ],
  };
}
