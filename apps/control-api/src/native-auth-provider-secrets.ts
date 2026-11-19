import { z } from "zod";
import type { createEnvironmentSecretCipherKeyring } from "./environment-secret-cipher.js";

const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
const requestSchema = z.strictObject({
  organizationId: id,
  projectId: id,
  environmentId: id,
  deploymentId: id,
  provider: z.enum(["google", "github"]),
  configurationRevision: z.number().int().positive().safe(),
});
const authoritySchema = z.object({
  organizationId: id,
  deploymentId: id,
  revocationEpoch: z.number().int().nonnegative().safe(),
  enabled: z.boolean(),
  sourceCapable: z.boolean(),
  paidAllowed: z.boolean(),
  runtimeAllowed: z.boolean(),
  storageReady: z.boolean(),
  realm: z.object({
    projectId: id,
    environmentId: id,
    canonicalOrigin: z.string().url(),
    realmGeneration: z.number().int().nonnegative().safe(),
    configurationRevision: z.number().int().positive().safe(),
  }),
});
const envelopeSchema = z.strictObject({
  clientId: z.string().min(1).max(1024),
  ciphertext: z.instanceof(Uint8Array).refine((v) => v.byteLength >= 17 && v.byteLength <= 65552),
  nonce: z.instanceof(Uint8Array).refine((v) => v.byteLength === 12),
  valueSha256: z.instanceof(Uint8Array).refine((v) => v.byteLength === 32),
  keyVersion: z.number().int().positive(),
});
function sameBytes(left: Uint8Array, right: Uint8Array) {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

/** Private Native runtime boundary. Never log input, output, ciphertext or decrypted credentials. */
export function createNativeAuthProviderSecretResolver(input: {
  readonly authority: {
    resolve(input: unknown): Promise<unknown>;
    readNativeAuthProviderEnvelope(input: unknown): Promise<unknown>;
  };
  readonly cipher: ReturnType<typeof createEnvironmentSecretCipherKeyring>;
}) {
  return async (
    raw: unknown,
  ): Promise<{ clientId: string; clientSecret: string; configurationRevision: number }> => {
    try {
      const request = requestSchema.parse(raw);
      const authorityInput = {
        projectId: request.projectId,
        environmentId: request.environmentId,
        deploymentId: request.deploymentId,
      };
      const envelopeInput = {
        organizationId: request.organizationId,
        projectId: request.projectId,
        environmentId: request.environmentId,
        provider: request.provider,
        configurationRevision: request.configurationRevision,
      };
      const before = authoritySchema.parse(await input.authority.resolve(authorityInput));
      const origin = new URL(before.realm.canonicalOrigin);
      if (origin.protocol !== "https:" || origin.origin !== before.realm.canonicalOrigin)
        throw new Error("native_auth_unavailable");
      if (
        before.organizationId !== request.organizationId ||
        before.deploymentId !== request.deploymentId ||
        before.realm.projectId !== request.projectId ||
        before.realm.environmentId !== request.environmentId ||
        before.realm.configurationRevision !== request.configurationRevision ||
        before.realm.realmGeneration !== before.revocationEpoch ||
        !before.enabled ||
        !before.sourceCapable ||
        !before.paidAllowed ||
        !before.runtimeAllowed ||
        !before.storageReady
      )
        throw new Error("native_auth_unavailable");
      const envelope = envelopeSchema.parse(
        await input.authority.readNativeAuthProviderEnvelope(envelopeInput),
      );
      const clientSecret = await input.cipher.decrypt({
        ...envelopeInput,
        name: `NATIVE_AUTH_${request.provider.toUpperCase()}_CLIENT_SECRET`,
        ...envelope,
      });
      const [afterRaw, currentRaw] = await Promise.all([
        input.authority.resolve(authorityInput),
        input.authority.readNativeAuthProviderEnvelope(envelopeInput),
      ]);
      const after = authoritySchema.parse(afterRaw),
        current = envelopeSchema.parse(currentRaw);
      if (
        JSON.stringify(after) !== JSON.stringify(before) ||
        envelope.clientId !== current.clientId ||
        envelope.keyVersion !== current.keyVersion ||
        !sameBytes(envelope.ciphertext, current.ciphertext) ||
        !sameBytes(envelope.nonce, current.nonce) ||
        !sameBytes(envelope.valueSha256, current.valueSha256)
      )
        throw new Error("native_auth_unavailable");
      return {
        clientId: envelope.clientId,
        clientSecret,
        configurationRevision: request.configurationRevision,
      };
    } catch {
      throw new Error("native_auth_unavailable");
    }
  };
}
