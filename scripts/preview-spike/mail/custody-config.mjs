/* global structuredClone */
/** Temporary overlay only: place beside the canonical profile for identical relative paths. */
export function buildQaMailCustodyConfig(base) {
  const fail = () => {
    throw new Error("qa_mail_custody_config_invalid");
  };
  if (
    !base ||
    typeof base !== "object" ||
    Array.isArray(base) ||
    base.name !== "ohmyho-runtime-secret-delivery-poc-private-fullstack" ||
    base.account_id !== "00000000000000000000000000000001" ||
    base.main !== "src/worker-main.ts" ||
    base.workers_dev !== false ||
    base.preview_urls !== false ||
    !base.vars ||
    typeof base.vars !== "object" ||
    Array.isArray(base.vars) ||
    base.vars.RUNTIME_CONFIGURATION_STATE !== "configured" ||
    Object.hasOwn(base.vars, "RUNTIME_QA_PREVIEW_MAIL_ENABLED") ||
    !Array.isArray(base.services) ||
    !Array.isArray(base.triggers?.crons) ||
    !base.triggers.crons.includes("*/1 * * * *") ||
    !Array.isArray(base.secrets?.required) ||
    !base.secrets.required.includes("ENVIRONMENT_SECRET_KEY_BASE64") ||
    !base.secrets.required.includes("ENVIRONMENT_SECRET_ADDITIONAL_KEYS_JSON")
  )
    fail();
  const existing = (binding, service, entrypoint) => {
    const matches = base.services.filter((item) => item?.binding === binding);
    return (
      matches.length === 1 && matches[0].service === service && matches[0].entrypoint === entrypoint
    );
  };
  if (
    !existing(
      "RUNTIME_SECRET_RUNTIME",
      "ohmyho-control-store-poc-private-fullstack",
      "RuntimeSecretDeliveryRuntime",
    ) ||
    !existing(
      "WFP_MANAGEMENT",
      "ohmyho-wfp-management-poc-private-fullstack",
      "WfpManagementService",
    ) ||
    base.services.some((item) => item?.binding === "QA_MAIL_KEY_AUTHORITY")
  )
    fail();
  const result = structuredClone(base);
  result.vars.RUNTIME_QA_PREVIEW_MAIL_ENABLED = "development-only-v1";
  result.services.push({
    binding: "QA_MAIL_KEY_AUTHORITY",
    service: "ohmyho-control-store-poc-private-fullstack",
    entrypoint: "QaPreviewMailKeyAuthority",
  });
  return result;
}
