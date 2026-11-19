import {
  DEV_ACCESS_SESSION_TTL_SECONDS,
  DEV_ACCESS_TICKET_TTL_SECONDS,
  DEV_RUNTIME_PROBE_TTL_SECONDS,
  createDevAccessTicket,
  digestDevAccessTicket,
  proveDevAccessSigningKeyPair,
  signDevAccessSession,
  signDevRuntimeProbe,
  verifyDevAccessSession,
  verifyDevRuntimeProbe,
} from "@ohmyhost/dev-access-tokens";
import { DevShareRotationConflictError, type DevAccessMode } from "@ohmyhost/database";
import { parseUlid, type Clock, type UlidFactory } from "@ohmyhost/platform";
import { parseProjectHandle } from "@ohmyhost/project-handles";
import { z } from "zod";

import {
  IdempotencyKeyReusedError,
  type DevAccessAuthorizeInput,
  type DevAccessAuthorizeResult,
  type DevAccessRedeemInput,
  type DevAccessRedeemResult,
  type DevAccessTicketsPort,
  type ProductSurfaceContext,
} from "./contracts.js";
import {
  DevAccessUnavailableError,
  parseDevAccessAuthorizeInput,
  parseDevAccessRedeemInput,
  parseDevRuntimeProbeInput,
} from "./dev-access.js";
import {
  hex as upperHex,
  readAccessView,
  type DevAccessManagementPort,
  type DevAccessView,
} from "./dev-access-management.js";
import type { createEnvironmentSecretCipherKeyring } from "./environment-secret-cipher.js";

/** The Core's Dev access capability: tickets, share links, sessions and probes as named commands, never SQL. */
export interface D1DevAccessRuntime {
  issueDevAccessTicket(input: unknown): Promise<unknown>;
  redeemDevAccess(input: unknown): Promise<unknown>;
  authorizeDevPage(input: unknown): Promise<unknown>;
  authorizeDevCombined?(input: unknown): Promise<unknown>;
  authorizeDevAccessSession(input: unknown): Promise<unknown>;
  authorizeDevRuntimeProbe(input: unknown): Promise<unknown>;
  readDevShareState(input: unknown): Promise<unknown>;
  changeDevAccess(input: unknown): Promise<unknown>;
}
export const D1_DEV_ACCESS_METHODS = [
  "issueDevAccessTicket",
  "redeemDevAccess",
  "authorizeDevPage",
  "authorizeDevAccessSession",
  "authorizeDevRuntimeProbe",
  "readDevShareState",
  "changeDevAccess",
] as const;
export function isD1DevAccessRuntime(value: unknown): value is D1DevAccessRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    D1_DEV_ACCESS_METHODS.every((method) => typeof Reflect.get(value, method) === "function")
  );
}

const lower = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
const bytes = (value: string) =>
  Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
const id = z.string().transform(parseUlid);
const instant = z.string().refine((value) => new Date(value).toISOString() === value);
const scope = z.strictObject({
  organizationId: id,
  projectId: id,
  environmentId: id,
  handle: z.string(),
  origin: z.string(),
  devAccessEpoch: z.number().int().min(1),
});
/** The state the owner reads: epoch 0 is a Dev environment for which no link or ticket was ever issued. Issued scopes stay at 1 or more. */
const stateScope = scope.extend({ devAccessEpoch: z.number().int().min(0) });
const sealed = z.strictObject({
  ciphertext: z.string(),
  nonce: z.string(),
  valueSha256: z.string(),
  keyVersion: z.number().int().min(1),
});
const ticket = scope.extend({
  ticketId: id,
  principalId: z.string(),
  issuedAt: instant,
  expiresAt: instant,
});
const state = z.strictObject({
  scope: stateScope,
  mode: z.enum(["protected", "public"]),
  link: sealed.nullable(),
  generation: z.number().int().min(1).nullable(),
  request: z.strictObject({ requestSha256: z.string(), response: sealed }).nullable(),
  rotationGeneration: z.number().int().min(1).nullable(),
});
type State = z.output<typeof state>;
const change = z.union([
  z.strictObject({ replayed: z.literal("request"), response: sealed }),
  z.strictObject({ replayed: z.literal("rotation"), generation: z.number().int() }),
  z.strictObject({
    replayed: z.null(),
    generation: z.number().int().nullable(),
    epoch: z.number().int().nullable(),
  }),
]);
const redeemed = z
  .strictObject({ kind: z.enum(["share", "ticket"]), scope, subjectId: z.string() })
  .nullable();

/** Refusals of the Core that tell the caller to decide again from a fresh read. */
async function settled<T>(call: () => Promise<T>): Promise<T | "stale"> {
  try {
    return await call();
  } catch (error) {
    const code =
        error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined,
      message = error instanceof Error ? error.message : "";
    if (code === "dev_access_state_changed" || message === "dev_access_state_changed")
      return "stale";
    if (code === "dev_access_unavailable" || message === "dev_access_unavailable")
      throw new DevAccessUnavailableError();
    if (code === "idempotency_key_reused" || message === "idempotency_key_reused")
      throw new IdempotencyKeyReusedError();
    throw error;
  }
}

export function createD1DevAccessTicketsPort(input: {
  readonly runtime: D1DevAccessRuntime;
  readonly clock: Clock;
  readonly ids: UlidFactory;
  readonly crypto: Pick<Crypto, "getRandomValues" | "subtle">;
}): DevAccessTicketsPort {
  return Object.freeze({
    async issue(context: ProductSurfaceContext) {
      const issuedAt = input.clock.now().toISOString(),
        expiresAt = new Date(
          Date.parse(issuedAt) + DEV_ACCESS_TICKET_TTL_SECONDS * 1000,
        ).toISOString(),
        credential = await createDevAccessTicket(input.crypto),
        raw = await input.runtime.issueDevAccessTicket({
          organizationId: context.organizationId,
          projectId: context.projectId,
          principalId: context.principalId,
          ticketId: input.ids.next(),
          tokenSha256: lower(credential.digest),
          issuedAt,
          expiresAt,
        });
      if (raw === null) throw new DevAccessUnavailableError();
      const stored = ticket.parse(raw);
      return Object.freeze({
        ticketId: stored.ticketId,
        projectId: stored.projectId,
        environmentId: stored.environmentId,
        origin: stored.origin,
        redeemUrl: `${stored.origin}/.ohmyhost/dev-access/redeem?stage=dev&ticket=${credential.token}`,
        expiresAt: stored.expiresAt,
      });
    },
  });
}

/** The original sequencing over named Core commands; a changed state asks for a fresh read, never a blind write. */
export function createD1DevAccessManagementPort(input: {
  readonly runtime: D1DevAccessRuntime;
  readonly clock: Clock;
  readonly crypto: Pick<Crypto, "getRandomValues" | "subtle">;
  readonly cipher: ReturnType<typeof createEnvironmentSecretCipherKeyring>;
}): DevAccessManagementPort {
  const attempts = 4;
  const candidate = async () => (await createDevAccessTicket(input.crypto)).token;
  const digest = async (value: string) =>
    new Uint8Array(await input.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const read = async (
    context: ProductSurfaceContext,
    keys: { requestKeySha256?: string; rotationKeySha256?: string } = {},
  ): Promise<State> => {
    const raw = await input.runtime.readDevShareState({
      organizationId: context.organizationId,
      projectId: context.projectId,
      principalId: context.principalId,
      ...keys,
    });
    if (raw === null) throw new DevAccessUnavailableError();
    return state.parse(raw);
  };
  const seal = async (current: State, name: string, value: string) => {
    const encrypted = await input.cipher.encrypt({
      organizationId: current.scope.organizationId,
      projectId: current.scope.projectId,
      environmentId: current.scope.environmentId,
      name,
      value,
    });
    return {
      ciphertext: lower(encrypted.ciphertext),
      nonce: lower(encrypted.nonce),
      valueSha256: lower(encrypted.valueSha256),
      keyVersion: encrypted.keyVersion,
    };
  };
  const open = async (
    current: State,
    name: string,
    value: z.output<typeof sealed>,
  ): Promise<string> =>
    input.cipher.decrypt({
      organizationId: current.scope.organizationId,
      projectId: current.scope.projectId,
      environmentId: current.scope.environmentId,
      name,
      ciphertext: bytes(value.ciphertext),
      nonce: bytes(value.nonce),
      valueSha256: bytes(value.valueSha256),
      keyVersion: value.keyVersion,
    });
  const viewOf = async (
    current: State,
    mode: DevAccessMode,
    link: z.output<typeof sealed> | null,
    token?: string,
  ): Promise<DevAccessView> => {
    if (mode === "public" || link === null) return { mode, shareUrl: null };
    const value = token ?? (await open(current, "DEV_SHARE_LINK", link));
    if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new DevAccessUnavailableError();
    return {
      mode: "protected",
      shareUrl: `${current.scope.origin}/.ohmyhost/dev-access/redeem?stage=dev&ticket=${value}`,
    };
  };
  const expectedOf = (current: State) => ({
    mode: current.mode,
    generation: current.generation,
    linkValueSha256: current.link === null ? null : current.link.valueSha256,
    epoch: current.scope.devAccessEpoch,
  });
  const base = (context: ProductSurfaceContext, current: State) => ({
    organizationId: context.organizationId,
    projectId: context.projectId,
    principalId: context.principalId,
    now: input.clock.now().toISOString(),
    expected: expectedOf(current),
  });
  const request = async (
    context: ProductSurfaceContext,
    idempotencyKey: string,
    body: { action: "set_mode"; mode: DevAccessMode } | { action: "revoke" },
    plan: (
      current: State,
      token: string,
    ) => Promise<{
      mode?: DevAccessMode;
      link?: ({ action: "save" } & z.output<typeof sealed>) | { action: "revoke" };
      bumpEpoch: boolean;
      next: { mode: DevAccessMode; link: z.output<typeof sealed> | null; token?: string };
    }>,
  ): Promise<DevAccessView> => {
    if (
      typeof idempotencyKey !== "string" ||
      idempotencyKey.length < 1 ||
      idempotencyKey.length > 128
    )
      throw new TypeError("Dev access idempotency key is invalid");
    const token = await candidate(),
      keySha256 = await digest(idempotencyKey),
      requestSha256 = await digest(JSON.stringify(body)),
      name = `DEV_ACCESS_REQUEST_${upperHex(await digest(JSON.stringify({ actor: context.principalId, key: upperHex(keySha256), request: upperHex(requestSha256) })))}`;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const current = await read(context, { requestKeySha256: lower(keySha256) });
      if (current.request !== null) {
        if (current.request.requestSha256 !== lower(requestSha256))
          throw new IdempotencyKeyReusedError();
        return readAccessView(await open(current, name, current.request.response));
      }
      const decided = await plan(current, token),
        result = await viewOf(current, decided.next.mode, decided.next.link, decided.next.token),
        response = await seal(current, name, JSON.stringify(result)),
        outcome = await settled(async () =>
          change.parse(
            await input.runtime.changeDevAccess({
              ...base(context, current),
              ...(decided.mode === undefined ? {} : { mode: decided.mode }),
              ...(decided.link === undefined ? {} : { link: decided.link }),
              bumpEpoch: decided.bumpEpoch,
              receipt: {
                keySha256: lower(keySha256),
                requestSha256: lower(requestSha256),
                response,
              },
            }),
          ),
        );
      if (outcome === "stale") continue;
      if (outcome.replayed === "request")
        return readAccessView(await open(current, name, outcome.response));
      return result;
    }
    throw new DevAccessUnavailableError();
  };
  return {
    async ensure(context) {
      const token = await candidate();
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const current = await read(context);
        if (current.mode !== "protected" || current.link !== null)
          return viewOf(current, current.mode, current.link);
        const link = await seal(current, "DEV_SHARE_LINK", token),
          outcome = await settled(() =>
            input.runtime.changeDevAccess({
              ...base(context, current),
              link: { action: "save", ...link },
              bumpEpoch: false,
            }),
          );
        if (outcome !== "stale") return viewOf(current, "protected", link, token);
      }
      throw new DevAccessUnavailableError();
    },
    async setMode(context, mode, idempotencyKey) {
      if (mode !== "protected" && mode !== "public")
        throw new TypeError("Dev access mode is invalid");
      return request(
        context,
        idempotencyKey,
        { action: "set_mode", mode },
        async (current, token) => {
          if (current.mode === mode && (mode === "public" || current.link !== null))
            return { bumpEpoch: false, next: { mode: current.mode, link: current.link } };
          const bumpEpoch = current.mode !== mode;
          if (mode === "public")
            return {
              mode,
              ...(current.link === null ? {} : { link: { action: "revoke" as const } }),
              bumpEpoch,
              next: { mode, link: null },
            };
          const link = await seal(current, "DEV_SHARE_LINK", token);
          return {
            ...(bumpEpoch ? { mode } : {}),
            link: { action: "save" as const, ...link },
            bumpEpoch,
            next: { mode, link, token },
          };
        },
      );
    },
    async rotate(context, idempotencyKey) {
      if (idempotencyKey.length < 1 || idempotencyKey.length > 128)
        throw new TypeError("Dev share rotation key is invalid");
      const token = await candidate(),
        keySha256 = lower(await digest(idempotencyKey));
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const current = await read(context, { rotationKeySha256: keySha256 });
        // Public Dev has no link to replace; like ensure and revoke, report that without writing.
        if (current.mode === "public") return viewOf(current, "public", null);
        if (current.rotationGeneration !== null) {
          if (current.link === null || current.generation !== current.rotationGeneration)
            throw new DevShareRotationConflictError();
          return viewOf(current, current.mode, current.link);
        }
        const link = await seal(current, "DEV_SHARE_LINK", token),
          outcome = await settled(() =>
            input.runtime.changeDevAccess({
              ...base(context, current),
              link: { action: "save", ...link },
              bumpEpoch: true,
              rotationKeySha256: keySha256,
            }),
          );
        if (outcome === "stale" || change.parse(outcome).replayed === "rotation") continue;
        return viewOf(current, "protected", link, token);
      }
      throw new DevAccessUnavailableError();
    },
    async revoke(context, idempotencyKey) {
      return request(context, idempotencyKey, { action: "revoke" }, async (current) => ({
        ...(current.link === null ? {} : { link: { action: "revoke" as const } }),
        bumpEpoch: current.link !== null,
        next: { mode: current.mode, link: null },
      }));
    },
  };
}

const flag = z.boolean();
/** The Dev-origin side: session redemption, per-request authorization and the health-probe token. */
export function createD1DevAccessSessions(input: {
  readonly runtime: D1DevAccessRuntime;
  readonly clock: Clock;
  readonly crypto: Pick<Crypto, "subtle">;
}) {
  return {
    redeemer: (keys: { privateJwk: JsonWebKey; publicJwk: JsonWebKey }) => ({
      async redeem(value: DevAccessRedeemInput): Promise<DevAccessRedeemResult> {
        const request = parseDevAccessRedeemInput(value),
          consumedAt = input.clock.now().toISOString(),
          kid = await proveDevAccessSigningKeyPair(input.crypto, keys.privateJwk, keys.publicJwk),
          ticketDigest = await digestDevAccessTicket(input.crypto, request.ticket),
          shareDigest = new Uint8Array(
            await input.crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.ticket)),
          ),
          grant = redeemed.parse(
            await input.runtime.redeemDevAccess({
              projectId: request.projectId,
              environmentId: request.environmentId,
              handle: request.handle,
              origin: request.origin,
              shareTokenSha256: lower(shareDigest),
              ticketTokenSha256: lower(ticketDigest),
              consumedAt,
            }),
          );
        if (grant === null) throw new DevAccessUnavailableError();
        const expiresAt = new Date(
            Date.parse(consumedAt) + DEV_ACCESS_SESSION_TTL_SECONDS * 1000,
          ).toISOString(),
          sessionToken = await signDevAccessSession(input.crypto, keys.privateJwk, {
            projectId: parseUlid(grant.scope.projectId),
            environmentId: parseUlid(grant.scope.environmentId),
            handle: grant.scope.handle,
            origin: grant.scope.origin,
            subjectId: grant.subjectId,
            devAccessEpoch: grant.scope.devAccessEpoch,
            kid,
            issuedAt: consumedAt,
            expiresAt,
          });
        const verified = await verifyDevAccessSession(
          input.crypto,
          keys.publicJwk,
          sessionToken,
          {
            projectId: parseUlid(grant.scope.projectId),
            environmentId: parseUlid(grant.scope.environmentId),
            handle: parseProjectHandle(grant.scope.handle),
            origin: grant.scope.origin,
          },
          consumedAt,
        );
        if (verified === null) throw new DevAccessUnavailableError();
        return Object.freeze({ sessionToken, expiresAt });
      },
    }),
    authorizer: (keys: { publicJwk: JsonWebKey }) => ({
      async authorize(value: DevAccessAuthorizeInput): Promise<DevAccessAuthorizeResult> {
        const request = parseDevAccessAuthorizeInput(value),
          claims =
            request.sessionToken === null
              ? null
              : await verifyDevAccessSession(
                  input.crypto,
                  keys.publicJwk,
                  request.sessionToken,
                  {
                    projectId: request.projectId,
                    environmentId: request.environmentId,
                    handle: parseProjectHandle(request.handle),
                    origin: request.origin,
                  },
                  input.clock.now().toISOString(),
                );
        if (request.organizationHint !== undefined) {
          if (typeof input.runtime.authorizeDevCombined !== "function")
            throw new DevAccessUnavailableError();
          const shareSession = claims?.subjectId === `share:${request.projectId}`;
          const user = claims !== null && !claims.subjectId.startsWith("share:") ? claims : null;
          return Object.freeze({
            authorized: flag.parse(
              await input.runtime.authorizeDevCombined({
                organizationHint: request.organizationHint,
                projectId: request.projectId,
                environmentId: request.environmentId,
                handle: request.handle,
                origin: request.origin,
                shareSession,
                epoch: claims?.devAccessEpoch ?? null,
                principalId: user?.subjectId ?? null,
                devAccessEpoch: user?.devAccessEpoch ?? null,
              }),
            ),
          });
        }
        const page = flag.parse(
          await input.runtime.authorizeDevPage({
            projectId: request.projectId,
            environmentId: request.environmentId,
            handle: request.handle,
            origin: request.origin,
            shareSession: claims?.subjectId === `share:${request.projectId}`,
            epoch: claims === null ? null : claims.devAccessEpoch,
          }),
        );
        if (page || claims === null || claims.subjectId.startsWith("share:"))
          return Object.freeze({ authorized: page });
        return Object.freeze({
          authorized: flag.parse(
            await input.runtime.authorizeDevAccessSession({
              projectId: claims.projectId,
              environmentId: claims.environmentId,
              handle: claims.handle,
              origin: claims.origin,
              devAccessEpoch: claims.devAccessEpoch,
              principalId: claims.subjectId,
            }),
          ),
        });
      },
    }),
    probeIssuer: (keys: { privateJwk: JsonWebKey; publicJwk: JsonWebKey }) => ({
      async issue(value: unknown) {
        const scopeOfProbe = parseDevRuntimeProbeInput(value);
        if (!flag.parse(await input.runtime.authorizeDevRuntimeProbe(scopeOfProbe)))
          throw new DevAccessUnavailableError();
        const issuedAt = input.clock.now().toISOString(),
          expiresAt = new Date(
            Date.parse(issuedAt) + DEV_RUNTIME_PROBE_TTL_SECONDS * 1_000,
          ).toISOString(),
          kid = await proveDevAccessSigningKeyPair(input.crypto, keys.privateJwk, keys.publicJwk),
          probeToken = await signDevRuntimeProbe(input.crypto, keys.privateJwk, {
            ...scopeOfProbe,
            kid,
            issuedAt,
            expiresAt,
          });
        const verified = await verifyDevRuntimeProbe(
          input.crypto,
          keys.publicJwk,
          probeToken,
          scopeOfProbe,
          issuedAt,
        );
        if (verified === null) throw new DevAccessUnavailableError();
        return Object.freeze({ probeToken, expiresAt });
      },
    }),
  };
}
