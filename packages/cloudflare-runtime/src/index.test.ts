import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type {
  CloudflareQueueBatch,
  CloudflareQueueBinding,
  CloudflareWorkflowBinding,
} from "./index.js";

describe("Cloudflare runtime contracts", () => {
  it("keeps Queue delivery acknowledgement explicit", async () => {
    const send = vi.fn(async () => undefined);
    const queue: CloudflareQueueBinding<string> = { send };
    await queue.send("body");
    expect(send).toHaveBeenCalledWith("body");
    expectTypeOf<CloudflareQueueBatch<string>["messages"][number]["ack"]>().toBeFunction();
  });

  it("requires deterministic Workflow creation and adoption surfaces", async () => {
    const instance = { status: vi.fn(async () => ({ status: "running" })) };
    const create = vi.fn(async () => instance);
    const get = vi.fn(async () => instance);
    const workflow: CloudflareWorkflowBinding<{ readonly slotId: string }> = { create, get };
    await workflow.create({ id: "scheduled-slot-1", params: { slotId: "slot-1" } });
    await workflow.get("scheduled-slot-1");
    expect(create).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith("scheduled-slot-1");
  });
});
