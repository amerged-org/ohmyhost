/** Trusted provider metadata, supplied independently of the credential-bearing URI. */
export interface PgcfPostgresTarget {
  readonly provider: "pgcf";
  readonly host: string;
  readonly databaseId: string;
  readonly role: string;
}

export type PgcfPostgresTargetInput = PgcfPostgresTarget | string | undefined;

/** Independently pinned retained Control identity; never authority for an app database or API. */
export interface NeonControlPostgresTarget {
  readonly provider: "neon";
  readonly host: string;
  readonly database: "control";
  readonly role: string;
}

/** A Worker secret may hold the descriptor as JSON; failures never include its input. */
export function readPgcfPostgresTarget(
  value: Exclude<PgcfPostgresTargetInput, undefined>,
): PgcfPostgresTarget {
  try {
    const target: unknown = typeof value === "string" ? JSON.parse(value) : value;
    if (target === null || typeof target !== "object" || Array.isArray(target)) throw new Error();
    const fields = target as Record<string, unknown>;
    if (
      Object.keys(fields).sort().join(",") !== "databaseId,host,provider,role" ||
      fields["provider"] !== "pgcf" ||
      typeof fields["host"] !== "string" ||
      fields["host"].length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/u.test(fields["host"]) ||
      fields["host"] === "neon.tech" ||
      fields["host"].endsWith(".neon.tech") ||
      fields["host"].endsWith(".local") ||
      fields["host"].endsWith(".internal") ||
      typeof fields["databaseId"] !== "string" ||
      !/^[a-z][a-z0-9]{19}$/u.test(fields["databaseId"]) ||
      typeof fields["role"] !== "string" ||
      !/^[a-z_][a-z0-9_]{0,62}$/u.test(fields["role"])
    )
      throw new Error();
    return Object.freeze({
      provider: "pgcf",
      host: fields["host"],
      databaseId: fields["databaseId"],
      role: fields["role"],
    });
  } catch {
    throw new TypeError("PGCF database target is invalid");
  }
}
