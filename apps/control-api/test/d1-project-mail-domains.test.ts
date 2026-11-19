import { describe, expect, it } from "vitest";

import { createD1ProjectMailDomainsPort } from "../src/d1-project-mail-domains.js";
import { ProjectMailDomainsUnavailableError } from "../src/project-mail-domains.js";

const row = (patch: Record<string, unknown> = {}) => ({
  domain: "mail.example.com",
  sending_status: "ready",
  sending_key_id: "key_1",
  receiving: 0,
  receiving_status: "disabled",
  configured_at: "2026-10-29T10:00:00.123456Z",
  observed_at: "2026-10-29T10:05:00.654321Z",
  records: JSON.stringify([
    {
      type: "MX",
      name: "mail.example.com",
      value: "mx.example.net",
      status: "verified",
      priority: 10,
    },
    { type: "TXT", name: "send.mail.example.com", value: "v=spf1", status: "verified" },
  ]),
  ...patch,
});
const request = {
  organizationId: "0".repeat(26),
  projectId: "1".repeat(26),
  principalId: "user:u",
  requestId: "req",
} as never;

describe("Core project mail domain read", () => {
  it("shows the managed Resend domain as the original did and refuses malformed DNS records", async () => {
    const port = (wire: unknown) =>
      createD1ProjectMailDomainsPort({ readDomain: async () => wire });
    expect(await port(null).get(request)).toBeNull();
    expect(await port(row()).get(request)).toEqual({
      domain: "mail.example.com",
      status: "ready",
      sending: "ready",
      receiving: "disabled",
      configuredAt: "2026-10-29T10:00:00.123Z",
      observedAt: "2026-10-29T10:05:00.654Z",
      nextCheckAfterSeconds: null,
      dnsRecords: [
        {
          type: "MX",
          name: "mail.example.com",
          value: "mx.example.net",
          status: "verified",
          priority: 10,
        },
        { type: "TXT", name: "send.mail.example.com", value: "v=spf1", status: "verified" },
      ],
    });
    // A ready sender without its key is still pending, and a receiving domain that is not ready keeps polling.
    expect(await port(row({ sending_key_id: null })).get(request)).toMatchObject({
      status: "verification_pending",
      sending: "pending",
      nextCheckAfterSeconds: 60,
    });
    expect(
      await port(row({ receiving: 1, receiving_status: "pending" })).get(request),
    ).toMatchObject({
      nextCheckAfterSeconds: 60,
    });
    await expect(
      port(
        row({
          records: JSON.stringify([{ type: "TXT", name: "other.test", value: "x", status: "ok" }]),
        }),
      ).get(request),
    ).rejects.toBeInstanceOf(ProjectMailDomainsUnavailableError);
    await expect(port(row()).configure({} as never)).rejects.toBeInstanceOf(
      ProjectMailDomainsUnavailableError,
    );
  });
});
