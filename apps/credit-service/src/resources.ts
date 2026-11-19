import { organizationLines, ratesToCards, type Charge } from "./pricing.js";
import type { Dependencies } from "./port.js";
import { isoOf } from "./time.js";
import { allPages, count, postOrganizations, type SourceReport } from "./source.js";
import { runDays } from "./daily.js";

export const SCRIPT_METER = "wfp.script";
export const HOSTNAME_METER = "domain.custom_hostname";
/** The resources card prices a script or hostname per second of a 744 hour month; one day is 86 400 seconds. */
const DAY_SECONDS = 86_400n;
const PAGE = 500;

async function billDay(deps: Dependencies, report: SourceReport, day: number): Promise<void> {
  const at = isoOf(day);
  const rows = await allPages(async (after) => {
    const page = await deps.core.readResources({ day: at, after, limit: PAGE });
    return { items: page.rows, next: page.next };
  });
  const charges: Charge[] = [];
  for (const row of rows) {
    const scope = {
      organizationId: row.organizationId,
      projectId: row.projectId,
      environmentId: row.environmentId,
    };
    charges.push(
      {
        ...scope,
        meter: SCRIPT_METER,
        unit: "script_second",
        quantity: BigInt(row.scripts) * DAY_SECONDS,
      },
      {
        ...scope,
        meter: HOSTNAME_METER,
        unit: "hostname_second",
        quantity: BigInt(row.hostnames) * DAY_SECONDS,
      },
    );
  }
  count(report, "resource_rows", rows.length);
  if (charges.length === 0) return;
  const cards = ratesToCards(await deps.core.readRates({ at }), at);
  const { byOrganization, unpriced } = organizationLines(charges, cards, at);
  for (const meter of unpriced) count(report, `unpriced:${meter}`);
  await postOrganizations(deps, report, at, byOrganization);
}

/** Active WFP scripts and custom hostnames of the finished UTC days, times the daily price. */
export const runResources = (deps: Dependencies): Promise<SourceReport> =>
  runDays(deps, "resources", 0, (day, report) => billDay(deps, report, day));
