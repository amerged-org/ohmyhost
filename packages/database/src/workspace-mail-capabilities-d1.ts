import type {
  WorkspaceMailCapabilityPersistence,
  WorkspaceMailDesiredCapabilities,
  WorkspaceMailCapabilityScope,
} from "./workspace-mail-capabilities.js";

export interface WorkspaceMailCapabilityBinding {
  claim(input: unknown): Promise<unknown>;
  read(input: unknown): Promise<unknown>;
  confirm(input: unknown): Promise<unknown>;
  release(input: unknown): Promise<unknown>;
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}
function desired(value: unknown): WorkspaceMailDesiredCapabilities | null {
  if (value === null) return null;
  if (
    !exact(value, ["provider_domain_id", "sending", "receiving"]) ||
    (value["provider_domain_id"] !== null && typeof value["provider_domain_id"] !== "string") ||
    typeof value["sending"] !== "boolean" ||
    typeof value["receiving"] !== "boolean"
  )
    throw new TypeError("mail_capability_response_invalid");
  return value as unknown as WorkspaceMailDesiredCapabilities;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("mail_capability_response_invalid");
  return value;
}
const scope = (input: WorkspaceMailCapabilityScope) => ({
  organizationId: input.organizationId,
  domainId: input.domainId,
  now: input.now().toISOString(),
});
async function invoke<T>(run: () => Promise<unknown>, parse: (value: unknown) => T): Promise<T> {
  let raw;
  try {
    raw = await run();
  } catch (error) {
    if (error instanceof Error && error.message.endsWith(": store_outcome_unknown"))
      throw Object.assign(new Error("store_outcome_unknown"), { code: "store_outcome_unknown" });
    throw new Error("mail_capability_unavailable");
  }
  return parse(raw);
}
/** Four closed methods; no SQL, supplier, provider transport, credential or message data crosses RPC. */
export async function createD1WorkspaceMailCapabilityPersistence(
  raw: unknown,
): Promise<WorkspaceMailCapabilityPersistence> {
  if (
    !raw ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    ["claim", "read", "confirm", "release"].some(
      (method) => typeof Reflect.get(raw, method) !== "function",
    )
  )
    throw new Error("mail_capability_binding_required");
  const binding = raw as WorkspaceMailCapabilityBinding;
  if (
    (await invoke(
      () =>
        binding.read({
          organizationId: "00000000000000000000000000",
          domainId: "00000000000000000000000000",
          now: new Date().toISOString(),
        }),
      desired,
    )) !== null
  )
    throw new TypeError("mail_capability_response_invalid");
  return {
    claim: (input) =>
      invoke(() => binding.claim({ ...scope(input), leaseToken: input.leaseToken }), boolean),
    read: (input) => invoke(() => binding.read(scope(input)), desired),
    confirm: (input) =>
      invoke(
        () =>
          binding.confirm({
            ...scope(input),
            leaseToken: input.leaseToken,
            desired: input.desired,
          }),
        boolean,
      ),
    release: async (input) => {
      await invoke(
        () =>
          binding.release({
            organizationId: input.organizationId,
            domainId: input.domainId,
            leaseToken: input.leaseToken,
          }),
        (value) => {
          if (value !== undefined) throw new TypeError("mail_capability_response_invalid");
        },
      );
    },
  };
}
