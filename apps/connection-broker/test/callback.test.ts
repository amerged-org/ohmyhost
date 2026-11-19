import { expect, test } from "vitest";
import { parseCallback, parseAttemptCookie } from "../src/callback.js";

test("callback rejects ambiguous protocol input before claim or exchange", () => {
  const parse = (query: string) =>
    parseCallback(
      new URL(`https://connect.ohmyho.st/oauth/callback?${query}`),
      "https://www.make.com",
      "single-issuer",
    );
  expect(parse("state=abc&code=def")).toEqual({ state: "abc", code: "def" });
  expect(parse("state=abc&error=access_denied")).toEqual({ state: "abc", error: "access_denied" });
  for (const query of [
    "code=x",
    "state=x&state=y&code=z",
    "state=x&code=y&error=z",
    "state=x&code=y&iss=https%3A%2F%2Fevil.example",
    `state=${"x".repeat(513)}&code=y`,
    "state=x&code=y&iss=x&iss=x",
  ])
    expect(() => parse(query)).toThrow("invalid_callback");
  expect(() =>
    parseCallback(
      new URL("https://connect.ohmyho.st/oauth/callback?state=x&code=y"),
      "https://www.make.com",
      "rfc9207",
    ),
  ).toThrow("invalid_callback");
  expect(parseAttemptCookie("other=foo; __Host-omh-connect=abc")).toBe("abc");
  expect(parseAttemptCookie("__Host-omh-connect=a; __Host-omh-connect=b")).toBeNull();
});
