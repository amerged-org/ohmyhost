import { describe, expect, it, vi } from "vitest";

import { createTanStackCustomerAuthHandler } from "./tanstack.js";
import { createViteCustomerAuthCompanion } from "./vite-companion.js";

describe("TanStack and Vite Better Auth templates", () => {
  it("mounts TanStack through the standard Request/Response handler", async () => {
    const handler = vi.fn(async () => new Response("tanstack"));
    const route = createTanStackCustomerAuthHandler({ handler } as never);
    await expect(route(new Request("https://app.example/api/auth/session"))).resolves.toMatchObject(
      { status: 200 },
    );
    expect(handler).toHaveBeenCalledOnce();
  });

  it("exposes one same-origin Vite companion fetch capability", async () => {
    const handler = vi.fn(async () => new Response("vite"));
    const companion = createViteCustomerAuthCompanion({ handler } as never);
    expect(Object.keys(companion)).toEqual(["fetch"]);
    expect(Object.isFrozen(companion)).toBe(true);
    await expect(
      companion.fetch(new Request("https://app.example/api/auth/session")),
    ).resolves.toMatchObject({ status: 200 });
  });
});
