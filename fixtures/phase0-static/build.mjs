import { cp, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await cp("source/index.html", "dist/index.html");
