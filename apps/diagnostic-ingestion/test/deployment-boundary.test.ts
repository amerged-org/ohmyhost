import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("diagnostic ingestion production boundary", () => {
  it("declares both deployable entrypoints and their exact bundle metafiles", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as {
      ohmyhost?: {
        deployment?: string;
        fakeProviderBoundary?: {
          typescriptProject?: string;
          artifactRoot?: string;
          entrypoints?: string[];
          bundles?: Array<{ entrypoint: string; metafile: string }>;
        };
      };
    };
    expect(manifest.ohmyhost).toEqual({
      deployment: "production",
      fakeProviderBoundary: {
        typescriptProject: "tsconfig.build.json",
        artifactRoot: "dist",
        entrypoints: ["src/tail-main.ts", "src/consumer-main.ts"],
        bundles: [
          { entrypoint: "src/tail-main.ts", metafile: "dist/tail/metafile.json" },
          { entrypoint: "src/consumer-main.ts", metafile: "dist/consumer/metafile.json" },
        ],
      },
    });
    const typescript = JSON.parse(
      await readFile(resolve(import.meta.dirname, "../tsconfig.build.json"), "utf8"),
    ) as { compilerOptions?: { noEmit?: boolean; outDir?: string; rootDir?: string } };
    expect(typescript.compilerOptions).toMatchObject({
      noEmit: false,
      outDir: "dist",
      rootDir: "src",
    });
  });
});
