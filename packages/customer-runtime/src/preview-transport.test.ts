import { expect, it } from "vitest";
import { createPrivateDatabaseClient } from "./database.js";
import {
  createPreviewDatabaseBinding,
  createPreviewNativeAuthBinding,
  decodePreviewValue,
  encodePreviewValue,
} from "./preview-transport.js";

it("preserves values and marks a lost database reply as a nonretryable unknown outcome", async () => {
  const value = { bytes: new Uint8Array([0, 42, 255]), date: new Date("2026-01-01T00:00:00.000Z") };
  expect(decodePreviewValue(encodePreviewValue(value))).toEqual(value);
  const db = createPrivateDatabaseClient(
    createPreviewDatabaseBinding({
      fetch: async () => {
        throw new Error("connection lost");
      },
    }),
  );
  await expect(
    db.query({ text: "UPDATE example SET n = n + 1", values: [] }),
  ).rejects.toMatchObject({ code: "08007", retryable: false });
});

it("round-trips supported nested values and rejects malformed tagged input", () => {
  const values = [null, true, 42, "text", ["nested", { value: false }], new Uint8Array([1, 2])];
  expect(decodePreviewValue(encodePreviewValue(values))).toEqual(values);
  expect(() => encodePreviewValue(Infinity)).toThrow("preview_transport_invalid");
  expect(() =>
    decodePreviewValue('["object",[["key",["null",null]],["key",["null",null]]]]'),
  ).toThrow("preview_transport_invalid");
});

it("carries database handles and Native sessions over the private capability endpoint", async () => {
  const requests: { path: string; value: unknown }[] = [];
  const session = {
    user: { id: "user-1", email: "user@example.test" },
    session: { id: "session-1", expiresAt: "2026-11-17T00:00:00.000Z" },
  };
  const fetch = async (request: Request) => {
    const path = new URL(request.url).pathname;
    requests.push({
      path,
      value:
        path === "/native-auth/session"
          ? request.headers.get("cookie")
          : decodePreviewValue(await request.text()),
    });
    return new Response(
      encodePreviewValue(
        path.endsWith("/open") || path.endsWith("/openRls")
          ? { handle: "opaque-handle" }
          : path === "/native-auth/session"
            ? session
            : { ok: true },
      ),
    );
  };
  const database = createPreviewDatabaseBinding({ fetch });
  await database.query({ sql: "select" });
  await database.transaction({ statements: [] });
  if (!database.open || !database.openRls) throw new Error("missing preview database operations");
  const connection = await database.open();
  await connection.query({ sql: "update" });
  await connection.close();
  const rls = await database.openRls({ subject: "user-1" });
  await rls.commit();
  await rls.close();
  expect(
    requests
      .filter((request) => request.path.includes("connection-"))
      .map((request) => request.value),
  ).toEqual([
    { handle: "opaque-handle", input: { sql: "update" } },
    { handle: "opaque-handle" },
    { handle: "opaque-handle" },
    { handle: "opaque-handle" },
  ]);
  const auth = createPreviewNativeAuthBinding({ fetch });
  expect(await auth.validateSession({ cookie: "session=opaque" })).toEqual(session);
  await expect(auth.validateSession({ cookie: "x".repeat(16_385) })).rejects.toThrow(
    "auth_unavailable",
  );
  expect(requests.at(-1)).toEqual({ path: "/native-auth/session", value: "session=opaque" });
});
