-- The original rolling export quota is per GLOBAL project, including after an ownership transfer.
-- Historical jobs retain their organization; the quota does not restart when the project changes owner.
CREATE INDEX recovery_jobs_global_project_requested ON project_recovery_jobs (project_id, requested_at);
