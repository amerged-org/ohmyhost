import { supportsMakeGrantRegistration } from "./registry.js";
import { encodeBytes } from "./encoding.js";
import { ulid } from "./authorization.js";
import type { MutationAuthority } from "./ports.js";
import type { ProviderAdapter, OAuthClient } from "./adapter.js";
import type { ProviderRegistration } from "./registry.js";
import { openGrantTokens, sealGrantTokens } from "./grant-vault.js";
export function nextRefreshToken(previous: string, returned: string | undefined): string {
  return returned === undefined ? previous : returned;
}
interface Sealed {
  nonce: string;
  ciphertext: string;
  keyVersion: number;
}
interface Claim {
  grantId: string;
  claimId: string;
  generation: number;
  organizationId: string;
  projectId?: string;
  environmentId?: string;
  principalId: string;
  registration: string;
  encryptedTokens: Sealed;
}
type Fence = { grantId: string; claimId: string; generation: number };
export interface GrantLifecycleCore {
  claimConnectionRefresh(input: { grantId: string; claimId: string }): Promise<Claim | null>;
  markConnectionRefreshDispatched(input: Fence): Promise<boolean>;
  commitConnectionRefresh(input: Fence & { encryptedTokens: Sealed }): Promise<boolean>;
  retainConnectionRefreshOrphan(
    input: Fence & { encryptedTokens: Sealed },
  ): Promise<"retained" | "committed" | "conflict">;
  claimConnectionRefreshOrphanRevocation(input: {
    grantId: string;
    claimId: string;
    revocationClaimId: string;
  }): Promise<boolean>;
  markConnectionRefreshOrphanRevocationDispatched(input: {
    grantId: string;
    claimId: string;
    revocationClaimId: string;
  }): Promise<boolean>;
  finishConnectionRefreshOrphanRevocation(input: {
    grantId: string;
    claimId: string;
    revocationClaimId: string;
    outcome: "revoked" | "outcome_unknown";
  }): Promise<boolean>;
  failConnectionRefresh(
    input: Fence & { outcome: "invalid_grant" | "outcome_unknown" | "rate_limited" },
  ): Promise<boolean>;
  disconnectConnectionGrant(input: {
    organizationId: string;
    grantId: string;
    principalId: string;
    idempotencyKey: string;
    mutationAuthority: MutationAuthority;
  }): Promise<boolean>;
  readConnectionGrantStatus(input: {
    organizationId: string;
    grantId: string;
    principalId: string;
    mutationAuthority: MutationAuthority;
  }): Promise<{ state: string } | null>;
  readConnectionGrantForRevocation(input: {
    grantId: string;
  }): Promise<(Omit<Claim, "claimId"> & { revocationStatus: string }) | null>;
  claimConnectionRevocation(input: { grantId: string; claimId: string }): Promise<boolean>;
  markConnectionRevocationDispatched(input: { grantId: string; claimId: string }): Promise<boolean>;
  finishConnectionDisconnect(input: {
    grantId: string;
    claimId: string;
    outcome: "revoked" | "outcome_unknown";
  }): Promise<boolean>;
}
export interface GrantLifecycleDependencies {
  environment: "development" | "production";
  registration: ProviderRegistration;
  client: OAuthClient;
  key: Uint8Array;
  core: GrantLifecycleCore;
  adapter: ProviderAdapter;
}
const hex = (value: string) =>
  Array.from(atob(value), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
const b64 = (value: string) => {
  if (!/^(?:[a-f0-9]{2})+$/u.test(value)) throw new Error();
  return encodeBytes(Uint8Array.from(value.match(/../gu) ?? [], (v) => Number.parseInt(v, 16)));
};
export async function refreshGrant(
  grantId: string,
  deps: GrantLifecycleDependencies,
): Promise<"refreshed" | "in_progress" | "reconnect_required"> {
  const claimId = ulid(),
    claim = await deps.core.claimConnectionRefresh({ grantId, claimId });
  if (!claim) return "in_progress";
  const fence = { grantId, claimId, generation: claim.generation };
  if (
    deps.registration.provider === "make"
      ? !supportsMakeGrantRegistration(
          deps.environment,
          deps.registration.registration,
          claim.registration,
        )
      : claim.registration !== deps.registration.registration
  )
    throw new Error("invalid_grant_registration");
  const identity = {
    environment: deps.environment,
    workspace: claim.organizationId,
    human: claim.principalId,
    provider: deps.registration.provider,
    registration: claim.registration,
    grantId,
    generation: claim.generation,
    keyVersion: String(claim.encryptedTokens.keyVersion),
  };
  const tokens = await openGrantTokens(
    identity,
    { nonce: b64(claim.encryptedTokens.nonce), ciphertext: b64(claim.encryptedTokens.ciphertext) },
    deps.key,
  );
  if (!tokens.refreshToken) throw new Error("invalid_grant_tokens");
  if (!(await deps.core.markConnectionRefreshDispatched(fence))) return "in_progress";
  let replacement;
  try {
    replacement = await deps.adapter.refresh(deps.registration, deps.client, tokens.refreshToken);
  } catch (error) {
    const outcome =
      error instanceof Error && error.message === "provider_rate_limited"
        ? "rate_limited"
        : error instanceof Error && error.message === "provider_authorization_denied"
          ? "invalid_grant"
          : "outcome_unknown";
    try {
      await deps.core.failConnectionRefresh({ ...fence, outcome });
    } catch {
      /* dispatched claim remains fenced */
    }
    return outcome === "rate_limited" ? "in_progress" : "reconnect_required";
  }
  const refreshToken = nextRefreshToken(tokens.refreshToken, replacement.refreshToken);
  let encryptedTokens: Sealed | undefined;
  try {
    const validExpiry =
      Number.isSafeInteger(replacement.expiresIn) &&
      replacement.expiresIn > 0 &&
      replacement.expiresIn <= 315360000;
    const next = await sealGrantTokens(
      { ...identity, generation: claim.generation + 1 },
      {
        accessToken: replacement.accessToken,
        ...((replacement.scopes ?? tokens.scopes) === undefined
          ? {}
          : { scopes: replacement.scopes ?? tokens.scopes }),
        refreshToken,
        ...(validExpiry
          ? { expiresAt: new Date(Date.now() + replacement.expiresIn * 1000).toISOString() }
          : {}),
      },
      deps.key,
    );
    encryptedTokens = {
      nonce: hex(next.nonce),
      ciphertext: hex(next.ciphertext),
      keyVersion: claim.encryptedTokens.keyVersion,
    };
    if (validExpiry) {
      const commit = { ...fence, encryptedTokens };
      let committed = false;
      try {
        committed = await deps.core.commitConnectionRefresh(commit);
      } catch {
        try {
          committed = await deps.core.commitConnectionRefresh(commit);
        } catch {
          /* check durable custody */
        }
      }
      if (committed) return "refreshed";
    }
  } catch {
    /* best-effort revoke if encryption itself fails */
  }
  let receipt: "retained" | "committed" | "conflict" | "unknown" = "unknown";
  if (encryptedTokens) {
    try {
      receipt = await deps.core.retainConnectionRefreshOrphan({ ...fence, encryptedTokens });
    } catch {
      try {
        receipt = await deps.core.retainConnectionRefreshOrphan({ ...fence, encryptedTokens });
      } catch {
        /* unknown Core outcome */
      }
    }
  }
  if (receipt === "committed") return "refreshed";
  if (receipt === "retained") {
    const revocationClaimId = ulid(),
      proof = { grantId, claimId, revocationClaimId };
    try {
      if (
        (await deps.core.claimConnectionRefreshOrphanRevocation(proof)) &&
        (await deps.core.markConnectionRefreshOrphanRevocationDispatched(proof))
      ) {
        let outcome: "revoked" | "outcome_unknown" = "outcome_unknown";
        try {
          await deps.adapter.revoke(deps.registration, deps.client, refreshToken);
          outcome = "revoked";
        } catch {
          /* retained unknown */
        }
        try {
          await deps.core.finishConnectionRefreshOrphanRevocation({ ...proof, outcome });
        } catch {
          /* retained unknown */
        }
      }
    } catch {
      /* retained for reconciliation */
    }
  } else {
    // A failed custody write can race a committed refresh. Revoke only after
    // the generation fence proves that no pending token became active.
    try {
      if (await deps.core.failConnectionRefresh({ ...fence, outcome: "outcome_unknown" })) {
        try {
          await deps.adapter.revoke(deps.registration, deps.client, refreshToken);
        } catch {
          /* outcome remains unknown */
        }
      }
    } catch {
      /* a possibly committed grant must not be revoked */
    }
    return "reconnect_required";
  }
  try {
    await deps.core.failConnectionRefresh({ ...fence, outcome: "outcome_unknown" });
  } catch {
    /* state remains fenced */
  }
  return "reconnect_required";
}

/** The Core fence is committed before attempting upstream revocation. */
export async function disconnectGrant(
  input: {
    organizationId: string;
    grantId: string;
    principalId: string;
    idempotencyKey: string;
    mutationAuthority: MutationAuthority;
  },
  deps: GrantLifecycleDependencies,
): Promise<"disconnected" | "revocation_pending"> {
  if (!(await deps.core.disconnectConnectionGrant(input)))
    throw new Error("connection_authority_denied");
  const status = await deps.core.readConnectionGrantStatus({
    organizationId: input.organizationId,
    principalId: input.principalId,
    grantId: input.grantId,
    mutationAuthority: input.mutationAuthority,
  });
  if (status?.state === "disconnected") return "disconnected";
  if (status?.state !== "disconnecting") throw new Error("connection_authority_denied");
  const grant = await deps.core.readConnectionGrantForRevocation({ grantId: input.grantId });
  if (
    !grant ||
    grant.organizationId !== input.organizationId ||
    grant.principalId !== input.principalId ||
    (deps.registration.provider === "make"
      ? !supportsMakeGrantRegistration(
          deps.environment,
          deps.registration.registration,
          grant.registration,
        )
      : grant.registration !== deps.registration.registration)
  )
    return "revocation_pending";
  const claimId = ulid();
  try {
    if (!(await deps.core.claimConnectionRevocation({ grantId: input.grantId, claimId })))
      return "revocation_pending";
    const tokens = await openGrantTokens(
      {
        environment: deps.environment,
        workspace: grant.organizationId,
        human: grant.principalId,
        provider: deps.registration.provider,
        registration: grant.registration,
        grantId: input.grantId,
        generation: grant.generation,
        keyVersion: String(grant.encryptedTokens.keyVersion),
      },
      {
        nonce: b64(grant.encryptedTokens.nonce),
        ciphertext: b64(grant.encryptedTokens.ciphertext),
      },
      deps.key,
    );
    if (!(await deps.core.markConnectionRevocationDispatched({ grantId: input.grantId, claimId })))
      return "revocation_pending";
    await deps.adapter.revoke(
      deps.registration,
      deps.client,
      tokens.refreshToken ?? tokens.accessToken,
    );
    return (await deps.core.finishConnectionDisconnect({
      grantId: input.grantId,
      claimId,
      outcome: "revoked",
    }))
      ? "disconnected"
      : "revocation_pending";
  } catch {
    try {
      await deps.core.finishConnectionDisconnect({
        grantId: input.grantId,
        claimId,
        outcome: "outcome_unknown",
      });
    } catch {
      /* retained Core custody */
    }
    return "revocation_pending";
  }
}
