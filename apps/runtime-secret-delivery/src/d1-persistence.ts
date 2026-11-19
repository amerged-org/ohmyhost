import type { RuntimeSecretPersistence } from "./runtime.js";

const METHODS = [
  "claim",
  "fail",
  "release",
  "readPending",
  "recordPendingAttempt",
  "readState",
  "stageWfp",
  "activateWfp",
  "compensateWfp",
  "readActiveWfpTarget",
  "readRecordedWfpStage",
  "installPlatform",
  "ensurePlatform",
  "ensureMailGateway",
  "readPromotionMailGatewaySource",
  "ensureStorageGateway",
  "ensureAiGateway",
  "ensureBrowserGateway",
] as const;
/** A fixed private service capability. SQL, provider credentials and cipher/master keys never cross this port. */
export function requireD1RuntimeSecretPersistence(
  raw: unknown,
): Required<RuntimeSecretPersistence> {
  if (
    raw === null ||
    (typeof raw !== "object" && typeof raw !== "function") ||
    METHODS.some((method) => typeof Reflect.get(raw, method) !== "function")
  )
    throw new TypeError("Runtime secret delivery requires its private Core persistence binding");
  return raw as Required<RuntimeSecretPersistence>;
}
export function createD1RuntimeSecretPersistence(raw: unknown): Required<RuntimeSecretPersistence> {
  const target = requireD1RuntimeSecretPersistence(raw);
  // The actual existing runtime validates native claims/stages/WFP results and owns authenticated decryption.
  // These typed actions stay separate; there is no caller-selected action/SQL dispatcher or legacy fallback.
  return Object.freeze({
    claim: (input) => target.claim(input),
    fail: (input) => target.fail(input),
    release: (input) => target.release(input),
    readPending: (input) => target.readPending(input),
    recordPendingAttempt: (input) => target.recordPendingAttempt(input),
    readState: (input) => target.readState(input),
    stageWfp: (input) => target.stageWfp(input),
    activateWfp: (input) => target.activateWfp(input),
    compensateWfp: (input) => target.compensateWfp(input),
    readActiveWfpTarget: (input) => target.readActiveWfpTarget(input),
    readRecordedWfpStage: (input) => target.readRecordedWfpStage(input),
    installPlatform: (input) => target.installPlatform(input),
    ensurePlatform: (input) => target.ensurePlatform(input),
    ensureMailGateway: (input) => target.ensureMailGateway(input),
    readPromotionMailGatewaySource: (input) => target.readPromotionMailGatewaySource(input),
    ensureStorageGateway: (input) => target.ensureStorageGateway(input),
    ensureAiGateway: (input) => target.ensureAiGateway(input),
    ensureBrowserGateway: (input) => target.ensureBrowserGateway(input),
  } satisfies Required<RuntimeSecretPersistence>);
}
