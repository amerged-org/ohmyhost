import type { CreateProductCliTestHarness } from "./contract.js";

interface HarnessModule {
  readonly createProductCliTestHarness?: CreateProductCliTestHarness;
}

export async function loadProductCliHarness(): Promise<CreateProductCliTestHarness> {
  const harnessModulePath: string = "./harness.js";
  let module: HarnessModule;

  try {
    module = (await import(harnessModulePath)) as HarnessModule;
  } catch (error) {
    throw new Error(
      "PRODUCT_CLI_RED: add apps/product-cli/test/harness.ts exporting createProductCliTestHarness backed by the real Device Flow adapter, credential store, and generated SDK client",
      { cause: error },
    );
  }

  if (typeof module.createProductCliTestHarness !== "function") {
    throw new TypeError(
      "PRODUCT_CLI_RED: apps/product-cli/test/harness.ts must export createProductCliTestHarness",
    );
  }

  return module.createProductCliTestHarness;
}
