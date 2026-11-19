import { createHmac, webcrypto } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { GithubProviderAuthenticationError, GithubProviderInputError } from "./errors.js";
import {
  parseGitHubInstallationWebhook,
  parseGitHubPushWebhook,
  verifyGitHubPushWebhook,
  verifyGitHubWebhookSignature,
} from "./webhooks.js";

const SECRET = new TextEncoder().encode("fixture-webhook-secret");
const ADDITIONAL_SECRET = new TextEncoder().encode("fixture-additional-webhook-secret");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const BEFORE_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const subtle = webcrypto.subtle as unknown as SubtleCrypto;

function raw(payload: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

function sign(bytes: Uint8Array, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`;
}

function payload(overrides: Record<string, unknown> = {}): unknown {
  return {
    installation: { id: 123 },
    repository: { id: 987_654, full_name: "acme/widget" },
    ref: "refs/heads/main",
    deleted: false,
    before: BEFORE_SHA,
    after: SHA,
    pusher: { name: "must-not-be-retained", email: "private@example.test" },
    ...overrides,
  };
}

async function verify(body: Uint8Array, overrides: Record<string, unknown> = {}) {
  return verifyGitHubPushWebhook({
    body,
    signatureHeader: sign(body),
    secret: SECRET,
    deliveryId: "delivery-123",
    eventName: "push",
    maxBodyBytes: 50_000,
    crypto: subtle,
    ...overrides,
  });
}

describe("GitHub push webhook verifier", () => {
  it("verifies both bounded rollover keys over the same raw bytes and parses only once after authentication", async () => {
    const body = raw(payload());
    const parsing = vi.spyOn(JSON, "parse");
    const verification = vi.spyOn(subtle, "verify");
    try {
      for (const signingSecret of [SECRET, ADDITIONAL_SECRET]) {
        parsing.mockClear();
        verification.mockClear();
        const trigger = await verify(body, {
          signatureHeader: sign(body, signingSecret),
          additionalSecrets: [ADDITIONAL_SECRET],
        });
        expect(parsing).toHaveBeenCalledTimes(1);
        expect(verification).toHaveBeenCalledTimes(2);
        expect(trigger).toMatchObject({ schemaVersion: "github.push.v1", commitSha: SHA });
        expect(Object.isFrozen(trigger)).toBe(true);
      }
      for (const [candidate, signatureHeader, additionalSecrets] of [
        [body, sign(body, ADDITIONAL_SECRET), []],
        [new Uint8Array([...body, 0x20]), sign(body, ADDITIONAL_SECRET), [ADDITIONAL_SECRET]],
        [
          body,
          sign(body, new TextEncoder().encode("fixture-unrelated-secret")),
          [ADDITIONAL_SECRET],
        ],
      ] as const) {
        parsing.mockClear();
        await expect(
          verify(candidate, { signatureHeader, additionalSecrets }),
        ).rejects.toBeInstanceOf(GithubProviderAuthenticationError);
        expect(parsing).not.toHaveBeenCalled();
      }
    } finally {
      verification.mockRestore();
      parsing.mockRestore();
    }
  });

  it("requires the primary key and rejects malformed or excess rollover keys before cryptography", async () => {
    const body = raw(payload());
    const crypto = { importKey: vi.fn(), verify: vi.fn() } as unknown as SubtleCrypto;
    for (const overrides of [
      { additionalSecrets: null },
      { additionalSecrets: "fixture-not-an-array" },
      { additionalSecrets: [new Uint8Array()] },
      { additionalSecrets: ["fixture-not-bytes"] },
      { additionalSecrets: Array<Uint8Array>(1) },
      { additionalSecrets: [ADDITIONAL_SECRET, ADDITIONAL_SECRET] },
      { secret: new Uint8Array(), additionalSecrets: [ADDITIONAL_SECRET] },
    ]) {
      await expect(verify(body, { ...overrides, crypto })).rejects.toMatchObject({
        code: "invalid_webhook_secret",
      });
    }
    await expect(
      verify(body, {
        additionalSecrets: [ADDITIONAL_SECRET],
        crypto,
        maxBodyBytes: body.length - 1,
      }),
    ).rejects.toMatchObject({ code: "webhook_body_too_large" });
    await expect(
      verify(body, { additionalSecrets: [ADDITIONAL_SECRET], crypto, signatureHeader: "invalid" }),
    ).rejects.toBeInstanceOf(GithubProviderAuthenticationError);
    expect(crypto.importKey).not.toHaveBeenCalled();
    expect(crypto.verify).not.toHaveBeenCalled();
    await expect(verify(body, { additionalSecrets: [] })).resolves.toBeDefined();
    const detached = new Uint8Array([0x7b]);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    await expect(
      verifyGitHubWebhookSignature({
        body: detached,
        signatureHeader: sign(new Uint8Array()),
        secret: SECRET,
        maxBodyBytes: 50_000,
        crypto: subtle,
      }),
    ).rejects.toBeInstanceOf(GithubProviderAuthenticationError);
  });

  it("parses the authenticated snapshot even if the caller mutates its body during verification", async () => {
    const body = raw(payload());
    const unsigned = raw(payload({ after: BEFORE_SHA }));
    const signatureHeader = sign(body);
    expect(unsigned.length).toBe(body.length);
    const crypto = {
      importKey: subtle.importKey.bind(subtle),
      verify: async (...args: Parameters<SubtleCrypto["verify"]>) => {
        body.set(unsigned);
        return subtle.verify(...args);
      },
    } as unknown as SubtleCrypto;
    const trigger = await verify(body, { signatureHeader, crypto });
    expect(trigger.commitSha).toBe(SHA);
  });

  it("verifies raw bytes before parsing and returns an exact frozen minimized trigger", async () => {
    const body = raw(payload());
    const trigger = await verify(body);
    expect(trigger).toEqual({
      schemaVersion: "github.push.v1",
      deliveryId: "delivery-123",
      eventName: "push",
      installationId: 123,
      repositoryId: 987_654,
      repositoryFullName: "acme/widget",
      ref: "refs/heads/main",
      deleted: false,
      beforeCommitSha: BEFORE_SHA,
      commitSha: SHA,
    });
    expect(Object.isFrozen(trigger)).toBe(true);
    expect(JSON.stringify(trigger)).not.toContain("private@example.test");
  });

  it("keeps signature authentication separate from event-specific parsing", async () => {
    const body = raw({ zen: "authenticated ping payload" });
    await expect(
      verifyGitHubWebhookSignature({
        body,
        signatureHeader: sign(body),
        secret: SECRET,
        maxBodyBytes: 50_000,
        crypto: subtle,
      }),
    ).resolves.toBeUndefined();
    expect(() =>
      parseGitHubPushWebhook({ deliveryId: "delivery-123", eventName: "ping", body }),
    ).toThrow(GithubProviderInputError);
  });

  it("accepts owner/name identity and omits commit SHA for deletion", async () => {
    const body = raw(
      payload({
        repository: { id: 987_654, owner: { login: "acme" }, name: "widget" },
        deleted: true,
        after: "0".repeat(40),
      }),
    );
    await expect(verify(body)).resolves.toEqual({
      schemaVersion: "github.push.v1",
      deliveryId: "delivery-123",
      eventName: "push",
      installationId: 123,
      repositoryId: 987_654,
      repositoryFullName: "acme/widget",
      ref: "refs/heads/main",
      deleted: true,
      beforeCommitSha: BEFORE_SHA,
    });
  });

  it("normalizes GitHub's all-zero before sentinel for branch creation", async () => {
    const body = raw(payload({ before: "0".repeat(40) }));
    await expect(verify(body)).resolves.toMatchObject({
      schemaVersion: "github.push.v1",
      beforeCommitSha: null,
      commitSha: SHA,
      deleted: false,
    });
  });

  it("rejects a signature over different raw bytes before JSON parsing", async () => {
    const signed = raw(payload());
    const changed = new Uint8Array([...signed, 0x20]);
    await expect(
      verifyGitHubPushWebhook({
        body: changed,
        signatureHeader: sign(signed),
        secret: SECRET,
        deliveryId: "delivery-123",
        eventName: "push",
        maxBodyBytes: 50_000,
        crypto: subtle,
      }),
    ).rejects.toBeInstanceOf(GithubProviderAuthenticationError);
  });

  it.each([
    ["uppercase signature", `sha256=${"A".repeat(64)}`],
    ["wrong prefix", `SHA256=${"a".repeat(64)}`],
    ["extra signature", `sha256=${"a".repeat(64)},sha256=${"b".repeat(64)}`],
  ])("rejects malformed signature: %s", async (_name, signatureHeader) => {
    const body = raw(payload());
    await expect(verify(body, { signatureHeader })).rejects.toBeInstanceOf(
      GithubProviderAuthenticationError,
    );
  });

  it("redacts WebCrypto verification failures", async () => {
    const body = raw(payload());
    const crypto = {
      importKey: async () => {
        throw new Error("secret implementation detail");
      },
    } as unknown as SubtleCrypto;
    const failure = await verifyGitHubWebhookSignature({
      body,
      signatureHeader: sign(body),
      secret: SECRET,
      maxBodyBytes: 50_000,
      crypto,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GithubProviderAuthenticationError);
    expect(String(failure)).not.toContain("implementation detail");
  });

  it("rejects oversize before cryptography or parsing", async () => {
    const body = raw(payload());
    await expect(verify(body, { maxBodyBytes: body.byteLength - 1 })).rejects.toMatchObject({
      code: "webhook_body_too_large",
    });
  });

  it.each([
    ["non-push event", payload(), { eventName: "issues" }],
    ["malformed JSON", new Uint8Array([0xff]), {}],
    ["missing installation", payload({ installation: undefined }), {}],
    ["invalid ref", payload({ ref: "x".repeat(1_025) }), {}],
    ["non-deletion zero SHA", payload({ after: "0".repeat(40) }), {}],
    ["deletion with nonzero SHA", payload({ deleted: true }), {}],
    [
      "deletion with zero before SHA",
      payload({ deleted: true, before: "0".repeat(40), after: "0".repeat(40) }),
      {},
    ],
    ["malformed before SHA", payload({ before: "not-a-sha" }), {}],
    [
      "invalid repository identity",
      payload({ repository: { id: 987_654, full_name: "bad/name/extra" } }),
      {},
    ],
  ])("rejects invalid push payload: %s", async (_name, value, overrides) => {
    const body = value instanceof Uint8Array ? value : raw(value);
    await expect(verify(body, overrides)).rejects.toBeInstanceOf(GithubProviderInputError);
  });
});

describe("GitHub installation webhooks", () => {
  const body = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

  it("reads only the ids of the events that withdraw access, and ignores the rest", () => {
    expect(
      parseGitHubInstallationWebhook({
        eventName: "installation",
        body: body({ action: "deleted", installation: { id: 123 }, sender: { login: "private" } }),
      }),
    ).toEqual({
      schemaVersion: "github.installation.v1",
      eventName: "installation",
      action: "deleted",
      installationId: 123,
      removedRepositoryIds: [],
    });
    expect(
      parseGitHubInstallationWebhook({
        eventName: "installation",
        body: body({ action: "suspend", installation: { id: 123 } }),
      }),
    ).toMatchObject({ action: "suspended", installationId: 123 });
    expect(
      parseGitHubInstallationWebhook({
        eventName: "installation_repositories",
        body: body({
          action: "removed",
          installation: { id: 123 },
          repositories_removed: [{ id: 77 }, { id: 78 }],
        }),
      }),
    ).toEqual({
      schemaVersion: "github.installation.v1",
      eventName: "installation_repositories",
      action: "repositories_removed",
      installationId: 123,
      removedRepositoryIds: [77, 78],
    });
    for (const ignored of [
      { eventName: "installation", action: "created" },
      { eventName: "installation", action: "unsuspend" },
      { eventName: "installation_repositories", action: "added" },
    ]) {
      expect(
        parseGitHubInstallationWebhook({
          eventName: ignored.eventName,
          body: body({ action: ignored.action, installation: { id: 123 } }),
        }),
      ).toBeNull();
    }
  });

  it("refuses a withdrawing event that does not name a valid installation", () => {
    expect(() =>
      parseGitHubInstallationWebhook({
        eventName: "installation",
        body: new TextEncoder().encode("not json"),
      }),
    ).toThrow(GithubProviderInputError);
    expect(() =>
      parseGitHubInstallationWebhook({
        eventName: "installation",
        body: body({ action: "deleted", installation: { id: 0 } }),
      }),
    ).toThrow(GithubProviderInputError);
    expect(
      parseGitHubInstallationWebhook({
        eventName: "installation_repositories",
        body: body({ action: "removed", installation: { id: 123 }, repositories_removed: [] }),
      }),
    ).toBeNull();
  });
});
