import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";

import { newUlid } from "../../control-store/src/catalog/common.js";
import { createControlStore } from "../../control-store/src/store.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { seedDevAccessProject } from "../../control-store/test/support/dev-access-fixture.js";
import { IdempotencyKeyReusedError } from "../src/contracts.js";
import {
  D1_DEV_ACCESS_METHODS,
  createD1DevAccessManagementPort,
  createD1DevAccessSessions,
  createD1DevAccessTicketsPort,
} from "../src/d1-dev-access.js";
import { DevAccessUnavailableError } from "../src/dev-access.js";
import { createEnvironmentSecretCipherKeyring } from "../src/environment-secret-cipher.js";

it("manages Dev access over the Core with the original replay, rotation and ticket semantics", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings),
      { project, origin, principalId } = await seedDevAccessProject(control);
    let now = Date.parse("2026-10-29T10:00:00.000Z");
    const clock = { now: () => new Date((now += 1000)) },
      cipher = createEnvironmentSecretCipherKeyring({
        primaryKeyBase64: Buffer.alloc(32, 0x41).toString("base64"),
        currentKeyVersion: 1,
        crypto: globalThis.crypto,
      }),
      port = createD1DevAccessManagementPort({
        runtime: store.devAccess,
        clock,
        crypto: globalThis.crypto,
        cipher,
      }),
      context = {
        organizationId: parseUlid(project.organizationId),
        projectId: parseUlid(project.projectId),
        principalId,
        requestId: "req_fixture",
      },
      link =
        /^https:\/\/dev-.+\.check\.omh\.st\/\.ohmyhost\/dev-access\/redeem\?stage=dev&ticket=[A-Za-z0-9_-]{43}$/u;

    const ensured = await port.ensure(context);
    expect(ensured.mode).toBe("protected");
    expect(ensured.shareUrl).toMatch(link);
    expect(ensured.shareUrl?.startsWith(origin)).toBe(true);
    // A second ensure shows the same link; it never mints another.
    expect(await port.ensure(context)).toEqual(ensured);

    const rotated = await port.rotate(context, "rotate-1");
    expect(rotated.shareUrl).toMatch(link);
    expect(rotated.shareUrl).not.toBe(ensured.shareUrl);
    expect(await port.rotate(context, "rotate-1")).toEqual(rotated);

    const publicView = await port.setMode(context, "public", "mode-1");
    expect(publicView).toEqual({ mode: "public", shareUrl: null });
    expect(await port.setMode(context, "public", "mode-1")).toEqual(publicView);
    await expect(port.setMode(context, "protected", "mode-1")).rejects.toBeInstanceOf(
      IdempotencyKeyReusedError,
    );
    const protectedView = await port.setMode(context, "protected", "mode-2");
    expect(protectedView.shareUrl).toMatch(link);
    expect(await port.revoke(context, "revoke-1")).toEqual({ mode: "protected", shareUrl: null });

    // The ticket port stores one digest and hands back a redeem URL on the Dev origin.
    const tickets = createD1DevAccessTicketsPort({
      runtime: store.devAccess,
      clock,
      ids: { next: () => parseUlid(newUlid()) },
      crypto: globalThis.crypto,
    });
    const ticket = await tickets.issue(context);
    expect(
      ticket.redeemUrl.startsWith(`${origin}/.ohmyhost/dev-access/redeem?stage=dev&ticket=`),
    ).toBe(true);
    await expect(tickets.issue({ ...context, principalId: "user:stranger" })).rejects.toThrow(
      "Dev access is unavailable",
    );
  } finally {
    await control.dispose();
  }
}, 120_000);

it("redeems a ticket once into a session, authorizes it per page and issues a runtime probe only for an authorized deployment", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings),
      { project, origin, principalId } = await seedDevAccessProject(control, {
        handle: "calm-otter-waves",
      });
    let now = Date.parse("2026-10-29T10:00:00.000Z");
    const clock = { now: () => new Date((now += 1000)) },
      pair = (await globalThis.crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair,
      privateJwk = await globalThis.crypto.subtle.exportKey("jwk", pair.privateKey),
      exported = await globalThis.crypto.subtle.exportKey("jwk", pair.publicKey),
      publicJwk = { crv: exported.crv, kty: exported.kty, x: exported.x, y: exported.y },
      sessions = createD1DevAccessSessions({
        runtime: store.devAccess,
        clock,
        crypto: globalThis.crypto,
      }),
      tickets = createD1DevAccessTicketsPort({
        runtime: store.devAccess,
        clock,
        ids: { next: () => parseUlid(newUlid()) },
        crypto: globalThis.crypto,
      }),
      context = {
        organizationId: parseUlid(project.organizationId),
        projectId: parseUlid(project.projectId),
        principalId,
        requestId: "req_fixture",
      },
      page = {
        projectId: parseUlid(project.projectId),
        environmentId: parseUlid(project.devEnvironmentId),
        handle: project.handle,
        origin,
      },
      issueTicket = async () => {
        const issued = await tickets.issue(context);
        return new URL(issued.redeemUrl).searchParams.get("ticket") as string;
      };

    const ticket = await issueTicket(),
      session = await sessions
        .redeemer({ privateJwk, publicJwk })
        .redeem({ ...page, ticket, clientAddress: "198.51.100.7" });
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(now);
    // The ticket is single use.
    await expect(
      sessions
        .redeemer({ privateJwk, publicJwk })
        .redeem({ ...page, ticket, clientAddress: "198.51.100.7" }),
    ).rejects.toBeInstanceOf(DevAccessUnavailableError);

    const authorizer = sessions.authorizer({ publicJwk });
    expect(await authorizer.authorize({ ...page, sessionToken: session.sessionToken })).toEqual({
      authorized: true,
    });
    expect(await authorizer.authorize({ ...page, sessionToken: null })).toEqual({
      authorized: false,
    });
    expect(
      await authorizer.authorize({
        ...page,
        organizationHint: parseUlid(project.organizationId),
        sessionToken: session.sessionToken,
      }),
    ).toEqual({ authorized: true });
    expect(
      await authorizer.authorize({
        ...page,
        organizationHint: parseUlid(project.organizationId),
        sessionToken: null,
      }),
    ).toEqual({ authorized: false });
    await expect(
      authorizer.authorize({
        ...page,
        organizationHint: parseUlid(newUlid()),
        sessionToken: session.sessionToken,
      }),
    ).rejects.toThrow();
    const { authorizeDevCombined: newCapability, ...oldRuntime } = store.devAccess;
    expect(newCapability).toBeTypeOf("function");
    const oldAuthorizer = createD1DevAccessSessions({
      runtime: oldRuntime,
      clock,
      crypto: globalThis.crypto,
    }).authorizer({ publicJwk });
    expect(await oldAuthorizer.authorize({ ...page, sessionToken: session.sessionToken })).toEqual({
      authorized: true,
    });
    await expect(
      oldAuthorizer.authorize({
        ...page,
        organizationHint: parseUlid(project.organizationId),
        sessionToken: session.sessionToken,
      }),
    ).rejects.toBeInstanceOf(DevAccessUnavailableError);
    // Issuing the next ticket advances the epoch, which ends every earlier session.
    await issueTicket();
    expect(await authorizer.authorize({ ...page, sessionToken: session.sessionToken })).toEqual({
      authorized: false,
    });

    const probe = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      environmentId: project.devEnvironmentId,
      operationId: newUlid(),
      deploymentId: newUlid(),
      handle: project.handle,
      origin,
      path: "/healthz",
      method: "GET",
    };
    // The Core refuses a probe for a deployment that holds no provider claim; a granted one is signed and verifiable.
    await expect(
      sessions.probeIssuer({ privateJwk, publicJwk }).issue(probe),
    ).rejects.toBeInstanceOf(DevAccessUnavailableError);
    const granting = Object.fromEntries(
      D1_DEV_ACCESS_METHODS.map((method) => [
        method,
        method === "authorizeDevRuntimeProbe"
          ? async () => true
          : (input: unknown) =>
              (store.devAccess as never as Record<string, (i: unknown) => unknown>)[method]?.(
                input,
              ),
      ]),
    ) as never;
    const issued = await createD1DevAccessSessions({
      runtime: granting,
      clock,
      crypto: globalThis.crypto,
    })
      .probeIssuer({ privateJwk, publicJwk })
      .issue(probe);
    expect(Object.keys(issued).sort()).toEqual(["expiresAt", "probeToken"]);
  } finally {
    await control.dispose();
  }
}, 120_000);

/** A Dev environment as project creation leaves it: protected, no share link and access epoch 0 (the seeding fixture starts at 1). */
async function virginDev(control: Awaited<ReturnType<typeof createTestControl>>) {
  const seeded = await seedDevAccessProject(control);
  await control.core
    .prepare("UPDATE environments SET dev_access_epoch=0 WHERE project_id=?1 AND name='dev'")
    .bind(seeded.project.projectId)
    .run();
  return seeded;
}
const sealedLink = (n: number) => ({
  ciphertext: "ab".repeat(20),
  nonce: "cd".repeat(12),
  valueSha256: n.toString(16).padStart(64, "0"),
  keyVersion: 1,
});
const devState = (control: Awaited<ReturnType<typeof createTestControl>>, projectId: string) =>
  control.core
    .prepare(
      "SELECT (SELECT dev_access_epoch FROM environments WHERE project_id=?1 AND name='dev') epoch,(SELECT count(*) FROM dev_share_links WHERE project_id=?1) links,(SELECT generation FROM dev_share_links WHERE project_id=?1) generation",
    )
    .bind(projectId)
    .first();

it("serves, rotates and mode-switches the share link of a virgin Dev at epoch zero, advancing the epoch once with the first link and never for public Dev", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings);
    let now = Date.parse("2026-10-29T10:00:00.000Z");
    const clock = { now: () => new Date((now += 1000)) },
      cipher = createEnvironmentSecretCipherKeyring({
        primaryKeyBase64: Buffer.alloc(32, 0x41).toString("base64"),
        currentKeyVersion: 1,
        crypto: globalThis.crypto,
      }),
      port = createD1DevAccessManagementPort({
        runtime: store.devAccess,
        clock,
        crypto: globalThis.crypto,
        cipher,
      }),
      contextOf = (seeded: Awaited<ReturnType<typeof virginDev>>) => ({
        organizationId: parseUlid(seeded.project.organizationId),
        projectId: parseUlid(seeded.project.projectId),
        principalId: seeded.principalId,
        requestId: "req_virgin",
      });

    // Get: the first link of a virgin Dev is saved and the epoch leaves zero; the next get shows the same link.
    const got = await virginDev(control),
      ensured = await port.ensure(contextOf(got));
    expect(ensured.shareUrl).toMatch(/\/\.ohmyhost\/dev-access\/redeem\?stage=dev&ticket=/u);
    expect(await devState(control, got.project.projectId)).toEqual({
      epoch: 1,
      links: 1,
      generation: 1,
    });
    expect(await port.ensure(contextOf(got))).toEqual(ensured);

    // Rotate: the first link also comes from a rotation, replays by key and never lands on epoch 0.
    const rotating = await virginDev(control),
      rotated = await port.rotate(contextOf(rotating), "rotate-virgin");
    expect(rotated.shareUrl).toMatch(/ticket=[A-Za-z0-9_-]{43}$/u);
    expect(await devState(control, rotating.project.projectId)).toEqual({
      epoch: 1,
      links: 1,
      generation: 1,
    });
    expect(await port.rotate(contextOf(rotating), "rotate-virgin")).toEqual(rotated);
    // The replay writes nothing: not even the Core, asked again with the stale epoch 0, advances it a second time.
    expect(
      await store.devAccess.changeDevAccess({
        organizationId: rotating.project.organizationId,
        projectId: rotating.project.projectId,
        principalId: rotating.principalId,
        now: "2026-10-29T10:10:00.000Z",
        expected: { mode: "protected", generation: null, linkValueSha256: null, epoch: 0 },
        link: { action: "save", ...sealedLink(7) },
        bumpEpoch: true,
        rotationKeySha256: createHash("sha256").update("rotate-virgin").digest("hex"),
      }),
    ).toEqual({ replayed: "rotation", generation: 1 });
    expect(await devState(control, rotating.project.projectId)).toEqual({
      epoch: 1,
      links: 1,
      generation: 1,
    });

    // Setting the mode it already has must not save a link at epoch 0 either.
    const moding = await virginDev(control),
      switched = await port.setMode(contextOf(moding), "protected", "mode-virgin");
    expect(switched.shareUrl).toMatch(/ticket=[A-Za-z0-9_-]{43}$/u);
    expect(await devState(control, moding.project.projectId)).toEqual({
      epoch: 1,
      links: 1,
      generation: 1,
    });

    // Public Dev has nothing to issue: reading, rotating and re-setting it leave epoch 0, while switching modes advances it.
    const open = await virginDev(control),
      closing = await virginDev(control);
    await control.core
      .prepare("UPDATE projects SET dev_access_mode='public' WHERE project_id=?1")
      .bind(open.project.projectId)
      .run();
    expect(await port.ensure(contextOf(open))).toEqual({ mode: "public", shareUrl: null });
    expect(await port.rotate(contextOf(open), "rotate-public")).toEqual({
      mode: "public",
      shareUrl: null,
    });
    expect(await port.setMode(contextOf(open), "public", "mode-public")).toEqual({
      mode: "public",
      shareUrl: null,
    });
    expect(await devState(control, open.project.projectId)).toEqual({
      epoch: 0,
      links: 0,
      generation: null,
    });
    expect((await port.setMode(contextOf(open), "protected", "mode-open")).shareUrl).toMatch(
      /ticket=[A-Za-z0-9_-]{43}$/u,
    );
    expect(await devState(control, open.project.projectId)).toEqual({
      epoch: 1,
      links: 1,
      generation: 1,
    });
    expect(await port.setMode(contextOf(closing), "public", "mode-closing")).toEqual({
      mode: "public",
      shareUrl: null,
    });
    expect(await devState(control, closing.project.projectId)).toEqual({
      epoch: 1,
      links: 0,
      generation: null,
    });

    // The floor is exactly zero: the Core still refuses a negative epoch in a decision.
    const strict = await virginDev(control);
    await expect(
      store.devAccess.changeDevAccess({
        organizationId: strict.project.organizationId,
        projectId: strict.project.projectId,
        principalId: strict.principalId,
        now: "2026-10-29T10:10:00.000Z",
        expected: { mode: "protected", generation: null, linkValueSha256: null, epoch: -1 },
        bumpEpoch: true,
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(await devState(control, strict.project.projectId)).toEqual({
      epoch: 0,
      links: 0,
      generation: null,
    });
  } finally {
    await control.dispose();
  }
}, 120_000);

it("issues the first ticket of a virgin Dev at epoch one, refuses a stale epoch-zero link decision and never accepts a session at epoch zero", async () => {
  const control = await createTestControl();
  try {
    const store = createControlStore(control.bindings),
      seeded = await virginDev(control);
    let now = Date.parse("2026-10-29T10:00:00.000Z");
    const clock = { now: () => new Date((now += 1000)) },
      tickets = createD1DevAccessTicketsPort({
        runtime: store.devAccess,
        clock,
        ids: { next: () => parseUlid(newUlid()) },
        crypto: globalThis.crypto,
      }),
      issued = await tickets.issue({
        organizationId: parseUlid(seeded.project.organizationId),
        projectId: parseUlid(seeded.project.projectId),
        principalId: seeded.principalId,
        requestId: "req_virgin_ticket",
      });
    expect(issued.redeemUrl.startsWith(`${seeded.origin}/.ohmyhost/dev-access/redeem?`)).toBe(true);
    expect(await devState(control, seeded.project.projectId)).toEqual({
      epoch: 1,
      links: 0,
      generation: null,
    });
    // A link decision made at epoch 0 that meets the ticket's epoch 1 is stale: refused, nothing written.
    await expect(
      store.devAccess.changeDevAccess({
        organizationId: seeded.project.organizationId,
        projectId: seeded.project.projectId,
        principalId: seeded.principalId,
        now: "2026-10-29T10:10:00.000Z",
        expected: { mode: "protected", generation: null, linkValueSha256: null, epoch: 0 },
        link: { action: "save", ...sealedLink(9) },
        bumpEpoch: false,
      }),
    ).rejects.toMatchObject({ code: "dev_access_state_changed" });
    expect(await devState(control, seeded.project.projectId)).toEqual({
      epoch: 1,
      links: 0,
      generation: null,
    });
    // A session at epoch zero is refused by the schema, never answered "false" from a lookup.
    await expect(
      store.devAccess.authorizeDevAccessSession({
        projectId: seeded.project.projectId,
        environmentId: seeded.project.devEnvironmentId,
        handle: seeded.project.handle,
        origin: seeded.origin,
        devAccessEpoch: 0,
        principalId: seeded.principalId,
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
  } finally {
    await control.dispose();
  }
}, 120_000);
