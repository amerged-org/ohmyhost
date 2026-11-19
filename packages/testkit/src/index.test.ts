import { expect, it } from "vitest";

import {
  createConfigFrameworkAdapter,
  FakeProviderConflictError,
  FakeProviderFailureError,
  FakeProviderStore,
  FakeProviderTimeoutError,
  FakeStaticHostingProvider,
} from "./index.js";

it("exports the complete minimal testkit API", () => {
  expect(createConfigFrameworkAdapter).toBeTypeOf("function");
  expect(FakeProviderStore).toBeTypeOf("function");
  expect(FakeStaticHostingProvider).toBeTypeOf("function");
  expect(new FakeProviderConflictError().name).toBe("FakeProviderConflictError");
  expect(new FakeProviderFailureError().name).toBe("FakeProviderFailureError");
  expect(new FakeProviderTimeoutError().name).toBe("FakeProviderTimeoutError");
});
