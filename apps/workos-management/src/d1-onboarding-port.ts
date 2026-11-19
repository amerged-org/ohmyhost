import { createD1WorkosIdentityPort, requireControlRuntimeBinding } from "./d1-identity-port.js";
import { OrganizationOnboardingError } from "./onboarding-error.js";
import type {
  OnboardingPrepareInput,
  OnboardingCompleteInput,
  OrganizationOnboardingPersistence,
  OnboardingRequest,
} from "./onboarding-persistence.js";

interface PreparedWire {
  readonly request: OnboardingRequest;
  readonly row: {
    readonly request_id: string;
    readonly request_digest: string;
    readonly name: string;
    readonly signup_source: string;
    readonly workos_organization_id: string | null;
    readonly organization_id: string | null;
  };
}
interface OnboardingBinding {
  prepareWorkosOnboarding(input: OnboardingPrepareInput): Promise<PreparedWire>;
  claimWorkosOnboardingOrganization(input: { requestId: string; userId: string }): Promise<boolean>;
  recordWorkosOnboardingOrganization(input: {
    requestId: string;
    userId: string;
    workosOrganizationId: string;
  }): Promise<void>;
  claimWorkosOnboardingMembership(input: { requestId: string; userId: string }): Promise<boolean>;
  completeWorkosOnboarding(input: OnboardingCompleteInput): Promise<{ id: string; name: string }>;
}
const CODES = [
  "invalid_request",
  "forbidden",
  "idempotency_key_reused",
  "service_unavailable",
] as const;

/** Narrow private WorkOS persistence. Its preparation and finalization each remain one original transaction. */
export function createD1OnboardingPersistence(runtime: unknown): OrganizationOnboardingPersistence {
  const binding = requireControlRuntimeBinding(runtime) as unknown as OnboardingBinding;
  const identity = createD1WorkosIdentityPort({ runtime });
  const call = async <Result>(run: () => Promise<Result>): Promise<Result> => {
    try {
      return await run();
    } catch (error) {
      const code =
        error && typeof error === "object"
          ? (Reflect.get(error, "code") ?? Reflect.get(error, "message"))
          : undefined;
      const known = CODES.find((item) => item === code);
      throw new OrganizationOnboardingError(known ?? "service_unavailable");
    }
  };
  return {
    isSessionEligible: (input) => identity.isSessionEligible(input),
    prepare: (input) =>
      call(async () => {
        const prepared = await binding.prepareWorkosOnboarding(input);
        if (!/^[0-9a-f]{64}$/u.test(prepared.row.request_digest))
          throw new OrganizationOnboardingError("service_unavailable");
        return {
          ...prepared,
          row: { ...prepared.row, request_sha256: Buffer.from(prepared.row.request_digest, "hex") },
        };
      }),
    claimOrganization: (requestId, userId) =>
      call(() => binding.claimWorkosOnboardingOrganization({ requestId, userId })),
    recordOrganization: (requestId, userId, workosOrganizationId) =>
      call(() =>
        binding.recordWorkosOnboardingOrganization({ requestId, userId, workosOrganizationId }),
      ),
    claimMembership: (requestId, userId) =>
      call(() => binding.claimWorkosOnboardingMembership({ requestId, userId })),
    complete: (input) => call(() => binding.completeWorkosOnboarding(input)),
  };
}
