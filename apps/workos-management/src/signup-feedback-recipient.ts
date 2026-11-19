import { readJson } from "./workos-readonly-transport.js";

export interface SignupFeedbackClaimReader {
  isCurrent(input: { userId: string; claimToken: string }): Promise<boolean>;
}

const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });

/** A recipient may only be resolved for a currently claimed signup feedback message. */
export function createSignupFeedbackRecipient(input: {
  credential: string;
  fetcher: (request: Request) => Promise<Response>;
  claims: SignupFeedbackClaimReader;
}) {
  return {
    async resolve(
      raw: unknown,
    ): Promise<
      | { eligible: false; reason: "missing" | "unverified" }
      | { eligible: true; email: string; firstName: string | null }
    > {
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        Object.keys(raw).sort().join(",") !== "claimToken,userId"
      )
        throw new Error("signup_feedback_invalid");
      const { userId, claimToken } = raw as Record<string, unknown>;
      if (
        typeof userId !== "string" ||
        !/^user_[A-Za-z0-9_]{1,123}$/u.test(userId) ||
        typeof claimToken !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(claimToken)
      )
        throw new Error("signup_feedback_invalid");
      const claim = { userId, claimToken };
      if (!(await input.claims.isCurrent(claim))) throw new Error("signup_feedback_claim_expired");
      const response = await input.fetcher(
        new Request(`https://api.workos.com/user_management/users/${encodeURIComponent(userId)}`, {
          headers: { authorization: `Bearer ${input.credential}`, accept: "application/json" },
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        }),
      );
      if (response.status === 404) return { eligible: false, reason: "missing" };
      if (!response.ok) throw new Error("signup_feedback_recipient_unavailable");
      const rawUser = await readJson(response, 32768);
      if (!rawUser || typeof rawUser !== "object" || Array.isArray(rawUser))
        throw new Error("signup_feedback_recipient_invalid");
      const user = rawUser as Record<string, unknown>;
      if (
        user["object"] !== "user" ||
        user["id"] !== userId ||
        typeof user["email_verified"] !== "boolean"
      )
        throw new Error("signup_feedback_recipient_invalid");
      if (!user["email_verified"]) return { eligible: false, reason: "unverified" };
      const email = user["email"];
      if (
        typeof email !== "string" ||
        email.length > 254 ||
        hasControlCharacter(email) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
      )
        throw new Error("signup_feedback_recipient_invalid");
      const rawName = user["first_name"];
      const firstName =
        typeof rawName === "string" && rawName.length <= 128 && !hasControlCharacter(rawName)
          ? rawName.trim() || null
          : null;
      if (!(await input.claims.isCurrent(claim))) throw new Error("signup_feedback_claim_expired");
      return { eligible: true, email, firstName };
    },
  };
}
