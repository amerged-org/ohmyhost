import { defineConfig } from "@hey-api/openapi-ts";

export const createSdkConfig = (
  outputPath: string,
  inputPath = "packages/contracts/generated/openapi.json",
) =>
  defineConfig({
    input: inputPath,
    output: {
      path: outputPath,
      clean: true,
      module: {
        extension: ".js",
      },
    },
    plugins: [
      "@hey-api/typescript",
      {
        name: "@hey-api/client-fetch",
        baseUrl: false,
        throwOnError: true,
      },
      {
        name: "@hey-api/sdk",
        client: true,
        paramsStructure: "flat",
        responseStyle: "data",
      },
    ],
  });

export default createSdkConfig("packages/sdk-ts/src/generated");
