const TABLES = Object.freeze(["account", "rateLimit", "session", "user", "verification"]);
const SECRETS = Object.freeze(["BETTER_AUTH_SECRET"]);

export const CUSTOMER_AUTH_INSTALLATION_CONTRACT = Object.freeze({
  package: Object.freeze({
    name: "better-auth" as const,
    version: "1.7.7" as const,
  }),
  database: Object.freeze({
    schema: "auth" as const,
    idGeneration: "uuid" as const,
    tables: TABLES,
    binding: "OHMYHOST_DATABASE" as const,
  }),
  http: Object.freeze({ routePath: "/api/auth" as const, handlerExport: "fetch" as const }),
  secrets: SECRETS,
});
