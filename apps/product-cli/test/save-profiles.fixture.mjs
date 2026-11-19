// Saves a batch of logins into one index directory as a separate process on the same computer
// would. Its credential entries live in this process's memory, so no native store is ever loaded.
import process from "node:process";

import { NativeKeyringProfileRegistry } from "../dist/profile-store.js";

const [directory, prefix, count] = process.argv.slice(2);
const entries = new Map();
const registry = new NativeKeyringProfileRegistry(
  async (account) => ({
    setPassword: async (password) => {
      entries.set(account, password);
    },
    getPassword: async () => entries.get(account),
    deleteCredential: async () => entries.delete(account),
  }),
  "ohmyhost",
  directory,
);
await Promise.all(
  Array.from({ length: Number(count) }, (_, index) =>
    registry.save(
      {
        name: `${prefix}-${String(index)}`,
        userId: `user_${prefix}${String(index)}`,
        organizationId: null,
        organizationName: null,
      },
      { accessToken: "access", refreshToken: "refresh", expiresAt: "2099-01-01T00:00:00.000Z" },
    ),
  ),
);
