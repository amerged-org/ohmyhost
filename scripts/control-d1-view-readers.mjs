import { sha256 } from "./control-d1-codec.mjs";
import { Buffer } from "node:buffer";
import { qualifyEffectiveWfpView } from "./control-d1-wfp-view.mjs";

// Literal PG18 pg_get_viewdef(...,true), qualified against original110 and both retained schema-only baselines.
export const PUBLIC_BETA_SOURCE_DEFINITION =
  " SELECT source_id\n   FROM signup_sources\n  WHERE active AND admits_beta;";

/** A view is accounted only after its exact definition and every physical source parent qualify. */
export function qualifySourceViews(capture, mapped) {
  const readers = [],
    gaps = [],
    definitions = capture.manifest.views.filter((view) => view.name === "public_beta_sources");
  if (definitions.length === 0) {
    if (mapped.has("signup_sources"))
      gaps.push({ group: "public-beta-view-v1", code: "CONTROL_D1_VIEW_REQUIRED" });
  } else if (
    definitions.length !== 1 ||
    definitions[0].definition !== PUBLIC_BETA_SOURCE_DEFINITION
  )
    gaps.push({ group: "public-beta-view-v1", code: "CONTROL_D1_VIEW_DEFINITION_UNQUALIFIED" });
  else if (!mapped.has("signup_sources"))
    gaps.push({ group: "public-beta-view-v1", code: "CONTROL_D1_VIEW_PARENT_UNQUALIFIED" });
  else
    readers.push({
      sourceName: "public_beta_sources",
      reader: "public-beta-sources-v1",
      sourceDefinitionSha256: sha256(Buffer.from(definitions[0].definition)),
      parents: ["signup_sources"],
    });
  if (mapped.has("wfp_publish_receipts")) {
    const qualified = qualifyEffectiveWfpView(capture, mapped);
    readers.push(...qualified.readers);
    gaps.push(...qualified.gaps);
  }
  return { readers, gaps };
}

/** Original110 read-only predicate; parent values retain the original boolean meaning. View order is unspecified. */
export async function readPublicBetaSources(db) {
  return (
    await db.prepare("SELECT source_id FROM signup_sources WHERE active=1 AND admits_beta=1").all()
  ).results;
}
