import { nativeUserResponse, type NativeAuthManagementPort } from "./native-auth-management.js";
import type { EnvironmentSecretContext, ProductSurfaceMutationContext } from "./contracts.js";

interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly status: "pending" | "active" | "suspended";
  readonly recoveryAvailable: boolean;
  readonly createdAt: Date | string;
}
type Mutation =
  | { readonly action: "create-invite"; readonly email: string }
  | {
      readonly action:
        | "resend-invitation"
        | "suspend"
        | "reactivate"
        | "delete"
        | "revoke-sessions";
      readonly userId: string;
    };
interface NativeAdmin {
  listUsers(input: unknown): Promise<readonly UserRecord[]>;
  getUser(input: unknown): Promise<UserRecord | null>;
  mutateUser(input: unknown): Promise<{
    readonly userId: string;
    readonly action: Mutation["action"];
    readonly user: unknown;
  }>;
}
type UserPort = Pick<
  NativeAuthManagementPort,
  "listUsers" | "getUser" | "createUser" | "deleteUser" | "userAction"
>;
type Scope = EnvironmentSecretContext;
type Write = Scope &
  Pick<ProductSurfaceMutationContext, "idempotencyKey" | "canonicalRequestDigest">;

/** The private admin revalidates current Owner and delegated authority for each call. */
export function createNativeAuthUserPort(input: {
  readonly admin: NativeAdmin;
  readonly acceptMutation: (input: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    principalId: string;
    action: Mutation["action"];
    resourceId: string | null;
    idempotencyKey: string;
    canonicalRequestDigest: string;
    delegation?: Scope["delegation"];
  }) => Promise<{ readonly outcome: "accepted" | "replayed" }>;
  /** Reconcile the original durable outbox entry and confirm acceptance, or throw retryable failure. */
  readonly deliverInvitation: (input: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    principalId: string;
    idempotencyKey: string;
    canonicalRequestDigest: Uint8Array;
    userId: string;
    action: "create-invite" | "resend-invitation";
    resourceId: string | null;
  }) => Promise<void>;
}): UserPort {
  const scope = (value: Scope) => ({
    organizationId: value.organizationId,
    projectId: value.projectId,
    environmentId: value.environmentId,
    principalId: value.principalId,
    requestId: value.requestId,
    ...(value.delegation === undefined ? {} : { delegation: value.delegation }),
  });
  const user = (record: UserRecord) => ({
    id: record.id,
    email: record.email,
    status: record.status,
    recoveryAvailable: record.recoveryAvailable,
    createdAt: new Date(record.createdAt).toISOString(),
  });
  const mutate = async (value: Write, mutation: Mutation) => {
    if (value.canonicalRequestDigest.byteLength !== 32)
      throw new Error("native_user_digest_invalid");
    const resourceId = mutation.action === "create-invite" ? null : mutation.userId;
    const accepted = await input.acceptMutation({
      organizationId: value.organizationId,
      projectId: value.projectId,
      environmentId: value.environmentId,
      principalId: value.principalId,
      action: mutation.action,
      resourceId,
      idempotencyKey: value.idempotencyKey,
      canonicalRequestDigest: [...value.canonicalRequestDigest]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
      ...(value.delegation === undefined ? {} : { delegation: value.delegation }),
    });
    if (accepted.outcome !== "accepted" && accepted.outcome !== "replayed")
      throw new Error("native_user_acceptance_invalid");
    const receipt = await input.admin.mutateUser({
      ...scope(value),
      idempotencyKey: value.idempotencyKey,
      canonicalRequestDigest: value.canonicalRequestDigest,
      mutation,
    });
    if (
      receipt.action !== mutation.action ||
      (mutation.action !== "create-invite" && receipt.userId !== mutation.userId)
    )
      throw new Error("native_user_receipt_invalid");
    const resultUser = receipt.user === null ? null : nativeUserResponse.parse(receipt.user);
    if (
      (mutation.action === "delete") !== (resultUser === null) ||
      (resultUser !== null && resultUser.id !== receipt.userId)
    )
      throw new Error("native_user_receipt_invalid");
    if (mutation.action === "create-invite" || mutation.action === "resend-invitation") {
      await input.deliverInvitation({
        ...scope(value),
        idempotencyKey: value.idempotencyKey,
        canonicalRequestDigest: value.canonicalRequestDigest,
        userId: receipt.userId,
        action: mutation.action,
        resourceId,
      });
    }
    return { ...receipt, user: resultUser };
  };
  const read = async (value: Scope, userId: string) => {
    const record = await input.admin.getUser({ ...scope(value), userId });
    if (record !== null && record.id !== userId) throw new Error("native_user_response_invalid");
    return record === null ? null : user(record);
  };
  return {
    async listUsers(value) {
      const rows = await input.admin.listUsers({
        ...scope(value),
        limit: value.limit + 1,
        ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
        ...(value.search === undefined ? {} : { search: value.search }),
      });
      if (rows.length > value.limit + 1) throw new Error("native_user_page_invalid");
      const items = rows.slice(0, value.limit).map(user);
      return { items, nextCursor: rows.length > value.limit ? (items.at(-1)?.id ?? null) : null };
    },
    getUser: (value) => read(value, value.userId),
    async createUser(value) {
      const receipt = await mutate(value, { action: "create-invite", email: value.email });
      if (receipt.user === null) throw new Error("native_user_unavailable");
      return receipt.user;
    },
    async deleteUser(value) {
      await mutate(value, { action: "delete", userId: value.userId });
    },
    async userAction(value) {
      const action = value.action === "invite" ? "resend-invitation" : value.action;
      const receipt = await mutate(value, { action, userId: value.userId });
      if (receipt.user === null) throw new Error("native_user_unavailable");
      return receipt.user;
    },
  };
}
