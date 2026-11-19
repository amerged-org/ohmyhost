import type { CustomerAuth } from "./runtime.js";
import { CUSTOMER_AUTH_INSTALLATION_CONTRACT } from "./installation-contract.js";

export function createCustomerAuthFetchHandler(auth: CustomerAuth) {
  if (typeof auth?.handler !== "function") throw new TypeError("Customer auth handler is invalid");
  return async (request: Request): Promise<Response> => {
    if (!(request instanceof Request)) throw new TypeError("Customer auth request is invalid");
    const pathname = new URL(request.url).pathname;
    const routePath = CUSTOMER_AUTH_INSTALLATION_CONTRACT.http.routePath;
    if (pathname !== routePath && !pathname.startsWith(`${routePath}/`)) {
      return new Response("Not Found", {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    }
    return auth.handler(request);
  };
}
