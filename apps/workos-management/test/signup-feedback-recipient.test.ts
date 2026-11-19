import { expect, it, vi } from "vitest";
import { createSignupFeedbackRecipient } from "../src/signup-feedback-recipient.js";
import { createD1SignupFeedbackClaimReader } from "../src/d1-signup-feedback-port.js";

const fixtureClaimToken = [8, 4, 4, 4, 12]
  .map((length, index) => (index === 2 ? "4" : index === 3 ? "8" : "").padEnd(length, "0"))
  .join("-");

it("resolves only verified recipients for a live exact claim, and rechecks after WorkOS returns", async () => {
  const claim = { userId: "user_123", claimToken: fixtureClaimToken };
  const isSignupFeedbackClaim = vi.fn().mockResolvedValue(true);
  const fetcher = vi.fn(async (request: Request) => {
    expect(request.url).toBe("https://api.workos.com/user_management/users/user_123");
    expect(request.redirect).toBe("manual");
    return Response.json({
      object: "user",
      id: claim.userId,
      email_verified: true,
      email: "a@example.test",
      first_name: " Avery ",
    });
  });
  const recipient = createSignupFeedbackRecipient({
    credential: "test-secret",
    fetcher,
    claims: createD1SignupFeedbackClaimReader({ isSignupFeedbackClaim }),
  });
  expect(await recipient.resolve(claim)).toEqual({
    eligible: true,
    email: "a@example.test",
    firstName: "Avery",
  });
  expect(isSignupFeedbackClaim).toHaveBeenCalledTimes(2);
  isSignupFeedbackClaim.mockReset().mockResolvedValueOnce(false);
  await expect(recipient.resolve(claim)).rejects.toThrow("signup_feedback_claim_expired");
  expect(fetcher).toHaveBeenCalledTimes(1);
  isSignupFeedbackClaim.mockReset().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(recipient.resolve(claim)).rejects.toThrow("signup_feedback_claim_expired");
});

it("fails closed for invalid scope, unavailable or malformed identity and returns ineligible for deleted or unverified users", async () => {
  const claim = { userId: "user_123", claimToken: fixtureClaimToken };
  let response = Response.json({ object: "user", id: claim.userId, email_verified: false });
  const recipient = createSignupFeedbackRecipient({
    credential: "secret",
    fetcher: async () => response,
    claims: { isCurrent: async () => true },
  });
  for (const invalid of [
    null,
    {},
    { ...claim, extra: 1 },
    { ...claim, userId: "user_../x" },
    { ...claim, claimToken: "bad" },
  ])
    await expect(recipient.resolve(invalid)).rejects.toThrow("signup_feedback_invalid");
  expect(await recipient.resolve(claim)).toEqual({ eligible: false, reason: "unverified" });
  response = new Response(null, { status: 404 });
  expect(await recipient.resolve(claim)).toEqual({ eligible: false, reason: "missing" });
  response = new Response(null, { status: 503 });
  await expect(recipient.resolve(claim)).rejects.toThrow("signup_feedback_recipient_unavailable");
  response = Response.json({
    object: "user",
    id: "user_other",
    email_verified: true,
    email: "a@example.test",
  });
  await expect(recipient.resolve(claim)).rejects.toThrow("signup_feedback_recipient_invalid");
  response = Response.json({
    object: "user",
    id: claim.userId,
    email_verified: true,
    email: "invalid",
  });
  await expect(recipient.resolve(claim)).rejects.toThrow("signup_feedback_recipient_invalid");
  response = Response.json({
    object: "user",
    id: claim.userId,
    email_verified: true,
    email: "a@example.test",
    first_name: "\nX",
  });
  expect(await recipient.resolve(claim)).toEqual({
    eligible: true,
    email: "a@example.test",
    firstName: null,
  });
});
