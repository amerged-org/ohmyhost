import type { ObservedExperimentVersions } from "./experiments.js";
import type { SegmentFilter } from "./segments.js";
import type { Dashboard, TimelinePage } from "./metrics.js";
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
const show = (v: string | null | undefined) => escapeHtml(v ?? "Unknown");
export function renderOperatorPage(
  environment: string,
  dashboard: Dashboard & ObservedExperimentVersions,
  timeline?: TimelinePage,
  csrf?: string,
  timelineBase?: string,
  accounts?: {
    accounts: { subject: string; firstSeen: string; lastSeen: string }[];
    nextCursor: string | null;
  },
  canReadIdentity = false,
  attribution?: {
    observed_at: string;
    r: string | null;
    utm: Record<string, string> | null;
    utm_observed_at?: string | null;
  } | null,
  segment: SegmentFilter = "all",
  canManageSegments = false,
  canManageExperiments = false,
): string {
  const segmentForm =
    csrf && canManageSegments
      ? `<section><h2>Set segment</h2><p>Account and organization tags are separate. Existing tags are changed only by an authorized operator.</p><form method="post" action="/growth"><input type="hidden" name="csrf" value="${show(csrf)}"><input type="hidden" name="action" value="segment"><label>Entity <select name="entity_type">${canReadIdentity ? '<option value="account">Account</option>' : ""}<option value="organization">Organization</option></select></label><label>Canonical ID <input name="entity_id" required maxlength="200"></label><label>Segment <select name="segment"><option value="test">Test</option><option value="non_test">Non-test</option><option value="unknown">Unknown</option></select></label><button>Save segment</button></form></section>`
      : "";
  const cohorts = dashboard.cohorts
    .map(
      (c) =>
        `<tr><th>${show(c.label)}</th><td>${c.numerator} / ${c.denominator}</td><td>${c.mature}</td><td>${c.pending}</td><td>${show(c.anchor)}</td><td>${show(c.segment)}</td><td>${c.unknown}</td><td>${show(c.watermark)}</td></tr>`,
    )
    .join("");
  const rollups = (dashboard.accountRollups ?? [])
    .map(
      (r) =>
        `<tr><td>${show(r.cohortDay)}</td><td>${r.windowDays === 1 ? "24 hours" : "7 days"}</td><td>${r.positive} / ${r.mature}</td><td>${r.unknown}</td><td>${r.incomplete ? "Incomplete / unknown" : "Complete"}</td><td>${show(r.refreshedAt)}</td></tr>`,
    )
    .join("");
  const sources = dashboard.sources
    .map(
      (s) =>
        `<li><strong>${show(s.source)}</strong>: ${show(s.status)} · watermark ${show(s.watermark)} · history floor ${show(s.historyFloor)} · last attempt ${show(s.lastAttempt)} · last successful scan ${show(s.lastSuccess)} · completed ${show(s.completedScan)} · quality ${s.qualityFlags?.map(show).join(", ") || "Unknown"}</li>`,
    )
    .join("");
  const events =
    timeline?.items
      .map(
        (e) =>
          `<tr><td>${show(e.at)}</td><td>${show(e.stage)}</td><td>${show(e.error)}</td><td>${show(e.actor)}</td><td>${show(e.client)} / ${show(e.transport)} (${show(e.clientTrust)}) · country ${show(e.country)}</td><td>${show(e.campaign)}</td><td>${show(e.environment)} / ${show(e.kind)} / ${show(e.health)}</td></tr>`,
      )
      .join("") ?? "";
  const returns =
    dashboard.returns
      ?.map(
        (r) =>
          `<li>D${r.days}: ${r.numerator} / ${r.denominator} mature, ${r.pending} pending; history ${r.historyComplete ? "complete" : "incomplete"}</li>`,
      )
      .join("") ?? "";
  const money =
    dashboard.money
      ?.map(
        (m) =>
          `<li>${show(m.currency)} minor units: gross ${m.gross}, refunds ${m.refunds}, withdrawn ${m.withdrawn}, restored ${m.restored}, net ${m.net}, open disputes ${m.openDisputes}</li>`,
      )
      .join("") ?? "";
  const experiments =
    dashboard.experiments
      ?.map(
        (e) =>
          `<li><strong>${show(e.hypothesis)}</strong> · ${show(e.evidence)} · ${show(e.segment)} · ${show(e.metric)} · guardrails ${e.guardrails.map(show).join(", ")} · reference ${show(e.evidenceReference)} · versions ${e.versions.map(show).join(", ") || "Unknown"} · horizon ${show(e.horizon)} · ${e.conclusion === "pending / unconfigured" ? "pending / unconfigured" : `${e.sampleSize} exposed · ${e.mature ? "mature" : "pending"}`} · ${show(e.comparison)} · ${show(e.conclusion)} · ${e.limitations.map(show).join("; ")}</li>`,
      )
      .join("") ?? "";
  const form =
    csrf && canManageExperiments
      ? `<form method="post" action="/growth"><input type="hidden" name="csrf" value="${show(csrf)}"><input type="hidden" name="action" value="register"><label>Hypothesis <input name="hypothesis" required maxlength="500"></label><label>Evidence basis <select name="evidence_basis"><option value="hypothesis">Hypothesis</option><option value="observed_technical">Observed technical</option><option value="user_reported">User reported</option></select></label><label>Evidence reference (optional) <input name="evidence_reference" maxlength="500"></label><label>Segment <select name="segment"><option value="all">All accounts</option><option value="new_accounts_7d">New accounts within 7 days</option></select></label><label>Primary metric <select name="primary_metric"><option value="workspace_ready_7d">Workspace ready within 7 days</option><option value="healthy_deployment_7d">Healthy deployment within 7 days</option></select></label><label>Guardrails (comma separated) <input name="guardrails" required maxlength="500"></label><label>Baseline version <input name="baseline_version" required maxlength="500"></label><label>Variant version <input name="variant_version" required maxlength="500"></label><label>Exposure window start (UTC) <input name="horizon_start" type="datetime-local" required></label><label>Exposure window end (UTC) <input name="horizon_end" type="datetime-local" required></label><p>Surface: authorized product response; descriptive before / after.</p><button>Register experiment</button></form>`
      : "";
  const accountRows =
    accounts?.accounts
      .map(
        (a) =>
          `<li><a href="/growth/timeline?subject=${encodeURIComponent(a.subject)}&amp;scope=account">${show(a.subject)}</a> · first observed ${show(a.firstSeen)} · last observed ${show(a.lastSeen)}</li>`,
      )
      .join("") ?? "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Growth operator</title><style>body{font:16px system-ui;margin:0;background:#f5f4f0;color:#17212a}main{max-width:1200px;margin:auto;padding:2rem}nav a{margin-right:1rem}section{background:white;padding:1.25rem;margin:1rem 0;border-radius:10px;overflow:auto}table{border-collapse:collapse;width:100%;min-width:700px}th,td{text-align:left;padding:.6rem;border-bottom:1px solid #ddd}small{color:#555}</style></head><body><main><h1>Growth operator</h1><p>Environment: ${show(environment)}</p><nav><a href="/growth">Overview</a><a href="/growth/cohorts">Cohorts</a>${canReadIdentity ? '<a href="/growth?accounts=1">Accounts</a><a href="/growth/calls">Calls</a>' : ""}</nav>${accounts ? `<section><h2>Accounts</h2><p>Pseudonymous observed accounts; first/last observation are not necessarily creation or activity.</p><ul>${accountRows || "<li>No retained observations.</li>"}</ul>${accounts.nextCursor ? `<a href="/growth?accounts=1&amp;cursor=${show(accounts.nextCursor)}">Next account page</a>` : ""}</section>` : ""}<section><h2>Cohorts</h2><form method="get" action="/growth/cohorts"><label>Report segment <select name="segment">${(["all", "test", "non_test", "unknown"] as const).map((x) => `<option value="${x}"${segment === x ? " selected" : ""}>${x}</option>`).join("")}</select></label><button>Filter</button></form><p>Account cohorts use account tags; return and payments use organization tags. All includes test and unknown.</p><p>Pending cohorts have not completed their observation window. Unknown data is not zero.</p><table><thead><tr><th>Cohort</th><th>Observed / mature</th><th>Mature</th><th>Pending</th><th>Anchor</th><th>Segment</th><th>Unknown</th><th>Watermark</th></tr></thead><tbody>${cohorts || '<tr><td colspan="8">Pending: no cohort observations available.</td></tr>'}</tbody></table></section><section><h2>Daily account cohorts</h2><p>Global all-account cohorts only, retained up to 13 calendar months. Days with fewer than five accounts or an immature window are suppressed. Historical source coverage is unknown; missing days do not mean zero.</p>${segment === "all" ? `<table><thead><tr><th>UTC creation day</th><th>Window</th><th>Observed / mature</th><th>Unknown</th><th>Coverage</th><th>Refreshed</th></tr></thead><tbody>${rollups || '<tr><td colspan="6">No eligible retained cohorts.</td></tr>'}</tbody></table>` : "<p>Daily global cohorts are available with the all segment.</p>"}</section>${segmentForm}<section><h2>Source health</h2><ul>${sources || "<li>Unavailable: no source health reported.</li>"}</ul></section>${timeline ? `<section><h2>Timeline</h2>${canReadIdentity && timelineBase ? `<p><a href="${show(timelineBase)}&amp;identity=1">Reveal identity</a> · <a href="${show(timelineBase)}&amp;attribution=1">Reveal current attribution snapshot</a></p>` : ""}${attribution === null ? "<p>Attribution unavailable.</p>" : attribution ? `<p>Current snapshot observed ${show(attribution.observed_at)}; first acquisition is unknown. Reference: ${show(attribution.r)}; campaign metadata: ${show(JSON.stringify(attribution.utm))}</p>` : ""}<p>Next missing observed stage: ${show(timeline.nextMissingStage)} · Last actual activity: ${show(timeline.lastActivity)} · Elapsed: ${show(timeline.elapsed)}</p><table><thead><tr><th>Time</th><th>Stage</th><th>Error</th><th>Actor</th><th>Client / transport / trust / approximate request country</th><th>Campaign</th><th>Environment / kind / health</th></tr></thead><tbody>${events}</tbody></table>${timeline.nextCursor && timelineBase ? `<p><a href="${show(timelineBase)}&amp;cursor=${show(timeline.nextCursor)}">Next timeline page</a></p>` : ""}</section>` : ""}<section><h2>Observed technical errors</h2><ul>${dashboard.errors?.map((e) => `<li>${show(e.error)}: ${e.count}</li>`).join("") || "<li>No errors observed in retained events; coverage may be incomplete.</li>"}</ul></section><section><h2>Return and payments</h2><p>180-day measurement limit; amounts are confirmed minor currency units, not lifetime LTV.</p><ul>${returns || "<li>Return evidence unavailable.</li>"}${money || "<li>Confirmed money evidence unavailable.</li>"}</ul></section><section><h2>Experiments</h2><p>Observed authorized response versions (up to 20 from retained events): ${dashboard.observedResponseVersions?.map(show).join(", ") || "None observed"}. Coverage may be incomplete.</p><ul>${experiments || "<li>Pending: no registered experiments.</li>"}</ul>${dashboard.nextCursor ? `<p><a href="/growth/cohorts?cursor=${show(dashboard.nextCursor)}">Next experiment page</a></p>` : ""}${form}</section><section><h2>Coverage and limitations</h2><ul>${dashboard.limitations?.map((x) => `<li>${show(x)}</li>`).join("") || "<li>Coverage unknown.</li>"}</ul></section><small>Detailed growth history is bounded; unavailable sources and unknown actors remain explicit.</small></main></body></html>`;
}

/** Private call inspection; all values are escaped and records never contain payloads. */
export function renderCallsPage(
  environment: string,
  day: string,
  accountId: string | null,
  page: import("./usage-reader.js").UsageCallsPage,
): string {
  const next = page.nextCursor
    ? new URLSearchParams({
        day,
        ...(accountId ? { account_id: accountId } : {}),
        cursor: page.nextCursor,
      }).toString()
    : null;
  const rows = page.rows
    .map(
      (r) =>
        `<tr><td>${show(r.occurred_at)}</td><td>${show(r.transport)} / ${show(r.operation)}</td><td>${show(r.result)}${r.http_status === null ? "" : ` · HTTP ${r.http_status}`} · ${show(r.error_code)}</td><td>${r.duration_ms === null ? "Unknown" : `${r.duration_ms} ms`}</td><td>${show(r.account_id)} / ${show(r.organization_id)} / ${show(r.project_id)}</td><td>${show(r.invocation_id)} / ${show(r.parent_invocation_id)}</td><td>${show(r.operation_id)} / ${show(r.operation_status)}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Calls</title><style>body{font:16px system-ui;margin:2rem;color:#17212a}section{overflow:auto}table{border-collapse:collapse;min-width:1100px}th,td{text-align:left;padding:.6rem;border-bottom:1px solid #ddd}</style></head><body><main><h1>Calls</h1><p>Environment: ${show(environment)} · <a href="/growth">Growth overview</a></p><form method="get" action="/growth/calls"><label>UTC receipt day <input type="date" name="day" value="${show(day)}" required></label> <label>Account ID <input name="account_id" maxlength="128" value="${accountId ? show(accountId) : ""}"></label> <button>Filter</button></form><p>${page.partial ? "Partial: a read limit or unavailable archive prevents a complete view." : "Bounded view of available records."} Up to 200 observations folded into calls on this page. Ordering is by occurrence time within this page; follow More observations to inspect the remaining buffer and archive shards. A missing finish is unobserved, including calls spanning days. Accepted describes the call response; job status is separate. Local stdio tools are not observed; their server REST calls may appear.</p><section><table><thead><tr><th>Time UTC</th><th>Transport / operation</th><th>Result / HTTP / error</th><th>Duration</th><th>Account / workspace / project</th><th>Invocation / parent</th><th>Operation / job status</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No calls observed in this bounded view.</td></tr>'}</tbody></table></section>${next ? `<p><a href="/growth/calls?${show(next)}">More observations / retry partial read</a></p>` : ""}</main></body></html>`;
}
