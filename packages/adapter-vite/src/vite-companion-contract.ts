import { VITE_COMPANION_ENTRY_PATH } from "@ohmyhost/contracts/framework-source-rules";

const COMPATIBILITY_FLAGS = Object.freeze(["nodejs_compat"]);

export const VITE_API_COMPANION_CONTRACT = Object.freeze({
  schemaVersion: "ohmyhost.vite-api-companion/v1" as const,
  sourceEntryPoint: VITE_COMPANION_ENTRY_PATH,
  artifact: Object.freeze({
    outputDirectory: ".ohmyhost/vite-companion" as const,
    entryPoint: ".ohmyhost/vite-companion/worker.js" as const,
    configPath: ".ohmyhost/vite-companion/wrangler.jsonc" as const,
  }),
  runtime: Object.freeze({
    compatibilityDate: "2025-01-01" as const,
    compatibilityFlags: COMPATIBILITY_FLAGS,
    handlerExport: "default.fetch" as const,
    routePrefix: "/api/" as const,
  }),
  bindings: Object.freeze({
    database: "OHMYHOST_DATABASE" as const,
    authSecret: "BETTER_AUTH_SECRET" as const,
  }),
});
