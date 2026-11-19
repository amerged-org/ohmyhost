import { describe, expect, it } from "vitest";
import { createManagedMailPort, ManagedMailPortError } from "../src/managed-mail.js";

describe("managed-mail private boundary", () => {
  it("routes every authorized mail action through its exact private capability", async () => {
    const calls: string[] = [];
    const call = (name: string) => async (input: unknown) => {
      calls.push(name);
      return { name, input };
    };
    const port = createManagedMailPort(
      {
        configureMailDomain: call("configure"),
        readMailDomain: call("read"),
        prepareMailWebhook: call("prepare"),
        verifyMailWebhook: call("verify"),
        rotateMailWebhook: call("rotate"),
        disableMailReceiving: call("disable"),
        deleteMailDomain: call("delete"),
      },
      {
        listMailMessages: call("list"),
        getMailMessage: call("get"),
        getMailAttachment: call("attachment"),
        retryMailMessage: call("retry"),
      },
    );
    const input = { projectId: "owned-project" };
    const methods = [
      "configureMailDomain",
      "readMailDomain",
      "prepareMailWebhook",
      "verifyMailWebhook",
      "rotateMailWebhook",
      "disableMailReceiving",
      "deleteMailDomain",
      "listMailMessages",
      "getMailMessage",
      "getMailAttachment",
      "retryMailMessage",
    ] as const;
    for (const method of methods) expect(await port[method](input)).toMatchObject({ input });
    expect(calls).toEqual([
      "configure",
      "read",
      "prepare",
      "verify",
      "rotate",
      "disable",
      "delete",
      "list",
      "get",
      "attachment",
      "retry",
    ]);
  });
  it("returns an actionable 413 for a bounded attachment without exposing provider data", async () => {
    const unavailable = async () => {
      throw new Error("unused");
    };
    const port = createManagedMailPort(
      {
        configureMailDomain: unavailable,
        readMailDomain: unavailable,
        prepareMailWebhook: unavailable,
        verifyMailWebhook: unavailable,
        rotateMailWebhook: unavailable,
        disableMailReceiving: unavailable,
        deleteMailDomain: unavailable,
      },
      {
        listMailMessages: unavailable,
        getMailMessage: unavailable,
        getMailAttachment: async () => {
          throw new Error("mail_attachment_too_large");
        },
        retryMailMessage: unavailable,
      },
    );
    await expect(port.getMailAttachment({})).rejects.toMatchObject({
      status: 413,
      code: "payload_too_large",
      message: "This mail attachment exceeds the 50 MiB download limit.",
    } satisfies Partial<ManagedMailPortError>);
  });
  it("names the platform's mail domain capacity instead of a generic retry", async () => {
    const refused = async () => {
      throw new Error("mail_provider_capacity_reached");
    };
    const port = createManagedMailPort(
      {
        configureMailDomain: refused,
        readMailDomain: refused,
        prepareMailWebhook: refused,
        verifyMailWebhook: refused,
        rotateMailWebhook: refused,
        disableMailReceiving: refused,
        deleteMailDomain: refused,
      },
      {
        listMailMessages: refused,
        getMailMessage: refused,
        getMailAttachment: refused,
        retryMailMessage: refused,
      },
    );
    const error = await port.configureMailDomain({}).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      status: 503,
      code: "mail_capacity_unavailable",
      retryable: true,
    } satisfies Partial<ManagedMailPortError>);
    // Customers are never told to upgrade the platform's own provider account.
    expect(String((error as Error).message)).not.toMatch(/upgrade|plan/iu);
    const failing = (message: string) =>
      createManagedMailPort(
        {
          configureMailDomain: async () => {
            throw new Error(message);
          },
          readMailDomain: refused,
          prepareMailWebhook: refused,
          verifyMailWebhook: refused,
          rotateMailWebhook: refused,
          disableMailReceiving: refused,
          deleteMailDomain: refused,
        },
        {
          listMailMessages: refused,
          getMailMessage: refused,
          getMailAttachment: refused,
          retryMailMessage: refused,
        },
      ).configureMailDomain({});
    await expect(failing("A customer mail domain is required")).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
      retryable: false,
    });
    // An ordinary setup's receipt mismatch never claims that mail is already off.
    await expect(failing("mail_domain_receipt_mismatch")).rejects.toMatchObject({
      code: "service_unavailable",
      message: "Mail is temporarily unavailable. Retry with the same request identity.",
    });
    await expect(failing("mail_retirement_pending")).rejects.toMatchObject({
      status: 409,
      code: "mail_domain_conflict",
    });
  });
});
