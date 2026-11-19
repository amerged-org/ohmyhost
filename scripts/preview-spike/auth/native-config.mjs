/* global structuredClone */
/** Temporary overlay only: write beside the source profile so its relative main resolves identically. */
export function buildQaNativeRuntimeConfig(base) {
  const fail = () => {
    throw new Error("qa_native_config_invalid");
  };
  if (
    !base ||
    typeof base !== "object" ||
    Array.isArray(base) ||
    base.name !== "ohmyho-native-auth-development-eu" ||
    base.account_id !== "00000000000000000000000000000001" ||
    base.main !== "src/worker-main.ts" ||
    base.workers_dev !== false ||
    base.preview_urls !== false ||
    !base.vars ||
    base.vars.NATIVE_AUTH_REGION_ID !== "eu-dev" ||
    Object.hasOwn(base.vars, "NATIVE_AUTH_QA_PREVIEW_ENABLED") ||
    !Array.isArray(base.services)
  )
    fail();
  const existing = (binding, service, entrypoint) =>
    base.services.filter(
      (item) =>
        item?.binding === binding && item.service === service && item.entrypoint === entrypoint,
    ).length === 1;
  if (
    !existing(
      "NATIVE_AUTH_AUTHORITY",
      "ohmyho-control-store-poc-private-fullstack",
      "NativeAuthRuntime",
    ) ||
    !existing(
      "NATIVE_AUTH_MAIL",
      "ohmyho-mail-gateway-poc-private-fullstack",
      "NativeAuthMailService",
    ) ||
    base.services.some((item) =>
      ["NATIVE_AUTH_PREVIEW_AUTHORITY", "NATIVE_AUTH_PREVIEW_MAIL"].includes(item?.binding),
    )
  )
    fail();
  const result = structuredClone(base);
  result.vars.NATIVE_AUTH_QA_PREVIEW_ENABLED = "development-only-v1";
  result.services.push(
    {
      binding: "NATIVE_AUTH_PREVIEW_AUTHORITY",
      service: "ohmyho-preview-spike-auth-development",
      entrypoint: "QaStablePreviewAuthority",
    },
    {
      binding: "NATIVE_AUTH_PREVIEW_MAIL",
      service: "ohmyho-mail-gateway-poc-private-fullstack",
      entrypoint: "NativePreviewAuthMailService",
    },
  );
  return result;
}
