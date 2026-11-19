import { expect, it } from "vitest";
import { parseConnectionResponse } from "../src/connection-management.js";

it("accepts only bounded safe connection metadata and an origin-bound handoff", () => {
  const origin = "https://dev.app.ohmyho.st",
    timestamp = "2030-01-01T00:00:00Z";
  const handoff = {
    request_id: "a".repeat(64),
    url: `${origin}/connections/authorize?request=${"b".repeat(43)}`,
    expires_at: timestamp,
  };
  expect(parseConnectionResponse("connection-begin", handoff, origin)).toEqual(handoff);
  expect(() =>
    parseConnectionResponse("connection-begin", handoff, "https://app.ohmyho.st"),
  ).toThrow();
  expect(
    parseConnectionResponse("connection-status", { state: "pending", expires_at: timestamp }),
  ).toEqual({ state: "pending", expires_at: timestamp });
  expect(parseConnectionResponse("connection-disconnect", { state: "revocation_pending" })).toEqual(
    { state: "revocation_pending" },
  );
  const grants = {
    connections: [
      {
        id: "01K00000000000000000000001",
        provider: "make",
        state: "active",
        created_at: timestamp,
      },
    ],
  };
  expect(parseConnectionResponse("connection-list", grants)).toEqual(grants);
  const result = {
    organizations: [{ id: 1, name: "Org" }],
    teams: [],
    connections: [{ id: 2, name: "CRM" }],
  };
  expect(parseConnectionResponse("connection-discover", result)).toEqual(result);
  expect(() =>
    parseConnectionResponse("connection-discover", {
      ...result,
      connections: [{ id: 2, name: "CRM", token: "private" }],
    }),
  ).toThrow();
});
