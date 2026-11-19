import { expect, test } from "vitest";
import {
  sealGrantTokens,
  openGrantTokens,
  sealAttemptSecrets,
  openAttemptSecrets,
} from "../src/grant-vault.js";

test("authenticated ciphertext cannot be substituted across identities or purposes", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const identity = {
    environment: "development",
    workspace: "w",
    human: "h",
    provider: "make",
    registration: "r",
    grantId: "g",
    generation: 1,
    keyVersion: "v1",
  };
  const cipher = await sealGrantTokens(
    identity,
    { accessToken: "access", refreshToken: "refresh" },
    key,
  );
  expect(await openGrantTokens(identity, cipher, key)).toEqual({
    accessToken: "access",
    refreshToken: "refresh",
  });
  for (const [name, value] of Object.entries(identity)) {
    await expect(
      openGrantTokens(
        { ...identity, [name]: typeof value === "number" ? value + 1 : `${value}x` },
        cipher,
        key,
      ),
    ).rejects.toThrow();
  }
  const attempt = {
    environment: "development",
    workspace: "w",
    actor: "h",
    attemptId: "a",
    registration: "r",
    expiresAt: "2026-11-09T12:00:00Z",
    keyVersion: "v1",
  };
  const sealed = await sealAttemptSecrets(attempt, { verifier: "v".repeat(43) }, key);
  expect(await openAttemptSecrets(attempt, sealed, key)).toEqual({ verifier: "v".repeat(43) });
  for (const [name, value] of Object.entries(attempt)) {
    await expect(
      openAttemptSecrets({ ...attempt, [name]: `${value}x` }, sealed, key),
    ).rejects.toThrow();
  }
  await expect(openAttemptSecrets(attempt, cipher, key)).rejects.toThrow();
  const largeTokens = { accessToken: "x".repeat(6000), refreshToken: "r".repeat(6000) };
  const largeCipher = await sealGrantTokens(identity, largeTokens, key);
  expect(await openGrantTokens(identity, largeCipher, key)).toEqual(largeTokens);
  const preservedUnicode = { accessToken: "€".repeat(16_384), refreshToken: "€".repeat(16_384) };
  expect(
    await openGrantTokens(identity, await sealGrantTokens(identity, preservedUnicode, key), key),
  ).toEqual(preservedUnicode);
  for (const invalid of [undefined, "", "x".repeat(257)]) {
    await expect(
      sealGrantTokens(
        { ...identity, human: invalid as string },
        { accessToken: "a", refreshToken: "r" },
        key,
      ),
    ).rejects.toThrow();
  }
  for (const generation of [NaN, Infinity, -0, -1, 1.5]) {
    await expect(
      sealGrantTokens({ ...identity, generation }, { accessToken: "a", refreshToken: "r" }, key),
    ).rejects.toThrow();
  }
  await expect(
    sealAttemptSecrets({ ...attempt, expiresAt: "bad" }, { verifier: "v".repeat(43) }, key),
  ).rejects.toThrow();
});
