import { describe, expect, it } from "vitest";

import * as customerAuth from "./index.js";

describe("customer auth template exports", () => {
  it("exports only the shared runtime, schema, and Web handler surfaces", () => {
    expect(Object.keys(customerAuth).sort()).toEqual([
      "CUSTOMER_AUTH_INSTALLATION_CONTRACT",
      "CustomerAuthEmailDeliveryError",
      "createCustomerAuth",
      "createCustomerAuthFetchHandler",
      "createCustomerAuthOptions",
      "createCustomerAuthPostgresPool",
      "createMailGatewayEmailSender",
      "renderCustomerAuthMigration",
    ]);
  });
});
