import { Pool } from "pg";

import { createCustomerAuth } from "./src/runtime.js";

export const auth = createCustomerAuth({
  appName: "ohmyhost Customer Auth Schema",
  publicOrigin: "https://schema.invalid",
  database: new Pool({
    connectionString:
      process.env["BETTER_AUTH_SCHEMA_DATABASE_URL"] ??
      "postgresql://schema:unused@127.0.0.1:5432/schema",
    options: "-c search_path=auth",
  }),
  secret: "x".repeat(32),
  email: {
    send: () => Promise.reject(new Error("Schema generation cannot send e-mail")),
  },
});
