import {
  parseWorkosUserApiKeyRequest,
  parseWorkosUserApiKeyObservationRequest,
  parseWorkosUserApiKeyResponse,
  type WorkosUserApiKeyMetadata,
  type WorkosUserApiKeyObservationRequest,
} from "@ohmyhost/workos-auth-contracts";
import { readBoundedText } from "./workos-session-status.js";

export interface WorkosUserApiKeyValidationPort {
  validate(value: string): Promise<WorkosUserApiKeyMetadata | null>;
}

export interface WorkosUserApiKeyStatusPort {
  observe(input: WorkosUserApiKeyObservationRequest): Promise<WorkosUserApiKeyMetadata | null>;
}

export function createWorkosUserApiKeyClient(binding: {
  fetch(request: Request): Promise<Response>;
}): WorkosUserApiKeyValidationPort & WorkosUserApiKeyStatusPort {
  const call = async (action: "validate" | "observe", input: unknown) => {
    const response = await binding.fetch(
      new Request(`https://auth-status.internal/api-key-${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(15000),
      }),
    );
    if (
      response.status !== 200 ||
      response.headers.get("cache-control") !== "no-store" ||
      !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")
    )
      throw new Error("api_key_validation_unavailable");
    return parseWorkosUserApiKeyResponse(JSON.parse(await readBoundedText(response, 16384))).key;
  };
  return {
    async observe(input) {
      return call("observe", parseWorkosUserApiKeyObservationRequest(input));
    },
    async validate(value) {
      return call("validate", parseWorkosUserApiKeyRequest({ value }));
    },
  };
}
