import { expect, it } from "vitest";
import { normalizeProjectNotes } from "./notes.js";
it("keeps bounded ordinary Markdown while refusing credentials and signed capabilities", () => {
  expect(normalizeProjectNotes("Fix login\r\nSee https://example.com/docs?q=mail")).toBe(
    "Fix login\nSee https://example.com/docs?q=mail",
  );
  expect(normalizeProjectNotes("a".repeat(16384))).toHaveLength(16384);
  expect(normalizeProjectNotes(Array(250).fill("todo").join("\n")).split("\n")).toHaveLength(250);
  for (const input of [
    null,
    "😀".repeat(4097),
    Array(251).fill("todo").join("\n"),
    "bad\u0000text",
    "TOKEN=abcdefghijklmnop",
    "Bearer abcdefghijklmnopqrstuvwxyz",
    "-----BEGIN PRIVATE KEY-----",
    "https://user:password@example.com",
    "postgresql://owner:password@db.example.com/database",
    "https://example.com/export?X-Amz-Signature=secret",
  ])
    expect(() => normalizeProjectNotes(input)).toThrow();
  expect(normalizeProjectNotes("Remember to configure DATABASE_URL.")).toContain("DATABASE_URL");
});
