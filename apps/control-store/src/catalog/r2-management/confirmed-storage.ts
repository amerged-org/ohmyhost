import { z } from "zod";
import { guard } from "../../guards.js";
import { instant, type CatalogContext } from "../common.js";
const NOW = `(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')`;
const bucket = z.strictObject({
  bucketName: z.string().min(1).max(1024),
  jurisdiction: z.enum(["eu", "us"]),
});
const confirmedInput = bucket.extend({ from: instant, to: instant, deadline: instant });
/** Source object/deletion lifetimes, complete-day clipped peak; no speculative/unconfirmed upload bytes. */
export async function readR2Confirmed(context: CatalogContext, raw: unknown) {
  const i = confirmedInput.parse(raw),
    { db } = await context.router.routeShard(0),
    from = Date.parse(i.from),
    to = Date.parse(i.to);
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from % 86400000 !== 0 ||
    to <= from ||
    to - from > 3 * 86400000
  )
    throw new TypeError("Invalid R2 storage window");
  const records = [];
  for (let at = from; at + 86400000 <= to; at += 86400000) {
    const starts = new Date(at).toISOString().replace("Z", "000Z"),
      ends = new Date(at + 86400000).toISOString().replace("Z", "000Z");
    const [, result] = await db.batch([
      guard(db, "scope_inactive", `${NOW}>?1`, [i.deadline]),
      db
        .prepare(
          `WITH lifetimes AS(
      SELECT object.size,object.created_at AS starts_at,min(coalesce((SELECT min(deleted_at) FROM project_r2_delete_receipts deletion WHERE deletion.organization_id=object.organization_id AND deletion.project_id=object.project_id AND deletion.environment_id=object.environment_id AND deletion.physical_object_key=object.physical_object_key AND deleted_at<>'+infinity'),?4),coalesce((SELECT min(created_at) FROM product_command_intents intent WHERE intent.organization_id=object.organization_id AND intent.project_id=object.project_id AND intent.event_type='ProjectDeletionRequestedV1'),?4)) AS ends_at
      FROM project_r2_objects object JOIN project_r2_bucket_receipts bucket USING(organization_id,project_id,environment_id) WHERE bucket.bucket_name=?1 AND bucket.jurisdiction=?2 AND object.created_at<>'+infinity'
    ),clipped AS(SELECT size,max(starts_at,?3) AS begins,min(ends_at,?4) AS ends FROM lifetimes WHERE starts_at<?4 AND ends_at>?3),events AS(SELECT begins AS at,size AS delta FROM clipped WHERE begins<ends UNION ALL SELECT ends AS at,-size AS delta FROM clipped WHERE begins<ends),cohorts AS(SELECT at,sum(delta) AS delta FROM events GROUP BY at),running AS(SELECT sum(delta) OVER(ORDER BY at) AS bytes FROM cohorts) SELECT CAST(coalesce(max(bytes),0) AS TEXT) AS peak FROM running`,
        )
        .bind(i.bucketName, i.jurisdiction, starts, ends),
    ]);
    const quantity = String(result?.results[0]?.["peak"]);
    if (!/^(0|[1-9][0-9]*)$/u.test(quantity)) throw new Error("Confirmed file storage is invalid");
    records.push({
      meter: "r2.storage.standard" as const,
      unit: "byte_peak_day" as const,
      from: new Date(at).toISOString(),
      to: new Date(at + 86400000).toISOString(),
      quantity,
      exact: true,
    });
  }
  return records;
}
