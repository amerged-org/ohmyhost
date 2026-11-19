/* global structuredClone */
/** Temporary overlay only: place beside the canonical profile for identical relative paths. */
export function buildQaMailGatewayConfig(base) {
  const fail = () => {
    throw new Error("qa_mail_config_invalid");
  };
  if (
    !base ||
    typeof base !== "object" ||
    Array.isArray(base) ||
    base.name !== "ohmyho-mail-gateway-poc-private-fullstack" ||
    base.account_id !== "00000000000000000000000000000001" ||
    base.main !== "src/resend-worker.ts" ||
    base.workers_dev !== false ||
    base.preview_urls !== false ||
    !base.vars ||
    typeof base.vars !== "object" ||
    Array.isArray(base.vars) ||
    base.vars.RUNTIME_CONFIGURATION_STATE !== "configured" ||
    base.vars.PLATFORM_ENVIRONMENT !== "development" ||
    Object.hasOwn(base.vars, "QA_NATIVE_PREVIEW_MAIL_ENABLED") ||
    Object.hasOwn(base.vars, "QA_NATIVE_PREVIEW_MAIL_SCOPE") ||
    !Array.isArray(base.services) ||
    !Array.isArray(base.triggers?.crons) ||
    !base.triggers.crons.includes("* * * * *")
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
      "NATIVE_AUTH_MAIL_AUTHORITY",
      "ohmyho-control-store-poc-private-fullstack",
      "NativeAuthMailRuntime",
    ) ||
    !existing(
      "MAIL_SEND_RUNTIME",
      "ohmyho-control-store-poc-private-fullstack",
      "MailSendRuntime",
    ) ||
    base.services.some((item) => item?.binding === "QA_STABLE_PREVIEW_AUTHORITY")
  )
    fail();
  const result = structuredClone(base);
  result.vars.QA_NATIVE_PREVIEW_MAIL_ENABLED = "development-only-v1";
  result.services.push({
    binding: "QA_STABLE_PREVIEW_AUTHORITY",
    service: "ohmyho-preview-spike-auth-development",
    entrypoint: "QaStablePreviewAuthority",
  });
  return result;
}
