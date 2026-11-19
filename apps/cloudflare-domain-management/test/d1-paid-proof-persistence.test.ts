import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createUlidFactory, SystemClock, SystemEntropy, parseUlid } from "@ohmyhost/platform";
import { CloudflareDomainRuntime } from "../../control-store/src/worker-main.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { cfFixture } from "../../control-store/test/support/cf-mail-fixture.js";
import { seam } from "../../control-store/test/support/wire.js";
import { createD1PaidDomainPersistence } from "../src/d1-paid-persistence.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

const ids = createUlidFactory({ clock: new SystemClock(), entropy: new SystemEntropy() }),
  iso = (delta = 0) => new Date(Date.now() + delta).toISOString(),
  DAY = 86_400_000;
let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 60_000);
afterAll(async () => control.dispose());

it("issues, verifies and reads a Paid hostname's ownership proof through the actual Core", async () => {
  const fixture = await cfFixture(control),
    project = fixture.project,
    scope = {
      organizationId: parseUlid(project.organizationId),
      projectId: parseUlid(project.projectId),
    },
    wire = seam(new CloudflareDomainRuntime({} as never, control.bindings as never)),
    paid = createD1PaidDomainPersistence(wire.binding as never, ids),
    hostname = "app.proof-persistence.example",
    challengeValue = `omh-domain-v1=${"p".repeat(43)}`;

  // Nothing is issued until the Paid apply asks for a challenge.
  expect(await paid.readProof({ ...scope, hostname, now: iso() })).toBeNull();
  expect(await paid.readProof({ ...scope, hostname: null, now: iso() })).toBeNull();

  const pending = await paid.ensureProof({ ...scope, hostname, challengeValue, now: iso() });
  expect(pending).toMatchObject({
    organizationId: project.organizationId,
    projectId: project.projectId,
    hostname,
    state: "pending",
    challengeName: `_omh-project.${hostname}`,
    challengeValue,
    verifiedAt: null,
    expiresAt: null,
  });
  // A repeat keeps the challenge already issued, whatever value it is offered.
  expect(
    await paid.ensureProof({
      ...scope,
      hostname,
      challengeValue: `omh-domain-v1=${"q".repeat(43)}`,
      now: iso(),
    }),
  ).toEqual(pending);
  // Without a hostname, the latest pending challenge of the project shows.
  expect(await paid.readProof({ ...scope, hostname: null, now: iso() })).toMatchObject({
    hostname,
    state: "pending",
  });

  const verified = await paid.verifyProof({
    ...scope,
    hostname,
    challengeValue,
    now: iso(),
    expiresAt: iso(30 * DAY),
  });
  expect(verified).toMatchObject({ hostname, state: "verified", challengeValue });
  expect(verified?.expiresAt).not.toBeNull();
  expect(await paid.readProof({ ...scope, hostname, now: iso() })).toMatchObject({
    state: "verified",
  });
  // A verified proof is no longer a pending challenge of the project.
  expect(await paid.readProof({ ...scope, hostname: null, now: iso() })).toBeNull();
  // A value that is not the issued challenge verifies nothing.
  expect(
    await paid.verifyProof({
      ...scope,
      hostname: "app.other-proof.example",
      challengeValue,
      now: iso(),
      expiresAt: iso(30 * DAY),
    }),
  ).toBeNull();
});
