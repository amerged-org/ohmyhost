import { afterEach, expect, it, vi } from "vitest";

const createAuthClient = vi.hoisted(() => vi.fn(() => ({ signIn: { email() {} } })));
vi.mock("better-auth/client", () => ({ createAuthClient }));

import { createNativeAuthBrowser } from "./auth-browser.js";

afterEach(() => vi.unstubAllGlobals());

it("uses the current origin and same-origin cookies with the fixed auth path", () => {
  vi.stubGlobal("window", { location: { origin: "https://app.example.test" } });
  createNativeAuthBrowser();
  expect(createAuthClient).toHaveBeenCalledWith({
    baseURL: "https://app.example.test",
    basePath: "/api/auth/v1",
    fetchOptions: { credentials: "same-origin", retry: 0, onRequest: expect.any(Function) },
  });
});

it("does not construct a browser client during server rendering", () => {
  vi.stubGlobal("window", undefined);
  expect(() => createNativeAuthBrowser()).toThrow("requires a browser");
});
