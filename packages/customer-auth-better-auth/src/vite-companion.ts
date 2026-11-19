import type { CustomerAuth } from "./runtime.js";
import { createCustomerAuthFetchHandler } from "./web-handler.js";

export function createViteCustomerAuthCompanion(auth: CustomerAuth) {
  return Object.freeze({ fetch: createCustomerAuthFetchHandler(auth) });
}
