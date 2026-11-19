import { describe, expect, it, vi } from "vitest";

import { createCustomerAuthFetchHandler } from "./web-handler.js";

describe("same-origin Better Auth Web handler", () => {
  it("forwards only the fixed auth path and returns a no-store 404 otherwise", async () => {
    const handler = vi.fn(async () => new Response("auth", { status: 200 }));
    const fetch = createCustomerAuthFetchHandler({ handler } as never);

    await expect(fetch(new Request("https://app.example/api/auth/session"))).resolves.toMatchObject(
      { status: 200 },
    );
    const missing = await fetch(new Request("https://app.example/dashboard"));
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rejects malformed dependencies and requests", async () => {
    expect(() => createCustomerAuthFetchHandler({} as never)).toThrow(
      "Customer auth handler is invalid",
    );
    const fetch = createCustomerAuthFetchHandler({ handler: vi.fn() } as never);
    await expect(fetch({} as never)).rejects.toThrow("Customer auth request is invalid");
  });
});
