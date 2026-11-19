import { encodeBytes } from "./encoding.js";
import type { ProviderAdapter, OAuthClient } from "./adapter.js";
import { supportsMakeGrantRegistration, type ProviderRegistration } from "./registry.js";
import { openGrantTokens } from "./grant-vault.js";
import { ulid } from "./authorization.js";
interface Custody {
  grantId: string;
  organizationId: string;
  principalId: string;
  registration: string;
  generation: number;
  encryptedTokens: { nonce: string; ciphertext: string; keyVersion: number };
}
interface Orphan extends Custody {
  attemptId: string;
}
interface RefreshOrphan extends Custody {
  claimId: string;
}
export interface MaintenanceCore {
  listExpiredConnectionGrants(input: { limit: number }): Promise<string[]>;
  claimExpiredConnectionGrant(input: { grantId: string }): Promise<boolean>;
  listDisconnectingConnectionGrants(input: { limit: number }): Promise<string[]>;
  readConnectionGrantForRevocation(input: { grantId: string }): Promise<Custody | null>;
  claimConnectionRevocation(input: { grantId: string; claimId: string }): Promise<boolean>;
  markConnectionRevocationDispatched(input: { grantId: string; claimId: string }): Promise<boolean>;
  finishConnectionDisconnect(input: {
    grantId: string;
    claimId: string;
    outcome: "revoked" | "outcome_unknown";
  }): Promise<boolean>;
  listConnectionOrphans(input: { limit: number }): Promise<string[]>;
  readConnectionOrphan(input: { attemptId: string }): Promise<Orphan | null>;
  claimConnectionOrphanRevocation(input: { attemptId: string; claimId: string }): Promise<boolean>;
  markConnectionOrphanRevocationDispatched(input: {
    attemptId: string;
    claimId: string;
  }): Promise<boolean>;
  finishConnectionOrphanRevocation(input: {
    attemptId: string;
    claimId: string;
    outcome: "revoked" | "outcome_unknown";
  }): Promise<boolean>;
  listConnectionRefreshOrphans(input: {
    limit: number;
  }): Promise<{ grantId: string; claimId: string }[]>;
  readConnectionRefreshOrphan(input: {
    grantId: string;
    claimId: string;
  }): Promise<RefreshOrphan | null>;
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
}
export interface MaintenanceDependencies {
  environment: "development" | "production";
  registration: ProviderRegistration;
  client: OAuthClient;
  key: Uint8Array;
  core: MaintenanceCore;
  adapter: ProviderAdapter;
}
const b64 = (s: string) => {
  if (!/^(?:[a-f0-9]{2})+$/u.test(s)) throw Error();
  return encodeBytes(Uint8Array.from(s.match(/../gu) ?? [], (v) => parseInt(v, 16)));
};
async function token(row: Custody, deps: MaintenanceDependencies): Promise<string> {
  if (
    deps.registration.provider === "make"
      ? !supportsMakeGrantRegistration(
          deps.environment,
          deps.registration.registration,
          row.registration,
        )
      : row.registration !== deps.registration.registration
  )
    throw Error();
  const value = await openGrantTokens(
    {
      environment: deps.environment,
      workspace: row.organizationId,
      human: row.principalId,
      provider: deps.registration.provider,
      registration: row.registration,
      grantId: row.grantId,
      generation: row.generation,
      keyVersion: String(row.encryptedTokens.keyVersion),
    },
    { nonce: b64(row.encryptedTokens.nonce), ciphertext: b64(row.encryptedTokens.ciphertext) },
    deps.key,
  );
  return value.refreshToken ?? value.accessToken;
}
/** Bounded private sweep; dispatched unknown revocations are never automatically repeated. */
export async function reconcileConnections(deps: MaintenanceDependencies): Promise<void> {
  const core = deps.core;
  for (const grantId of await core.listExpiredConnectionGrants({ limit: 25 })) {
    try {
      await core.claimExpiredConnectionGrant({ grantId });
    } catch {
      /* retry next sweep */
    }
  }
  for (const grantId of await core.listDisconnectingConnectionGrants({ limit: 25 })) {
    const claimId = ulid();
    try {
      if (!(await core.claimConnectionRevocation({ grantId, claimId }))) continue;
      const row = await core.readConnectionGrantForRevocation({ grantId });
      if (!row) continue;
      const secret = await token(row, deps);
      if (!(await core.markConnectionRevocationDispatched({ grantId, claimId }))) continue;
      let outcome: "revoked" | "outcome_unknown" = "outcome_unknown";
      try {
        await deps.adapter.revoke(deps.registration, deps.client, secret);
        outcome = "revoked";
      } catch {
        /* do not replay */
      }
      await core.finishConnectionDisconnect({ grantId, claimId, outcome });
    } catch {
      /* retain fenced custody */
    }
  }
  for (const attemptId of await core.listConnectionOrphans({ limit: 25 })) {
    const claimId = ulid();
    try {
      if (!(await core.claimConnectionOrphanRevocation({ attemptId, claimId }))) continue;
      const row = await core.readConnectionOrphan({ attemptId });
      if (!row) continue;
      const secret = await token({ ...row, generation: 1 }, deps);
      if (!(await core.markConnectionOrphanRevocationDispatched({ attemptId, claimId }))) continue;
      let outcome: "revoked" | "outcome_unknown" = "outcome_unknown";
      try {
        await deps.adapter.revoke(deps.registration, deps.client, secret);
        outcome = "revoked";
      } catch {
        /* do not replay */
      }
      await core.finishConnectionOrphanRevocation({ attemptId, claimId, outcome });
    } catch {
      /* retain fenced custody */
    }
  }
  for (const { grantId, claimId } of await core.listConnectionRefreshOrphans({ limit: 25 })) {
    const revocationClaimId = ulid(),
      proof = { grantId, claimId, revocationClaimId };
    try {
      if (!(await core.claimConnectionRefreshOrphanRevocation(proof))) continue;
      const row = await core.readConnectionRefreshOrphan({ grantId, claimId });
      if (!row) continue;
      const secret = await token(row, deps);
      if (!(await core.markConnectionRefreshOrphanRevocationDispatched(proof))) continue;
      let outcome: "revoked" | "outcome_unknown" = "outcome_unknown";
      try {
        await deps.adapter.revoke(deps.registration, deps.client, secret);
        outcome = "revoked";
      } catch {
        /* do not replay */
      }
      await core.finishConnectionRefreshOrphanRevocation({ ...proof, outcome });
    } catch {
      /* retain fenced custody */
    }
  }
}
