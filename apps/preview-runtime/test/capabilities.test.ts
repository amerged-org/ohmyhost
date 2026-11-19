import { expect, it, vi } from "vitest";
import {
  decodePreviewValue,
  encodePreviewValue,
} from "@ohmyhost/customer-runtime/preview-transport";
import {
  createPreviewCapabilityHandler,
  type PreviewCapabilityBindings,
} from "../src/capability-bridge.js";
import { PreviewDatabaseHandles, type PreviewDatabaseService } from "../src/database-handles.js";

it("checks current source and scope around database, Native Auth and gateway calls", async () => {
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const source = {
    sourceConnectionId: id,
    sourceGeneration: 1,
    sequence: 1,
    commitSha: "a".repeat(40),
  };
  const fence = { previewId: id, runtimeGeneration: 2, tokenGeneration: 1 };
  let current = {
    ...fence,
    state: "ready",
    retirement: "none",
    targetSource: source,
    appliedSource: source,
    region: "us",
    authGeneration: 1,
    assignmentVersion: 1,
    billingEpochId: id,
    dataEnvironmentId: id,
    ownershipVersion: 1,
    lifecycleVersion: 1,
  };
  const connection = {
    query: vi.fn(async () => ({ command: "SELECT" })),
    commit: vi.fn(async () => ({ ok: true })),
    close: vi.fn(async () => {}),
  };
  const database: PreviewDatabaseService = {
    execute: vi.fn(async () => ({ command: "SELECT" })),
    open: vi.fn(async () => connection),
    openRls: vi.fn(async () => connection),
  };
  const handles = new PreviewDatabaseHandles();
  const bindings = {
    authority: { authorizeRuntime: async () => current },
    database: () => database,
    nativeAuth: () => ({ validatePreviewSession: async () => null }),
    heldDatabase: async (input: {
      operation: Parameters<typeof handles.invoke>[2];
      input: unknown;
    }) => handles.invoke(database, fence, input.operation, input.input),
    platform: { fetchPreview: async () => new Response("accepted") },
  } as unknown as PreviewCapabilityBindings;
  const handler = createPreviewCapabilityHandler(bindings);
  const selection = { source, database: true, auth: true, mail: true, storage: false, ai: false };
  const post = (path: string, value: unknown) =>
    new Request(`http://preview.capabilities${path}`, {
      method: "POST",
      body: encodePreviewValue(value),
    });
  const query = await handler(
    post("/database/query", { text: "SELECT 1", values: [] }),
    fence,
    selection,
    "https://preview.example",
  );
  expect(decodePreviewValue(await query.text())).toEqual({ command: "SELECT" });
  const opened = await handler(
    post("/database/open", null),
    fence,
    selection,
    "https://preview.example",
  );
  const { handle } = decodePreviewValue(await opened.text()) as { handle: string };
  await handler(
    post("/database/connection-query", { handle, input: { text: "SELECT 1" } }),
    fence,
    selection,
    "https://preview.example",
  );
  await handler(
    post("/database/connection-close", { handle }),
    fence,
    selection,
    "https://preview.example",
  );
  expect(connection.query).toHaveBeenCalledOnce();
  expect(connection.close).toHaveBeenCalledOnce();
  const auth = await handler(
    new Request("http://preview.capabilities/native-auth/session", { method: "POST" }),
    fence,
    selection,
    "https://preview.example",
  );
  expect(decodePreviewValue(await auth.text())).toBeNull();
  expect(
    (await handler(post("/mail/v1/send", {}), fence, selection, "https://preview.example")).status,
  ).toBe(200);
  current = { ...current, targetSource: { ...source, sequence: 2 } };
  expect(
    (await handler(post("/database/query", {}), fence, selection, "https://preview.example"))
      .status,
  ).toBe(403);
  await handles.closeAll();
});

it("closes every held connection at the generation fence", async () => {
  const fence = {
    previewId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    runtimeGeneration: 2,
    tokenGeneration: 1,
  };
  const close = vi.fn(async () => {}),
    commit = vi.fn(async () => ({ committed: true }));
  const connection = { query: async () => null, commit, close };
  const service: PreviewDatabaseService = {
    execute: async () => null,
    open: async () => connection,
    openRls: async () => connection,
  };
  const handles = new PreviewDatabaseHandles();
  const first = (await handles.invoke(service, fence, "openRls", { subject: "user" })) as {
    handle: string;
  };
  await handles.invoke(service, fence, "connection-commit", { handle: first.handle });
  await expect(
    handles.invoke(service, { ...fence, tokenGeneration: 2 }, "connection-query", {
      handle: first.handle,
      input: {},
    }),
  ).rejects.toThrow();
  await handles.closeAll();
  expect(commit).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  vi.useFakeTimers();
  try {
    await handles.invoke(service, fence, "open", null);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(close).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
