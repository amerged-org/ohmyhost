import { PORTAL_SCRIPT, PORTAL_SCRIPT_HASH } from "./generated-portal-assets.js";
import { copyButton, renderStandalonePage } from "./standalone-page.js";

export function renderMakeConnectedPage(development: boolean, head = false): Response {
  return renderStandalonePage({
    providerIcon: "make",
    title: "Make connected",
    message:
      "Your Make account is connected. Continue in your agent to choose a SaaS tool for your app.",
    status: 200,
    head,
    development,
    referrerPolicy: "no-referrer",
    script: { source: PORTAL_SCRIPT, hash: PORTAL_SCRIPT_HASH },
    body: `<div class="portal-prompt"><textarea id="make-agent-prompt" readonly aria-label="Starter prompt">Help me connect a SaaS tool to my application using Make. Ask me which tool I want to use, then find its connection.</textarea>${copyButton("make-agent-prompt", "Copy prompt", true)}</div>`,
  });
}
