import { describe, expect, it } from "vitest";
import { createResendProvider } from "@ohmyhost/provider-resend";
import { findCreatedDomain, hasSendingKey, revokeUnrecordedSendingKeys } from "./resend-keys.js";

describe("uncertain Resend sending-key recovery", () => {
  it("scans all pages and revokes only keys named for the exact owned domain", async () => {
    const deleted: string[] = [];
    const provider = createResendProvider({
      apiKey: "re_admin",
      fetch: async (url, init) => {
        const request = new Request(url, init);
        if (request.method === "DELETE") {
          const id = request.url.split("/").at(-1) ?? "";
          deleted.push(id);
          return Response.json({ id, deleted: true });
        }
        if (new URL(request.url).searchParams.has("after"))
          return Response.json({
            object: "list",
            has_more: false,
            data: [
              { id: "wanted", name: "ohmyho:01H0000000000000000000060E" },
              { id: "foreign", name: "ohmyho:other" },
            ],
          });
        return Response.json({
          object: "list",
          has_more: true,
          data: [{ id: "first", name: "unrelated" }],
        });
      },
    });
    await revokeUnrecordedSendingKeys(provider, "01H0000000000000000000060E");
    expect(deleted).toEqual(["wanted"]);
  });
  it("does not authorize recreation from an incomplete provider inventory", async () => {
    const provider = createResendProvider({
      apiKey: "re_admin",
      fetch: async () => Response.json({ object: "list", has_more: true, data: [] }),
    });
    await expect(
      revokeUnrecordedSendingKeys(provider, "01H0000000000000000000060E"),
    ).rejects.toThrow("mail_key_inventory_invalid");
  });
});

type Page = { has_more: boolean; data: Record<string, string>[] };
/** A provider whose list endpoints answer with the page chosen by the `after` cursor. */
function listing(pages: (after: string | null) => Page) {
  return createResendProvider({
    apiKey: "re_admin",
    fetch: async (url) =>
      Response.json({
        object: "list",
        ...pages(new URL(String(url)).searchParams.get("after")),
      }),
  });
}

describe("sending-key inventory read-back", () => {
  const domainId = "01H0000000000000000000060E";
  it("finds a key by the row's deterministic name or by its recorded id, across pages", async () => {
    const byName = listing((after) =>
      after === null
        ? { has_more: true, data: [{ id: "first", name: "unrelated" }] }
        : { has_more: false, data: [{ id: "second", name: `ohmyho:${domainId}` }] },
    );
    expect(await hasSendingKey(byName, domainId, null)).toBe(true);
    const byId = listing(() => ({ has_more: false, data: [{ id: "recorded", name: "renamed" }] }));
    expect(await hasSendingKey(byId, domainId, "recorded")).toBe(true);
  });
  it("reports absence only from a complete inventory", async () => {
    const empty = listing(() => ({ has_more: false, data: [{ id: "other", name: "other" }] }));
    expect(await hasSendingKey(empty, domainId, "recorded")).toBe(false);
    const stuck = listing(() => ({ has_more: true, data: [] }));
    await expect(hasSendingKey(stuck, domainId, null)).rejects.toThrow(
      "mail_key_inventory_invalid",
    );
    let page = 0;
    const endless = listing(() => ({
      has_more: true,
      data: [{ id: `key-${page++}`, name: "other" }],
    }));
    await expect(hasSendingKey(endless, domainId, null)).rejects.toThrow(
      "mail_key_inventory_incomplete",
    );
  });
});

describe("recovering an unrecorded domain creation", () => {
  const preflight = new Date("2026-10-29T10:00:00.000Z");
  const domain = (id: string, createdAt: string) => ({
    id,
    name: "mail.example.com",
    created_at: createdAt,
  });
  it("returns the one domain created from the preflight on, also from a later page", async () => {
    const paged = listing((after) =>
      after === null
        ? {
            has_more: true,
            data: [
              { id: "other", name: "other.example.com", created_at: "2026-10-29T10:00:00.000Z" },
            ],
          }
        : { has_more: false, data: [domain("mine", "2026-10-29T10:00:30.000Z")] },
    );
    expect(await findCreatedDomain(paged, "mail.example.com", preflight)).toBe("mine");
  });
  it("does not adopt a domain that predates the preflight or an ambiguous inventory", async () => {
    const old = listing(() => ({
      has_more: false,
      data: [domain("older", "2026-10-29T09:50:00.000Z")],
    }));
    expect(await findCreatedDomain(old, "mail.example.com", preflight)).toBeNull();
    const none = listing(() => ({ has_more: false, data: [] }));
    expect(await findCreatedDomain(none, "mail.example.com", preflight)).toBeNull();
    const twice = listing(() => ({
      has_more: false,
      data: [domain("a", "2026-10-29T10:00:30.000Z"), domain("b", "2026-10-29T10:00:31.000Z")],
    }));
    await expect(findCreatedDomain(twice, "mail.example.com", preflight)).rejects.toThrow(
      "mail_provider_domain_inventory_conflict",
    );
    const stuck = listing(() => ({ has_more: true, data: [] }));
    await expect(findCreatedDomain(stuck, "mail.example.com", preflight)).rejects.toThrow(
      "mail_provider_domain_inventory_incomplete",
    );
    let page = 0;
    const endless = listing(() => ({
      has_more: true,
      data: [
        {
          id: `domain-${page++}`,
          name: "other.example.com",
          created_at: "2026-10-29T10:00:00.000Z",
        },
      ],
    }));
    await expect(findCreatedDomain(endless, "mail.example.com", preflight)).rejects.toThrow(
      "mail_provider_domain_inventory_incomplete",
    );
  });
});
