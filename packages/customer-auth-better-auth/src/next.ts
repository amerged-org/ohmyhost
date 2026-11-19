import { toNextJsHandler } from "better-auth/next-js";

import type { CustomerAuth } from "./runtime.js";

export function createNextCustomerAuthHandler(auth: CustomerAuth) {
  return Object.freeze(toNextJsHandler(auth));
}
