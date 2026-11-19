import { describe, expect, it } from "vitest";

import {
  parseWorkosSessionStatusRequest,
  parseWorkosSessionStatusResponse,
  WorkosContractError,
} from "./index.js";

const validRequest = {
  sessionId: "session_01HXYZ",
  userId: "user_01HXYZ",
  organizationId: "org_01HXYZ",
  tokenExpiresAt: 1_787_047_500,
};

describe("WorkOS session-status contract", () => {
  it("parses the exact request and response shapes", () => {
    expect(parseWorkosSessionStatusRequest(validRequest)).toEqual(validRequest);
    expect(parseWorkosSessionStatusResponse({ active: true })).toEqual({ active: true });
    expect(parseWorkosSessionStatusResponse({ active: false })).toEqual({ active: false });
  });

  it.each([
    ["non-object request", null],
    ["missing session ID", { ...validRequest, sessionId: undefined }],
    ["empty user ID", { ...validRequest, userId: "" }],
    ["non-string organization ID", { ...validRequest, organizationId: 42 }],
    ["non-integer expiry", { ...validRequest, tokenExpiresAt: 1.5 }],
    ["non-positive expiry", { ...validRequest, tokenExpiresAt: 0 }],
    ["extra request field", { ...validRequest, accessToken: "must-not-cross-boundary" }],
  ])("rejects a malformed %s", (_name, value) => {
    expect(() => parseWorkosSessionStatusRequest(value)).toThrowError(WorkosContractError);
  });

  it.each([
    ["non-object response", []],
    ["missing active flag", {}],
    ["non-boolean active flag", { active: "true" }],
    ["extra response field", { active: true, sessionId: "session_01HXYZ" }],
  ])("rejects a malformed %s", (_name, value) => {
    expect(() => parseWorkosSessionStatusResponse(value)).toThrowError(WorkosContractError);
  });
});
