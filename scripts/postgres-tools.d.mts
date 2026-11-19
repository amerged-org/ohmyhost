export const MAX_ARCHIVE_BYTES: number;
export function parsePostgresProofConnection(value: string): {
  readonly environment: Readonly<Record<string, string>>;
  readonly identity: {
    readonly host: string;
    readonly port: string;
    readonly database: string;
    readonly sslMode: string;
    readonly direct: true;
  };
};
export function parsePgcfProofConnection(
  value: string,
  target:
    | string
    | {
        readonly provider: "pgcf";
        readonly host: string;
        readonly databaseId: string;
        readonly role: string;
      },
): ReturnType<typeof parsePostgresProofConnection>;
export function openPostgresProofConnection(
  value: string,
  target?:
    | string
    | {
        readonly provider: "pgcf";
        readonly host: string;
        readonly databaseId: string;
        readonly role: string;
      },
): Promise<ReturnType<typeof parsePostgresProofConnection> & { close(): Promise<void> }>;
interface CommandOptions {
  readonly maximumBytes?: number;
  readonly input?: Uint8Array;
  readonly signal?: AbortSignal;
}
export function runPostgresCommand(
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  options: CommandOptions & { readonly binary: true },
): Promise<Buffer>;
export function runPostgresCommand(
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  options?: CommandOptions & { readonly binary?: false },
): Promise<string>;
