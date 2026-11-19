import type { MailScope } from "@ohmyhost/database";

interface WorkspaceMailCommandRequest {
  organizationId: string;
  domainId: string;
  idempotencyKey: string;
  principalId: string;
  operation: string;
  requestSha256: Uint8Array;
}
export interface MailManagementCommandPersistence {
  begin(
    scope: MailScope,
    idempotencyKey: string,
    digest: Uint8Array,
    now: () => string,
  ): Promise<{ created: boolean; response: unknown }>;
  resume(scope: MailScope, idempotencyKey: string, now: () => string): Promise<boolean>;
  complete(
    scope: MailScope,
    idempotencyKey: string,
    response: Record<string, unknown>,
    now: () => string,
  ): Promise<void>;
  readWorkspace(input: WorkspaceMailCommandRequest): Promise<unknown>;
  claimWorkspaceRetirement(
    organizationId: string,
    idempotencyKey: string,
    now: () => string,
  ): Promise<boolean>;
}
interface MailManagementCommandBinding {
  read(input: unknown): Promise<unknown>;
  begin(input: unknown): Promise<unknown>;
  resume(input: unknown): Promise<unknown>;
  complete(input: unknown): Promise<unknown>;
  readWorkspace(input: unknown): Promise<unknown>;
  claimWorkspaceRetirement(input: unknown): Promise<unknown>;
}
function invalid(): never {
  throw new TypeError("mail_command_response_invalid");
}
function boolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : invalid();
}
function empty(value: unknown) {
  if (value !== undefined) return invalid();
}
async function invoke<T>(call: () => Promise<unknown>, parse: (value: unknown) => T): Promise<T> {
  let raw;
  try {
    raw = await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    for (const code of [
      "idempotency_key_reused",
      "mail_scope_unavailable",
      "store_busy",
      "store_outcome_unknown",
    ]) {
      if (message !== code && !message.endsWith(`: ${code}`)) continue;
      if (code === "store_busy" || code === "store_outcome_unknown")
        throw Object.assign(new Error(code), { code });
      throw new Error(code);
    }
    throw new Error("mail_command_unavailable");
  }
  return parse(raw);
}
/** Original command identities and safe replies only. Clock and digest suppliers are evaluated locally. */
export async function createD1MailManagementCommandPersistence(
  raw: unknown,
): Promise<MailManagementCommandPersistence> {
  if (
    !raw ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    ["read", "begin", "resume", "complete", "readWorkspace", "claimWorkspaceRetirement"].some(
      (method) => typeof Reflect.get(raw, method) !== "function",
    )
  )
    throw new Error("mail_command_binding_required");
  const binding = raw as MailManagementCommandBinding;
  if (
    (await invoke(
      () =>
        binding.read({
          organizationId: "00000000000000000000000000",
          projectId: "00000000000000000000000000",
          environmentId: "00000000000000000000000000",
          idempotencyKey: "source-probe",
        }),
      (value) => value,
    )) !== null
  )
    return invalid();
  return {
    begin: (scope, key, digest, now) =>
      invoke(
        () =>
          binding.begin({
            ...scope,
            idempotencyKey: key,
            requestSha256: Buffer.from(digest).toString("hex"),
            now: now(),
          }),
        (value) => {
          if (
            typeof value !== "object" ||
            value === null ||
            Array.isArray(value) ||
            Object.keys(value).sort().join(",") !== "created,response" ||
            !("created" in value) ||
            typeof value.created !== "boolean" ||
            !("response" in value)
          )
            return invalid();
          return { created: value.created, response: value.response };
        },
      ),
    resume: (scope, key, now) =>
      invoke(() => binding.resume({ ...scope, idempotencyKey: key, now: now() }), boolean),
    complete: (scope, key, response, now) =>
      invoke(
        () => binding.complete({ ...scope, idempotencyKey: key, response, now: now() }),
        empty,
      ),
    readWorkspace: (input) =>
      invoke(
        () =>
          binding.readWorkspace({
            ...input,
            requestSha256: Buffer.from(input.requestSha256).toString("hex"),
          }),
        (value) => value,
      ),
    claimWorkspaceRetirement: (organizationId, idempotencyKey, now) =>
      invoke(
        () => binding.claimWorkspaceRetirement({ organizationId, idempotencyKey, now: now() }),
        boolean,
      ),
  };
}
