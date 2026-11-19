/* global Request */
import { execFile } from "node:child_process";
import { webcrypto as crypto } from "node:crypto";
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { once } from "node:events";
import process from "node:process";
import { expect, it } from "vitest";

import { createTofuStateService } from "../src/state.js";

const run = promisify(execFile);

it("lets the installed OpenTofu HTTP backend lock, push, pull and force-unlock one recoverable state", async () => {
  let record = {
    revision: 0,
    snapshotKey: null,
    sha256: null,
    bytes: 0,
    deleted: true,
    lock: null,
  };
  const snapshots = new Map();
  const service = createTofuStateService({
    name: "poc-private-fullstack/test.tfstate",
    crypto,
    metadata: {
      async read() {
        return record;
      },
      async update(change) {
        const next = change(record);
        record = next.record;
        return next.result;
      },
    },
    snapshots: {
      async putIfAbsent(key, bytes) {
        if (snapshots.has(key)) return false;
        snapshots.set(key, Uint8Array.from(bytes));
        return true;
      },
      async read(key) {
        const value = snapshots.get(key);
        return value === undefined ? null : Uint8Array.from(value);
      },
    },
  });
  const methods = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      methods.push(incoming.method);
      const response = await service.fetch(
        new Request(`http://127.0.0.1${incoming.url}`, {
          method: incoming.method,
          ...(body.length ? { body } : {}),
        }),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(503);
      outgoing.end();
    }
  });
  const directory = await mkdtemp(join(tmpdir(), "omh-tofu-http-"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No test listener");
  const endpoint = `http://127.0.0.1:${address.port}/state/poc-private-fullstack/test.tfstate`;
  const environment = {
    ...process.env,
    TF_HTTP_ADDRESS: endpoint,
    TF_HTTP_LOCK_ADDRESS: endpoint,
    TF_HTTP_UNLOCK_ADDRESS: endpoint,
    TF_HTTP_USERNAME: "tofu",
    TF_HTTP_PASSWORD: "s".repeat(43),
    TF_IN_AUTOMATION: "1",
  };
  try {
    await writeFile(join(directory, "main.tf"), 'terraform {\n  backend "http" {}\n}\n');
    const state = {
      version: 4,
      terraform_version: "1.12.6",
      serial: 1,
      lineage: "00000000-0000-4000-8000-000000000001",
      outputs: {},
      resources: [],
    };
    await writeFile(join(directory, "state.json"), `${JSON.stringify(state)}\n`);
    await run("tofu", ["init", "-input=false", "-no-color"], { cwd: directory, env: environment });
    await run("tofu", ["state", "push", "state.json"], { cwd: directory, env: environment });
    const { stdout } = await run("tofu", ["state", "pull"], { cwd: directory, env: environment });
    expect(JSON.parse(stdout)).toMatchObject({ serial: 1, outputs: {}, resources: [] });
    expect(methods).toContain("LOCK");
    expect(methods).toContain("POST");
    expect(methods).toContain("UNLOCK");
    expect(record.revision).toBe(1);
    expect(snapshots.size).toBe(1);
    // An interrupted apply leaves its lock behind; a fresh OpenTofu process clears it with
    // force-unlock, which sends the lock ID it is given, and only the matching ID does.
    const stale = {
      ID: "0b7f2a9c-5d3e-4f61-8a2b-9c4d5e6f7a8b",
      Operation: "OperationTypeApply",
      Info: "",
      Who: "interrupted@runner",
      Version: "1.12.6",
      Created: "2026-09-24T00:00:00Z",
      Path: "",
    };
    const locked = await service.fetch(
      new Request(endpoint, { method: "LOCK", body: JSON.stringify(stale) }),
    );
    expect(locked.status).toBe(200);
    const unlocks = () => methods.filter((method) => method === "UNLOCK").length;
    const unlocksBefore = unlocks();
    await expect(
      run("tofu", ["force-unlock", "-force", "1a2b3c4d-0000-4000-8000-000000000000"], {
        cwd: directory,
        env: environment,
      }),
    ).rejects.toThrow();
    expect(record.lock?.id).toBe(stale.ID);
    await run("tofu", ["force-unlock", "-force", stale.ID], { cwd: directory, env: environment });
    expect(record.lock).toBeNull();
    expect(unlocks()).toBe(unlocksBefore + 2);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
