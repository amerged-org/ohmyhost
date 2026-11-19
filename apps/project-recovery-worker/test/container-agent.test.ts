import { once } from "node:events";
import { expect, it } from "vitest";

import { createRecoveryAgentServer } from "../src/container-agent.js";

const command = {
  action: "download",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
};

it("accepts only one bounded private Recovery command and redacts failures", async () => {
  const token = "a".repeat(43);
  const calls: unknown[] = [];
  const server = createRecoveryAgentServer(token, async (value) => {
    calls.push(value);
    return { status: "unavailable" };
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No local listener");
  const url = `http://127.0.0.1:${address.port}/invoke`;
  try {
    const submit = (value: unknown, bearer = token) =>
      fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
        body: JSON.stringify(value),
      });
    expect((await submit(command, "b".repeat(43))).status).toBe(404);
    expect((await submit({ ...command, secret: "private" })).status).toBe(400);
    expect((await submit({ ...command, padding: "x".repeat(17_000) })).status).toBe(413);
    expect(await (await submit(command)).json()).toEqual({ status: "unavailable" });
    expect(calls).toEqual([command]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  expect(() => createRecoveryAgentServer("weak", async () => null)).toThrow();
});
