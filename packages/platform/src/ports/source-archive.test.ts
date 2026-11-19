import { describe, expect, expectTypeOf, it } from "vitest";

import { parseUlid } from "../shared/index.js";

import type * as PublicPlatform from "../index.js";
import type { Ulid } from "../shared/index.js";
import type * as PublicPorts from "./index.js";
import type { ProviderMutationContext } from "./providers.js";
import type {
  ExactSourceIdentity,
  SourceArchiveAcquireInput,
  SourceArchiveCommit,
  SourceArchiveIdentity,
  SourceArchiveProvider,
  SourceArchiveReceipt,
  SourceRepositoryLocator,
  SourceArchiveSink,
  SourceArchiveWriter,
} from "./source-archive.js";

const context: ProviderMutationContext = {
  operationId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
  idempotencyKey: "source:01ARZ3NDEKTSV4RRFFQ69G5FAV",
  projectId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
  environmentId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
};

const source: ExactSourceIdentity = {
  provider: "github",
  sourceConnectionId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAZ"),
  externalRepositoryId: "987654",
  repository: {
    owner: "acme",
    name: "widget",
  },
  requestedCommitSha: "0123456789abcdef0123456789abcdef01234567",
};

const identity: SourceArchiveIdentity = { context, source };
const otherOperationIdentity: SourceArchiveIdentity = {
  context: {
    ...context,
    operationId: parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAY"),
    idempotencyKey: "source:01ARZ3NDEKTSV4RRFFQ69G5FAY",
  },
  source,
};

const receipt: SourceArchiveReceipt = {
  identity,
  archiveId: "archive-123",
  archiveFormat: "tar.gz",
  byteLength: 7,
  sha256: "f".repeat(64),
};

describe("source archive provider port", () => {
  it("streams one exact source into a durable sink and returns its receipt", async () => {
    const events: string[] = [];
    const writer: SourceArchiveWriter = {
      write: async (chunk) => {
        events.push(`write:${new TextDecoder().decode(chunk)}`);
      },
      commit: async (metadata) => {
        events.push(`commit:${metadata.sha256}`);
        return receipt;
      },
      abort: async () => {
        events.push("abort");
      },
    };
    const sink: SourceArchiveSink = {
      observe: async (receivedIdentity) => (receivedIdentity === identity ? null : receipt),
      begin: async (receivedIdentity) => {
        expect(receivedIdentity).toBe(identity);
        events.push("begin");
        return writer;
      },
    };
    const provider: SourceArchiveProvider = {
      acquireExact: async (input, archiveSink) => {
        const existing = await archiveSink.observe(input.identity);
        if (existing !== null) return existing;
        const archiveWriter = await archiveSink.begin(input.identity);
        await archiveWriter.write(new TextEncoder().encode("archive"));
        return archiveWriter.commit({
          archiveFormat: "tar.gz",
          byteLength: 7,
          sha256: "f".repeat(64),
        });
      },
    };
    const input: SourceArchiveAcquireInput = {
      identity,
      maxBytes: 10_000_000,
      deadline: new Date("2026-01-01T00:05:00.000Z"),
    };

    await expect(provider.acquireExact(input, sink)).resolves.toBe(receipt);
    expect(events).toEqual(["begin", "write:archive", `commit:${"f".repeat(64)}`]);
  });

  it("scopes replay observation to the mutation and exposes abort for failed acquisition", async () => {
    const aborted: SourceArchiveIdentity[] = [];
    const writer: SourceArchiveWriter = {
      write: async () => undefined,
      commit: async () => receipt,
      abort: async () => {
        aborted.push(identity);
      },
    };
    const sink: SourceArchiveSink = {
      observe: async (receivedIdentity) =>
        receivedIdentity.context.operationId === context.operationId ? receipt : null,
      begin: async () => writer,
    };

    await expect(sink.observe(identity)).resolves.toBe(receipt);
    await expect(sink.observe(otherOperationIdentity)).resolves.toBeNull();
    await (await sink.begin(identity)).abort();
    expect(aborted).toEqual([identity]);
  });

  it("contains no credential, branch, ref, redirect, or raw-byte field in input or receipt", () => {
    expectTypeOf<keyof ExactSourceIdentity>().toEqualTypeOf<
      | "provider"
      | "sourceConnectionId"
      | "externalRepositoryId"
      | "repository"
      | "requestedCommitSha"
    >();
    expectTypeOf<keyof SourceArchiveAcquireInput>().toEqualTypeOf<
      "identity" | "maxBytes" | "deadline"
    >();
    expectTypeOf<keyof SourceArchiveIdentity>().toEqualTypeOf<"context" | "source">();
    expectTypeOf<ExactSourceIdentity["sourceConnectionId"]>().toEqualTypeOf<Ulid>();
    expectTypeOf<keyof SourceRepositoryLocator>().toEqualTypeOf<"owner" | "name">();
    expectTypeOf<keyof SourceArchiveCommit>().toEqualTypeOf<
      "archiveFormat" | "byteLength" | "sha256"
    >();
    expectTypeOf<keyof SourceArchiveReceipt>().toEqualTypeOf<
      "identity" | "archiveId" | "archiveFormat" | "byteLength" | "sha256"
    >();
    expect(Object.keys(source).sort()).toEqual([
      "externalRepositoryId",
      "provider",
      "repository",
      "requestedCommitSha",
      "sourceConnectionId",
    ]);
    expect(Object.keys(receipt).sort()).toEqual([
      "archiveFormat",
      "archiveId",
      "byteLength",
      "identity",
      "sha256",
    ]);
    expect(Object.keys(identity).sort()).toEqual(["context", "source"]);
    expect(Object.keys(source.repository).sort()).toEqual(["name", "owner"]);
  });

  it("uses the existing mutation context and exports every port from both public entry points", () => {
    expectTypeOf<SourceArchiveIdentity["context"]>().toEqualTypeOf<ProviderMutationContext>();
    expectTypeOf<SourceArchiveReceipt["identity"]>().toEqualTypeOf<SourceArchiveIdentity>();
    expectTypeOf<Parameters<SourceArchiveProvider["acquireExact"]>>().toEqualTypeOf<
      [input: SourceArchiveAcquireInput, sink: SourceArchiveSink]
    >();
    expectTypeOf<ReturnType<SourceArchiveProvider["acquireExact"]>>().toEqualTypeOf<
      Promise<SourceArchiveReceipt>
    >();
    expectTypeOf<
      Parameters<SourceArchiveWriter["commit"]>[0]
    >().toEqualTypeOf<SourceArchiveCommit>();
    expectTypeOf<PublicPorts.SourceArchiveProvider>().toEqualTypeOf<SourceArchiveProvider>();
    expectTypeOf<PublicPlatform.SourceArchiveProvider>().toEqualTypeOf<SourceArchiveProvider>();
  });
});
