CREATE TABLE growth_deployment_health (
  observation_id TEXT PRIMARY KEY,
  candidate_receipt_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX growth_deployment_health_scope ON growth_deployment_health(candidate_receipt_id,organization_id,project_id,environment_id,deployment_id,observed_at DESC);
