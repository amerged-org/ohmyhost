import { describe, expect, it, vi } from "vitest";
import { createNativeAuthServer, NativeAuthRequiredError } from "./auth-server.js";

describe("Native Auth server helper", () => {
  it("passes only the request cookie to the scoped binding and returns the documented identity", async () => {
    const validateSession = vi.fn().mockResolvedValue({
      user: { id: "u", email: "u@example.test", secret: "hidden" },
      session: { id: "s", expiresAt: "2027-01-01T00:00:00Z" },
    });
    const client = createNativeAuthServer({ validateSession });
    const request = new Request("https://app.example.test/", {
      headers: { cookie: "session=opaque", authorization: "forged" },
    });
    expect(await client.requireUser(request)).toEqual({ id: "u", email: "u@example.test" });
    expect(validateSession).toHaveBeenCalledWith({ cookie: "session=opaque" });
  });

  it("denies missing sessions and propagates unavailable or malformed responses", async () => {
    const request = new Request("https://app.example.test/");
    const validateSession = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({});
    const client = createNativeAuthServer({ validateSession });
    await expect(client.requireUser(request)).rejects.toBeInstanceOf(NativeAuthRequiredError);
    await expect(client.getSession(request)).rejects.toThrow("unavailable");
    await expect(client.getSession(request)).rejects.toThrow("auth_response_invalid");
  });
});
