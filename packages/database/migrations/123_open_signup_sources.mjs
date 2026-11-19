// P30: signup is open. "direct" records a signup without referral; unknown sources are
// registered on first use for attribution only, so admits_beta no longer gates anyone.
export function up(pgm) {
  pgm.sql(`INSERT INTO signup_sources(source_id,active,admits_beta,bonus_micros)
    VALUES('direct',true,true,0) ON CONFLICT(source_id) DO NOTHING;
    UPDATE signup_sources SET admits_beta=true WHERE NOT admits_beta;`);
}
export function down(pgm) {
  pgm.sql(`DELETE FROM signup_sources WHERE source_id='direct'
    AND NOT EXISTS(SELECT 1 FROM user_signup_attributions WHERE source_id='direct')
    AND NOT EXISTS(SELECT 1 FROM organization_onboarding_requests WHERE signup_source='direct');`);
}
