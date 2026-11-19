import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";

// A new, private file per run. Never truncate a prior attempt or follow a symlink.
export async function createJournal(path) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const handle = await open(path, flags, 0o600);
  return {
    async append(event) {
      await handle.writeFile(`${JSON.stringify(event)}\n`);
      await handle.sync();
    },
    async close() {
      await handle.close();
    },
  };
}

// An incomplete final write is evidence of an interrupted run, not a line to discard.
export async function readJournal(path) {
  const raw = await readFile(path, "utf8");
  if (!raw.endsWith("\n")) throw new Error("journal_incomplete_write");
  try {
    return raw.slice(0, -1).split("\n").map(JSON.parse);
  } catch {
    throw new Error("journal_invalid");
  }
}

/** Recover completed lines while exposing a torn tail as an integrity failure. */
export async function recoverJournal(path) {
  const raw = await readFile(path, "utf8");
  const incompleteTail = !raw.endsWith("\n");
  const complete = incompleteTail ? raw.slice(0, raw.lastIndexOf("\n") + 1) : raw;
  try {
    return {
      events: complete ? complete.slice(0, -1).split("\n").map(JSON.parse) : [],
      incompleteTail,
    };
  } catch {
    throw new Error("journal_invalid");
  }
}
