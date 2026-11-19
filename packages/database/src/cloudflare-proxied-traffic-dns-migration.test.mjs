import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/066_cloudflare_proxied_traffic_dns.mjs";

function recorder() {
  return { addConstraint: vi.fn(), dropConstraint: vi.fn(), sql: vi.fn() };
}

describe("Cloudflare proxied traffic DNS migration", () => {
  it("allows only proxied CNAME Auto TTL while preserving legacy unproxied receipts", () => {
    const pgm = recorder();

    up(pgm);

    expect(pgm.dropConstraint).toHaveBeenCalledWith(
      "cloudflare_project_domain_receipts",
      "cloudflare_project_domain_receipts_kind_check",
    );
    const check = pgm.addConstraint.mock.calls[0]?.[2]?.check;
    expect(check).toContain("dns_type='CNAME' AND dns_ttl=1 AND dns_proxied=true");
    expect(check).toContain("dns_ttl BETWEEN 60 AND 86400 AND dns_proxied=false");
  });

  it("refuses a lossy downgrade and restores the legacy receipt predicate", () => {
    const pgm = recorder();

    down(pgm);

    expect(pgm.sql.mock.calls[0]?.[0]).toContain(
      "Proxied Cloudflare traffic DNS evidence prevents a lossless downgrade",
    );
    const check = pgm.addConstraint.mock.calls[0]?.[2]?.check;
    expect(check).not.toContain("dns_proxied=true");
    expect(check).toContain("dns_ttl BETWEEN 60 AND 86400 AND dns_proxied=false");
  });
});
