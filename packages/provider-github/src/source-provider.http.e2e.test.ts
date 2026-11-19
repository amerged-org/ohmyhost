import { generateKeyPairSync, webcrypto } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { deflateSync, gzipSync } from "node:zlib";

import type {
  ExactSourceIdentity,
  ProviderMutationContext,
  SourceArchiveReceipt,
  SourceArchiveSink,
} from "@ohmyhost/platform";
import { parseUlid } from "@ohmyhost/platform";
import { describe, expect, it } from "vitest";

import { createGitHubAppJwtIssuer, createGitHubSourceArchiveProvider } from "./source-provider.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const INSTALLATION_TOKEN = "opaque-local-installation-token";
const ARCHIVE = new TextEncoder().encode("streamed local HTTP archive fixture");
const SOURCE: ExactSourceIdentity = Object.freeze({
  provider: "github",
  sourceConnectionId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAT"),
  externalRepositoryId: "987654",
  repository: Object.freeze({ owner: "acme", name: "widget" }),
  requestedCommitSha: SHA,
});
const CONTEXT: ProviderMutationContext = Object.freeze({
  operationId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
  projectId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
  environmentId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
  idempotencyKey: "github-http-e2e",
});
const IDENTITY = Object.freeze({ context: CONTEXT, source: SOURCE });

describe("GitHub SourceArchiveProvider local HTTP E2E", () => {
  it("runs JWT, scoped token, exact commit, stripped redirect, stream commit, and replay", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKey = await webcrypto.subtle.importKey(
      "pkcs8",
      pair.privateKey.export({ format: "der", type: "pkcs8" }),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const publicKey = await webcrypto.subtle.importKey(
      "spki",
      pair.publicKey.export({ format: "der", type: "spki" }),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const requests: Array<Readonly<{ path: string; authorization: string | undefined }>> = [];
    let serverFailure: string | undefined;

    const server = createServer(async (request, response) => {
      const path = request.url ?? "";
      const authorization = request.headers.authorization;
      requests.push({ path, authorization });
      try {
        if (path === "/api.github.com/app/installations/123/access_tokens") {
          if (request.method !== "POST" || authorization === undefined) {
            throw new Error("installation request method or authorization is missing");
          }
          const jwt = authorization.replace(/^Bearer /u, "");
          const [header, payload, signature] = jwt.split(".");
          if (header === undefined || payload === undefined || signature === undefined) {
            throw new Error("App JWT is malformed");
          }
          const valid = await webcrypto.subtle.verify(
            "RSASSA-PKCS1-v1_5",
            publicKey,
            Buffer.from(signature, "base64url"),
            Buffer.from(`${header}.${payload}`),
          );
          const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
            string,
            unknown
          >;
          if (
            !valid ||
            claims["iss"] !== "Iv1.local-e2e" ||
            claims["iat"] !== Math.floor(NOW.getTime() / 1_000) - 60 ||
            claims["exp"] !== Math.floor(NOW.getTime() / 1_000) + 540
          ) {
            throw new Error("App JWT claims or signature are invalid");
          }
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const tokenRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (
            JSON.stringify(tokenRequest) !==
            JSON.stringify({ repository_ids: [987_654], permissions: { contents: "read" } })
          ) {
            throw new Error("installation token scope is invalid");
          }
          const tokenBody = deflateSync(
            JSON.stringify({
              token: INSTALLATION_TOKEN,
              expires_at: "2026-08-19T12:59:59.000Z",
              repository_selection: "selected",
              repositories: [{ id: 987_654 }],
              permissions: { contents: "read" },
            }),
          );
          response.writeHead(201, {
            "Content-Type": "application/json",
            "Content-Encoding": "deflate",
            "Content-Length": String(tokenBody.byteLength),
          });
          response.end(tokenBody);
          return;
        }
        if (path === `/api.github.com/repos/acme/widget/commits/${SHA}`) {
          if (authorization !== `Bearer ${INSTALLATION_TOKEN}`) {
            throw new Error("commit request lacks the scoped installation token");
          }
          if (request.headers.accept !== "application/vnd.github.sha") {
            throw new Error("commit request did not select GitHub's bounded SHA representation");
          }
          const commitBody = gzipSync(SHA);
          response.writeHead(200, {
            "Content-Type": "application/vnd.github.sha",
            "Content-Encoding": "gzip",
            "Content-Length": String(commitBody.byteLength),
          });
          response.end(commitBody);
          return;
        }
        if (path === `/api.github.com/repos/acme/widget/tarball/${SHA}`) {
          if (authorization !== `Bearer ${INSTALLATION_TOKEN}`) {
            throw new Error("tarball request lacks the scoped installation token");
          }
          response.writeHead(302, {
            Location: `https://codeload.github.com/acme/widget/legacy.tar.gz/${SHA}`,
          });
          response.end();
          return;
        }
        if (path === `/codeload.github.com/acme/widget/legacy.tar.gz/${SHA}`) {
          if (authorization !== undefined || request.headers.cookie !== undefined) {
            throw new Error("credential was forwarded to codeload");
          }
          response.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(ARCHIVE.byteLength),
          });
          const midpoint = Math.ceil(ARCHIVE.byteLength / 2);
          response.write(ARCHIVE.slice(0, midpoint));
          response.end(ARCHIVE.slice(midpoint));
          return;
        }
        response.writeHead(404).end();
      } catch (error) {
        serverFailure = error instanceof Error ? error.message : "unknown local server failure";
        response.writeHead(500).end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new TypeError("HTTP server has no port");
    const localOrigin = `http://127.0.0.1:${String(address.port)}`;
    const networkFetch: typeof globalThis.fetch = async (input, init) => {
      const providerUrl = new URL(input instanceof Request ? input.url : input.toString());
      return fetch(`${localOrigin}/${providerUrl.hostname}${providerUrl.pathname}`, {
        ...init,
        redirect: "manual",
      });
    };
    let stored: SourceArchiveReceipt | null = null;
    const written: Uint8Array[] = [];
    const sink: SourceArchiveSink = {
      observe: async () => stored,
      begin: async () => ({
        write: async (chunk) => {
          written.push(chunk.slice());
        },
        commit: async (metadata) => {
          stored = Object.freeze({
            archiveId: "local-http-archive",
            identity: IDENTITY,
            ...metadata,
          });
          return stored;
        },
        abort: async () => {
          written.length = 0;
        },
      }),
    };

    try {
      const provider = createGitHubSourceArchiveProvider({
        repositoryGrantResolver: {
          resolve: async () => ({
            installationId: 123,
            repositoryId: 987_654,
            owner: "acme",
            repository: "widget",
          }),
        },
        appJwtIssuer: createGitHubAppJwtIssuer({
          clientId: "Iv1.local-e2e",
          privateKey,
          crypto: webcrypto.subtle as unknown as SubtleCrypto,
        }),
        fetch: networkFetch,
        clock: { now: () => NOW },
        userAgent: "ohmyhost-local-http-e2e",
        requestTimeoutMs: 1_000,
      });
      const input = {
        identity: IDENTITY,
        maxBytes: 1_024,
        deadline: new Date("2026-08-19T12:00:10.000Z"),
      };
      const first = await provider.acquireExact(input, sink);
      expect(first).toMatchObject({
        archiveId: "local-http-archive",
        identity: IDENTITY,
        archiveFormat: "tar.gz",
        byteLength: ARCHIVE.byteLength,
      });
      expect(Buffer.concat(written.map((chunk) => Buffer.from(chunk)))).toEqual(
        Buffer.from(ARCHIVE),
      );
      expect(first.sha256).toBe("f4027631122eab3cddfe0eba53e4179b766a7f40bf34391d6e9ca1e977d05c3d");
      expect(serverFailure).toBeUndefined();
      expect(requests).toHaveLength(4);

      await expect(provider.acquireExact(input, sink)).resolves.toBe(first);
      expect(requests).toHaveLength(4);
      expect(JSON.stringify(first)).not.toContain(INSTALLATION_TOKEN);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
