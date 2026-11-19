-- A Paid hostname becomes platform-wide exclusive only once its owner proved control of it: a verified, project-bound
-- application domain identity (`_omh-project.<hostname>` TXT). `hostname_proven_at` records that proof at the apply that
-- claimed the name. An unproven claim still reserves the name for seven days, but it holds nothing against a proven
-- claim, it never reaches the gateway, and no provider route or custom hostname is made for it.
--
-- The live-hostname unique index covers proven rows only, so an unproven reservation can never block a proven owner.
-- Backfill: connections that already route or hold provider objects (pending, active or deleting with a gateway) keep
-- their name as proven, so no live site stops serving. This grandfathers them; it does not prove them. Awaiting-deployment
-- reservations stay unproven and need the proof before their first route.
ALTER TABLE paid_project_domains ADD COLUMN hostname_proven_at TEXT CHECK (hostname_proven_at IS NULL OR hostname_proven_at GLOB '????-??-??T??:??:??.??????Z');

UPDATE paid_project_domains SET hostname_proven_at = COALESCE(provisioning_started_at, created_at)
WHERE state IN ('pending', 'active', 'deleting') AND gateway_script_name IS NOT NULL;

DROP INDEX paid_project_domains_live_hostname;
CREATE UNIQUE INDEX paid_project_domains_live_hostname ON paid_project_domains(hostname)
WHERE state<>'deleted' AND hostname_proven_at IS NOT NULL;
