/** Qualified0466 derived mirror only. Original workspace/binding facts are imported separately. */
export const MAIL_MIRROR_IMPORT_HOOK = Object.freeze({
  name: "mirror_legacy_workspace_mail",
  migration: "0466_mail_original_management.sql",
  migrationSha256: "df9c9b9959ff42f09b01c657c38c1f033d247e98cc6ebe6af79c894068adc86e",
  sqlSha256: "3c79ccd99e44fec1ec03d46409d1e6de2809e70ef03066b7f3eb5e90b9db830c",
});
export const MAIL_IMPORT_HOOKS = Object.freeze([
  MAIL_MIRROR_IMPORT_HOOK,
  Object.freeze({
    name: "mark_mail_capabilities_dirty_insert",
    migration: MAIL_MIRROR_IMPORT_HOOK.migration,
    migrationSha256: MAIL_MIRROR_IMPORT_HOOK.migrationSha256,
    sqlSha256: "01ab1e72578555dea5b6283d651a693e50c00bb0d3eeb573167698dca57b490e",
  }),
]);
