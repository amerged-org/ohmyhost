import { expect, it } from "vitest";

import { PROBLEM_POLICY } from "../src/problem-policy.js";

/** A customer who meets either code must be told the exact steps: the Paid status, the Paid apply and the challenge. */
it.each(["domain_ownership_required", "domain_hostname_taken"] as const)(
  "names the Paid status and apply steps and the challenge in the next action of %s",
  (code) => {
    const { action, restAction } = PROBLEM_POLICY[code];
    for (const text of [action, restAction]) {
      // The CLI reads a suggested action of at most 500 characters.
      expect(text.length).toBeLessThanOrEqual(500);
      expect(text).toContain("ohmyhost domain paid status --project ULID --json");
      expect(text).toContain("ohmyhost domain paid apply --project ULID --hostname HOST");
      expect(text).toContain("_omh-project.HOST");
      // The hostname proof is its own record; the mail identity commands never prove a Paid hostname.
      expect(text).not.toContain("application_domain_identity");
      expect(text).not.toContain("mail identity");
    }
  },
);

/** A customer whose project holds another connection, or whose connection is being deleted, is told how to read it. */
it.each(["domain_already_configured", "domain_deleting"] as const)(
  "names the Paid status command in the next action of %s within the CLI limit",
  (code) => {
    const { action } = PROBLEM_POLICY[code];
    // The CLI reads a suggested action of at most 500 characters.
    expect(action.length).toBeLessThanOrEqual(500);
    expect(action).toContain("ohmyhost domain paid status --project ULID --json");
  },
);
