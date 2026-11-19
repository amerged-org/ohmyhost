import { writeFile } from "node:fs/promises";
import { argv } from "node:process";
import { URL } from "node:url";

await writeFile(new URL("SHOULD_NOT_EXIST", import.meta.url), argv[2] ?? "marker", "utf8");
