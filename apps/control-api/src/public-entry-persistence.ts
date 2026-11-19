export type PublicFeature = "eu" | "iso27001" | "soc2";
export type PublicVoteChoice = "up" | "down" | null;
export interface PublicContactInput {
  readonly requestId: string;
  readonly payloadSha256: string;
  readonly name: string;
  readonly email: string;
  readonly company: string;
  readonly message: string;
  readonly now: string;
  /** The caller's source bucket, derived from its address by the API (null without a usable address); the address is never stored. */
  readonly sourceBucket: number | null;
}
export interface PublicVoteInput {
  readonly key: string;
  readonly feature: PublicFeature;
  readonly choice: PublicVoteChoice;
  readonly voterSha256: string;
  readonly now: string;
  readonly sourceBucket: number | null;
}
/** Exactly the original five persistence groups; original clocks and voter/content digests stay API-owned. */
export interface PublicEntryDataPort {
  contact(input: PublicContactInput): Promise<boolean>;
  vote(input: PublicVoteInput): Promise<boolean>;
  votes(input: {
    readonly voterSha256: string;
    readonly now: string;
  }): Promise<readonly { readonly feature: unknown; readonly choice: unknown }[]>;
  stats(input: { readonly now: string }): Promise<unknown>;
  purge(input: { readonly now: string }): Promise<number>;
}
