import { expect, it } from "vitest";
it("connection discovery returns only safe fields for the selected team", async () => {
  const { listMakeConnections } = await import("../src/providers/make-catalog.js");
  const fetcher = async (url: string | URL | Request) => {
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe("/api/v2/connections");
    expect(parsed.searchParams.get("teamId")).toBe("7");
    return Response.json({ connections: [{ id: 9, name: "CRM", teamId: 7, token: "secret" }] });
  };
  expect(
    await listMakeConnections({ zone: "eu1", accessToken: "token", teamId: 7 }, fetcher),
  ).toEqual([{ id: 9, name: "CRM" }]);
});
