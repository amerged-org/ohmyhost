/* v8 ignore file -- compile-time contract; exercised by TypeScript tests */

import type { Ulid } from "../shared/index.js";
import type { ProviderMutationContext } from "./providers.js";

export interface SourceRepositoryLocator {
  readonly owner: string;
  readonly name: string;
}

export interface ExactSourceIdentity {
  readonly provider: string;
  readonly sourceConnectionId: Ulid;
  readonly externalRepositoryId: string;
  readonly repository: SourceRepositoryLocator;
  readonly requestedCommitSha: string;
}

export interface SourceArchiveIdentity {
  readonly context: ProviderMutationContext;
  readonly source: ExactSourceIdentity;
}

export interface SourceArchiveAcquireInput {
  readonly identity: SourceArchiveIdentity;
  /** A positive safe integer that the provider must enforce while streaming. */
  readonly maxBytes: number;
  readonly deadline: Date;
}

export interface SourceArchiveCommit {
  readonly archiveFormat: "tar.gz";
  /** A positive safe integer equal to the number of bytes written and no greater than maxBytes. */
  readonly byteLength: number;
  /** The lowercase 64-hex SHA-256 digest of the written bytes. */
  readonly sha256: string;
}

export interface SourceArchiveReceipt extends SourceArchiveCommit {
  /** The operation-scoped identity used to authorize and observe this durable receipt. */
  readonly identity: SourceArchiveIdentity;
  /** Opaque durable sink identity; never a provider redirect or credential-bearing URL. */
  readonly archiveId: string;
}

export interface SourceArchiveWriter {
  write(chunk: Uint8Array): Promise<void>;
  commit(metadata: SourceArchiveCommit): Promise<SourceArchiveReceipt>;
  abort(): Promise<void>;
}

export interface SourceArchiveSink {
  observe(identity: SourceArchiveIdentity): Promise<SourceArchiveReceipt | null>;
  begin(identity: SourceArchiveIdentity): Promise<SourceArchiveWriter>;
}

export interface SourceArchiveProvider {
  acquireExact(
    input: SourceArchiveAcquireInput,
    sink: SourceArchiveSink,
  ): Promise<SourceArchiveReceipt>;
}
