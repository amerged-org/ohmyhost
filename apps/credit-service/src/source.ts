import type { Dependencies, UsageLine, UsagePosting, UsageSource } from "./port.js";

/** What one pass over one usage source did; `problems` lists what an operator must look at. */
export interface SourceReport {
  readonly source: UsageSource;
  status: "advanced" | "idle" | "waiting" | "skipped";
  /** Windows (hours or days) fully billed in this pass. */
  windows: number;
  /** Organization postings the Core accepted, and postings it recognized as already booked. */
  posted: number;
  duplicates: number;
  readonly counters: Record<string, number>;
  readonly problems: string[];
}

export const newReport = (source: UsageSource): SourceReport => ({
  source,
  status: "idle",
  windows: 0,
  posted: 0,
  duplicates: 0,
  counters: {},
  problems: [],
});

export const count = (report: SourceReport, name: string, by = 1): void => {
  report.counters[name] = (report.counters[name] ?? 0) + by;
};

export function chunks<Item>(items: readonly Item[], size: number): Item[][] {
  const result: Item[][] = [];
  for (let offset = 0; offset < items.length; offset += size)
    result.push(items.slice(offset, offset + size));
  return result;
}

/** All pages of a cursor-paginated Core read. */
export async function allPages<Item>(
  read: (after: string | null) => Promise<{ items: Item[]; next: string | null }>,
): Promise<Item[]> {
  const items: Item[] = [];
  let after: string | null = null;
  do {
    const page = await read(after);
    items.push(...page.items);
    after = page.next;
  } while (after !== null);
  return items;
}

/** The most lines the Core books in one posting (its input contract). */
export const POSTING_LINE_CAP = 2000;
/** The most lines in one part of a window that does not fit one posting. */
export const PART_LINES = 1000;
/** A window that does not fit one posting is split by environment into this many parts, then by size. */
const PART_BUCKETS = 32;
/** The highest part number the Core accepts. */
const MAX_PART = 255;
/**
 * A posting that fails holds the cursor of its window for this many failed passes (two an hour); then it is dead: kept
 * with its lines in the Core, the cursor moves on, and the replay of the next passes books it. A posting that cannot
 * succeed by repeating it, and any posting of an organization that already has a dead one, is dead at once.
 */
export const POST_ATTEMPTS = 4;
/** Kept postings replayed per pass at least; the Core replays more while many are due. */
export const REPLAY_LIMIT = 20;

type Layout = "whole" | "split";
type Posting = Omit<UsagePosting, "organizationId" | "source" | "window">;

/**
 * The part of a line: an FNV-1a hash of its environment (its project for a project-scoped resource), so that a line
 * stays in the same part whatever else the window holds when it is computed again.
 */
function bucketOf(line: UsageLine): number {
  const scope = line.environmentId ?? line.projectId;
  let hash = 0x811c9dc5;
  for (let index = 0; index < scope.length; index++)
    hash = Math.imul(hash ^ scope.charCodeAt(index), 0x01000193);
  return (hash >>> 0) % PART_BUCKETS;
}

/**
 * The parts of a window that is split. The split is by the hash of the environment, never by position: a window
 * computed again with other lines (an expired Logpush object, a late delivery) puts every line it has in common into the
 * same part, so a part that was booked is not booked again with moved lines. A part beyond `PART_LINES` is cut by
 * position into further parts (`bucket + 32 * round`).
 */
export function splitParts(
  lines: readonly UsageLine[],
): { part: number; split: true; lines: UsageLine[] }[] {
  const buckets = Array.from({ length: PART_BUCKETS }, (): UsageLine[] => []);
  for (const line of lines) (buckets[bucketOf(line)] as UsageLine[]).push(line);
  const parts: { part: number; split: true; lines: UsageLine[] }[] = [];
  buckets.forEach((bucket, index) =>
    chunks(bucket, PART_LINES).forEach((slice, round) => {
      const part = index + PART_BUCKETS * round;
      if (part > MAX_PART) throw new RangeError("credit_service_usage_parts_exceeded");
      parts.push({ part, split: true, lines: slice });
    }),
  );
  return parts.sort((left, right) => left.part - right.part);
}

/**
 * The postings of one organization's lines in one window in a layout. A whole window is one posting that carries no
 * part and no layout, the posting every window had before parts existed, under the key it always had.
 */
function postingsOf(layout: Layout, lines: readonly UsageLine[]): Posting[] {
  return layout === "whole" ? [{ lines: [...lines] }] : splitParts(lines);
}

const labelOf = ({ organizationId, window, part = 0 }: UsagePosting): string =>
  `${organizationId}:${window}${part > 0 ? `:p${String(part)}` : ""}`;

const reasonOf = (error: unknown): string =>
  (error instanceof Error ? error.message : "unknown").slice(0, 200) || "unknown";

/**
 * Whether repeating the posting cannot help, as far as the error says so: a `TypeError` or `RangeError` survives the
 * binding with its name, and so does a `ZodError` where it is a class of its own. The error is not parsed for words: a
 * network failure may say "refused" too. What the binding turns into a plain `Error` is judged by the Core, which
 * validates the kept lines itself (`recordUsageFailure`).
 */
const isRefusal = (error: unknown): boolean =>
  error instanceof Error && ["ZodError", "TypeError", "RangeError"].includes(error.name);

/**
 * Lines of an attempt that were not posted because the window is booked in another layout. This is billable usage that
 * is dropped, not a failure: the booked posting already holds most of these lines, but a line that only this attempt
 * has (a late Logpush object) is not billed, as for any booked key. It is counted and logged so that it can be seen.
 */
function supersede(
  deps: Dependencies,
  report: SourceReport,
  window: string,
  organizationId: string,
  lines: number,
): void {
  count(report, "layout_superseded");
  count(report, "lines_superseded", lines);
  deps.log({
    event: "credit_usage_layout_superseded",
    level: "error",
    source: report.source,
    organizationId,
    window,
    lines,
  });
}

/**
 * One idempotent posting per organization and layout part; the Core's key makes a rerun of the same window harmless.
 * A window is booked in the layout of its first posting: when the Core answers with the other layout, the lines follow
 * it (a window booked whole is complete; a window booked in parts is posted in parts), so a line count that crosses
 * 2000 between two attempts never books a line twice. A posting that fails does not stop the others: it is kept in the
 * Core with its lines and counted. While it is not dead the window is held (the first error is thrown and the next
 * pass repeats the window); a dead posting no longer holds the cursor, so that one organization cannot hold every
 * other. A window in which no organization is answered at all is a failure of the Core, not of a posting: nothing is
 * kept or counted and the first error is thrown. The cursor passes a posting only when it is booked or durably kept.
 */
export async function postOrganizations(
  deps: Dependencies,
  report: SourceReport,
  window: string,
  byOrganization: ReadonlyMap<string, readonly UsageLine[]>,
): Promise<void> {
  const failed: { posting: UsagePosting; error: unknown }[] = [];
  let answered = 0;
  for (const [organizationId, lines] of byOrganization) {
    let layout: Layout = lines.length <= POSTING_LINE_CAP ? "whole" : "split";
    for (let again = true; again; ) {
      again = false;
      let plan: UsagePosting[];
      try {
        plan = postingsOf(layout, lines).map((posting) => ({
          organizationId,
          source: report.source,
          window,
          ...posting,
        }));
      } catch (error) {
        failed.push({
          posting: { organizationId, source: report.source, window, lines: [] },
          error,
        });
        break;
      }
      for (const posting of plan) {
        try {
          const result = await deps.core.postUsage(posting);
          answered++;
          if (result.layout === undefined || result.layout === layout) {
            if (result.posted) report.posted++;
            else report.duplicates++;
          } else if (result.layout === "split") {
            layout = "split";
            again = true;
            break;
          } else {
            // booked whole: the window is complete, and what this attempt holds beyond it is dropped
            supersede(deps, report, window, organizationId, lines.length);
            break;
          }
        } catch (error) {
          failed.push({ posting, error });
        }
      }
    }
  }
  if (failed.length > 0 && answered === 0 && byOrganization.size > 1) throw failed[0]?.error;
  let held: { readonly error: unknown } | undefined;
  for (const { posting, error } of failed) {
    const { attempts, dead, settled } = await deps.core.recordUsageFailure({
      ...posting,
      reason: reasonOf(error),
      limit: POST_ATTEMPTS,
      immediate: isRefusal(error) || posting.lines.length === 0,
    });
    if (settled === "booked") {
      report.duplicates++;
      continue;
    }
    if (settled === "superseded") {
      supersede(deps, report, window, posting.organizationId, posting.lines.length);
      continue;
    }
    count(report, "postings_failed");
    report.problems.push(`usage_post_failed:${labelOf(posting)}`);
    if (dead) {
      count(report, "postings_dead_lettered");
      report.problems.push(`usage_post_dead_lettered:${labelOf(posting)}`);
    } else held ??= { error };
    deps.log({
      event: "credit_usage_post_failed",
      level: "error",
      source: report.source,
      organizationId: posting.organizationId,
      window,
      part: posting.part ?? 0,
      attempts,
      deadLettered: dead,
      reason: reasonOf(error),
    });
  }
  if (held !== undefined) throw held.error;
}
