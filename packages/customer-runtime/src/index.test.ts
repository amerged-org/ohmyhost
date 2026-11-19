import { describe, expect, it } from "vitest";

import * as customerRuntime from "./index.js";

describe("customer runtime package", () => {
  it("exports only the server runtime client surface", () => {
    expect(Object.keys(customerRuntime).sort()).toEqual([
      "CustomerDatabaseError",
      "CustomerRuntimeError",
      "CustomerRuntimeGatewayError",
      "createMailAttachmentClient",
      "createPrivateDatabaseClient",
      "createPrivateStorageClient",
      "createTransactionalMailClient",
      "verifyMailWebhook",
    ]);
  });
});
