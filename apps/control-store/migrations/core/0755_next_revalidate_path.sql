-- Admit an explicit, Next-only path revalidation flag without weakening other plan checks.
DROP TRIGGER deployment_plans_framework_shape;
DROP TRIGGER deployment_plans_framework_kind;
CREATE TRIGGER deployment_plans_framework_shape BEFORE INSERT ON deployment_plans
WHEN NEW.framework_plan IS NOT NULL
BEGIN
 SELECT RAISE(ABORT,'deployment framework plan shape') WHERE NOT (
   WITH original(doc) AS (SELECT NEW.framework_plan),
   aliased(doc) AS (SELECT CASE WHEN json_extract(doc,'$.adapter')='astro' THEN
     CASE WHEN json_extract(doc,'$.runtime')='static' THEN json_set(doc,'$.adapter','vite-static')
       ELSE json_set(doc,'$.adapter','tanstack-start','$.serverEntryPoint','dist/server/index.js') END ELSE doc END FROM original),
   plan(p) AS (SELECT json_remove(json_remove(json_remove(json_remove(doc,'$.ssgCacheMaxBytes'),'$.ai'),'$.browser'),'$.nextRevalidatePath') FROM aliased)
   SELECT (json_type(p)='object' AND json_extract(p,'$.schemaVersion')='ohmyhost.framework-plan/v5'
 AND coalesce(json_type(p,'$.applicationRoot'),'missing')='text' AND length(CAST(json_extract(p,'$.applicationRoot') AS BLOB))<=64
 AND (json_extract(p,'$.applicationRoot')='.' OR (json_extract(p,'$.applicationRoot') NOT GLOB '*[^A-Za-z0-9._/-]*' AND length(json_extract(p,'$.applicationRoot'))>0
   AND NOT EXISTS (SELECT 1 FROM json_each('["'||replace(json_extract(p,'$.applicationRoot'),'/','","')||'"]') segment
     WHERE length(segment.value) NOT BETWEEN 1 AND 63 OR substr(segment.value,1,1) NOT GLOB '[A-Za-z0-9]')
   AND length(json_extract(p,'$.applicationRoot'))-length(replace(json_extract(p,'$.applicationRoot'),'/',''))<8))
 AND (((json_type(json_extract(p,'$.database'))='object' AND (SELECT count(*) FROM json_each(json_extract(p,'$.database')))=1 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(p,'$.database')) WHERE key NOT IN ('enabled'))) AND json_type(json_extract(p,'$.database'),'$.enabled')='false') OR ((json_type(json_extract(p,'$.database'))='object' AND (SELECT count(*) FROM json_each(json_extract(p,'$.database')))=2 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(p,'$.database')) WHERE key NOT IN ('enabled','migrations'))) AND json_type(json_extract(p,'$.database'),'$.enabled')='true'
   AND coalesce(json_type(json_extract(p,'$.database'),'$.migrations'),'missing')='text' AND length(json_extract(json_extract(p,'$.database'),'$.migrations')) BETWEEN 1 AND 512
   AND substr(json_extract(json_extract(p,'$.database'),'$.migrations'),1,1)<>'/' AND instr(json_extract(json_extract(p,'$.database'),'$.migrations'),':')=0
   AND instr('/'||json_extract(json_extract(p,'$.database'),'$.migrations')||'/','/../')=0))
 AND (((json_type(json_extract(p,'$.auth'))='object' AND (SELECT count(*) FROM json_each(json_extract(p,'$.auth')))=1 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(p,'$.auth')) WHERE key NOT IN ('provider'))) AND json_extract(json_extract(p,'$.auth'),'$.provider')='none') OR (json_type(json_extract(p,'$.auth'))='object' AND (SELECT count(*) FROM json_each(json_extract(p,'$.auth')))=3 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(p,'$.auth')) WHERE key NOT IN ('provider','routePath','bindingName')) AND json_extract(p,'$.auth.provider')='omh-native' AND json_extract(p,'$.auth.routePath')='/api/auth/v1' AND json_extract(p,'$.auth.bindingName')='OHMYHOST_AUTH') OR ((json_type(json_extract(p,'$.auth'))='object' AND (SELECT count(*) FROM json_each(json_extract(p,'$.auth')))=7 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(p,'$.auth')) WHERE key NOT IN ('provider','version','deployment','routePath','databaseSchema','databaseBindingName','authSecretName')))
   AND json_extract(json_extract(p,'$.auth'),'$.provider')='better-auth' AND json_extract(json_extract(p,'$.auth'),'$.version') IN ('1.7.1','1.7.7')
   AND json_extract(json_extract(p,'$.auth'),'$.deployment') IN ('embedded','companion') AND json_extract(json_extract(p,'$.auth'),'$.routePath')='/api/auth'
   AND json_extract(json_extract(p,'$.auth'),'$.databaseSchema')='auth' AND json_extract(json_extract(p,'$.auth'),'$.databaseBindingName')='OHMYHOST_DATABASE'
   AND json_extract(json_extract(p,'$.auth'),'$.authSecretName')='BETTER_AUTH_SECRET'))
 AND (json_type(json_extract(p,'$.mail'))='object' AND (SELECT count(*) FROM json_each(json_extract(p,'$.mail')))=1 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(p,'$.mail')) WHERE key NOT IN ('enabled'))) AND json_type(json_extract(p,'$.mail'),'$.enabled') IN ('true','false')
 AND (((json_type(json_extract(p,'$.storage'))='object' AND (SELECT count(*) FROM json_each(json_extract(p,'$.storage')))=1 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(p,'$.storage')) WHERE key NOT IN ('enabled'))) AND json_type(json_extract(p,'$.storage'),'$.enabled')='false') OR ((json_type(json_extract(p,'$.storage'))='object' AND (SELECT count(*) FROM json_each(json_extract(p,'$.storage')))=4 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(p,'$.storage')) WHERE key NOT IN ('enabled','provider','jurisdiction','public')))
   AND json_type(json_extract(p,'$.storage'),'$.enabled')='true' AND json_extract(json_extract(p,'$.storage'),'$.provider')='r2'
   AND json_extract(json_extract(p,'$.storage'),'$.jurisdiction') IN ('eu','us') AND json_type(json_extract(p,'$.storage'),'$.public')='false'))
 AND (json_extract(json_extract(p,'$.auth'),'$.provider') IN ('none','omh-native') OR json_type(json_extract(p,'$.database'),'$.enabled')='true')) IS TRUE FROM plan);
END;

-- A cache scope is registered before a candidate may run, so even a failed health probe is in deletion inventory.
CREATE TABLE next_cache_scopes (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  region TEXT NOT NULL CHECK(region IN('us','eu')),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(organization_id,project_id,environment_id,deployment_id),
  FOREIGN KEY(organization_id,project_id,environment_id,deployment_id)
    REFERENCES deployments(organization_id,project_id,environment_id,deployment_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TRIGGER next_cache_scopes_no_update BEFORE UPDATE ON next_cache_scopes
BEGIN SELECT RAISE(ABORT,'Next cache scope is immutable'); END;
CREATE TRIGGER next_cache_scopes_no_delete BEFORE DELETE ON next_cache_scopes
BEGIN SELECT RAISE(ABORT,'Next cache scope is immutable'); END;
CREATE INDEX next_cache_scopes_by_deployment ON next_cache_scopes(organization_id,project_id,deployment_id);
CREATE TABLE next_cache_retirements (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  cleanup_run_id TEXT NOT NULL,
  retired_at TEXT NOT NULL CHECK(retired_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(organization_id,project_id,environment_id,deployment_id),
  FOREIGN KEY(organization_id,project_id,environment_id,deployment_id)
    REFERENCES next_cache_scopes(organization_id,project_id,environment_id,deployment_id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,project_id,operation_id,cleanup_run_id)
    REFERENCES cleanup_runs(organization_id,project_id,operation_id,cleanup_run_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE TRIGGER next_cache_retirements_no_update BEFORE UPDATE ON next_cache_retirements
BEGIN SELECT RAISE(ABORT,'Next cache retirement is immutable'); END;
CREATE TRIGGER next_cache_retirements_no_delete BEFORE DELETE ON next_cache_retirements
BEGIN SELECT RAISE(ABORT,'Next cache retirement is immutable'); END;

-- Retirement establishes a permanent fence in the same batch as its authorization, so a delayed external purge
-- can never race a project returning to active or a later rollback.
CREATE TABLE next_cache_deletion_fences (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  cleanup_run_id TEXT NOT NULL,
  fenced_at TEXT NOT NULL CHECK(fenced_at GLOB '????-??-??T??:??:??.??????Z'),
  PRIMARY KEY(organization_id,project_id),
  FOREIGN KEY(organization_id,project_id) REFERENCES projects(organization_id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,project_id,operation_id,cleanup_run_id)
    REFERENCES cleanup_runs(organization_id,project_id,operation_id,cleanup_run_id) ON DELETE RESTRICT
) STRICT, WITHOUT ROWID;
CREATE INDEX next_cache_deletion_fences_by_project ON next_cache_deletion_fences(project_id);
CREATE TRIGGER next_cache_deletion_fences_no_update BEFORE UPDATE ON next_cache_deletion_fences
BEGIN SELECT RAISE(ABORT,'Next cache deletion fence is immutable'); END;
CREATE TRIGGER next_cache_deletion_fences_no_delete BEFORE DELETE ON next_cache_deletion_fences
BEGIN SELECT RAISE(ABORT,'Next cache deletion fence is immutable'); END;
CREATE TRIGGER projects_next_cache_deletion_irreversible BEFORE UPDATE OF lifecycle_state ON projects
WHEN NEW.lifecycle_state NOT IN('deleting','deleted') AND EXISTS(
  SELECT 1 FROM next_cache_deletion_fences WHERE project_id=OLD.project_id)
BEGIN SELECT RAISE(ABORT,'project deletion cannot be reversed'); END;
CREATE TRIGGER projects_next_cache_deletion_no_active_copy BEFORE INSERT ON projects
WHEN NEW.lifecycle_state NOT IN('deleting','deleted') AND EXISTS(
  SELECT 1 FROM next_cache_deletion_fences WHERE project_id=NEW.project_id)
BEGIN SELECT RAISE(ABORT,'project deletion cannot be reversed'); END;
CREATE TRIGGER deployment_plans_framework_kind BEFORE INSERT ON deployment_plans
WHEN NEW.framework_plan IS NOT NULL
BEGIN
 SELECT RAISE(ABORT,'deployment framework adapter shape') WHERE NOT (
   WITH original(doc) AS (SELECT NEW.framework_plan),
   aliased(doc) AS (SELECT CASE WHEN json_extract(doc,'$.adapter')='astro' THEN
     CASE WHEN json_extract(doc,'$.runtime')='static' THEN json_set(doc,'$.adapter','vite-static')
       ELSE json_set(doc,'$.adapter','tanstack-start','$.serverEntryPoint','dist/server/index.js') END ELSE doc END FROM original),
   plan(p) AS (SELECT json_remove(json_remove(json_remove(json_remove(doc,'$.ssgCacheMaxBytes'),'$.ai'),'$.browser'),'$.nextRevalidatePath') FROM aliased)
   SELECT ((
 ((json_type(p)='object' AND (SELECT count(*) FROM json_each(p))=12 AND NOT EXISTS (SELECT 1 FROM json_each(p) WHERE key NOT IN ('adapter','runtime','installCommand','buildCommand','outputDirectory','schemaVersion','applicationRoot','runtimePolicy','database','auth','mail','storage'))) AND ((json_extract(p,'$.installCommand')='bun install --frozen-lockfile --ignore-scripts' AND json_extract(p,'$.buildCommand')='bun run build') OR (json_extract(p,'$.installCommand')='npm ci --ignore-scripts' AND json_extract(p,'$.buildCommand')='npm run build') OR (json_extract(p,'$.installCommand')='pnpm install --frozen-lockfile --ignore-scripts' AND json_extract(p,'$.buildCommand')='pnpm run build') OR (json_extract(p,'$.installCommand')='yarn install --immutable --mode=skip-build' AND json_extract(p,'$.buildCommand')='yarn run build')) AND json_extract(p,'$.adapter') IN ('vite-static','tanstack-start') AND json_extract(p,'$.runtime')='static'
  AND ((json_extract(p,'$.adapter')='vite-static' AND json_extract(p,'$.outputDirectory')='dist') OR (json_extract(p,'$.adapter')='tanstack-start' AND json_extract(p,'$.outputDirectory')='dist/client')) AND ((json_type(json_extract(p,'$.storage'))='object' AND (SELECT count(*) FROM json_each(json_extract(p,'$.storage')))=1 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(p,'$.storage')) WHERE key NOT IN ('enabled'))) AND json_type(json_extract(p,'$.storage'),'$.enabled')='false'))
 OR (((json_type(p)='object' AND (SELECT count(*) FROM json_each(p))=17 AND NOT EXISTS (SELECT 1 FROM json_each(p) WHERE key NOT IN ('adapter','runtime','installCommand','buildCommand','outputDirectory','schemaVersion','applicationRoot','runtimePolicy','database','auth','mail','storage','serverOutputDirectory','serverEntryPoint','serverConfigPath','compatibilityDate','compatibilityFlags'))) OR (json_type(p)='object' AND (SELECT count(*) FROM json_each(p))=18 AND NOT EXISTS (SELECT 1 FROM json_each(p) WHERE key NOT IN ('adapter','runtime','installCommand','buildCommand','outputDirectory','schemaVersion','applicationRoot','runtimePolicy','database','auth','mail','storage','serverOutputDirectory','serverEntryPoint','serverConfigPath','compatibilityDate','compatibilityFlags','functions')))) AND ((json_extract(p,'$.installCommand')='bun install --frozen-lockfile --ignore-scripts' AND json_extract(p,'$.buildCommand')='bun run build') OR (json_extract(p,'$.installCommand')='npm ci --ignore-scripts' AND json_extract(p,'$.buildCommand')='npm run build') OR (json_extract(p,'$.installCommand')='pnpm install --frozen-lockfile --ignore-scripts' AND json_extract(p,'$.buildCommand')='pnpm run build') OR (json_extract(p,'$.installCommand')='yarn install --immutable --mode=skip-build' AND json_extract(p,'$.buildCommand')='yarn run build')) AND json_extract(p,'$.adapter')='tanstack-start' AND json_extract(p,'$.runtime')='edge' AND NEW.runtime='cloudflare_workers_edge_ssr'
  AND json_extract(p,'$.outputDirectory')='dist/client' AND json_extract(p,'$.serverOutputDirectory')='dist/server' AND json_extract(p,'$.serverEntryPoint')='dist/server/index.js'
  AND json_extract(p,'$.serverConfigPath')='dist/server/wrangler.json' AND (CASE coalesce(json_type(p,'$.compatibilityDate'),'missing') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN NULL WHEN 'integer' THEN (p->'$.compatibilityDate') WHEN 'real' THEN (p->'$.compatibilityDate') ELSE CAST(json_extract(p,'$.compatibilityDate') AS TEXT) END)>='2025-04-01' AND (coalesce(json_type(p,'$.compatibilityFlags'),'missing')='array' AND json_array_length(p,'$.compatibilityFlags')=1 AND json_extract(p,'$.compatibilityFlags[0]')='nodejs_compat'))
 OR (((json_type(p)='object' AND (SELECT count(*) FROM json_each(p))=17 AND NOT EXISTS (SELECT 1 FROM json_each(p) WHERE key NOT IN ('adapter','runtime','installCommand','buildCommand','outputDirectory','schemaVersion','applicationRoot','runtimePolicy','database','auth','mail','storage','serverOutputDirectory','serverEntryPoint','serverConfigPath','compatibilityDate','compatibilityFlags'))) OR (json_type(p)='object' AND (SELECT count(*) FROM json_each(p))=18 AND NOT EXISTS (SELECT 1 FROM json_each(p) WHERE key NOT IN ('adapter','runtime','installCommand','buildCommand','outputDirectory','schemaVersion','applicationRoot','runtimePolicy','database','auth','mail','storage','serverOutputDirectory','serverEntryPoint','serverConfigPath','compatibilityDate','compatibilityFlags','functions')))) AND ((json_extract(p,'$.installCommand')='bun install --frozen-lockfile --ignore-scripts' AND json_extract(p,'$.buildCommand')='bun run build') OR (json_extract(p,'$.installCommand')='npm ci --ignore-scripts' AND json_extract(p,'$.buildCommand')='npm run build') OR (json_extract(p,'$.installCommand')='pnpm install --frozen-lockfile --ignore-scripts' AND json_extract(p,'$.buildCommand')='pnpm run build') OR (json_extract(p,'$.installCommand')='yarn install --immutable --mode=skip-build' AND json_extract(p,'$.buildCommand')='yarn run build')) AND json_extract(p,'$.adapter')='nextjs' AND json_extract(p,'$.runtime')='edge' AND NEW.runtime='cloudflare_workers_edge_ssr'
  AND json_extract(p,'$.outputDirectory')='.open-next/assets' AND json_extract(p,'$.serverOutputDirectory')='.ohmyhost-worker' AND json_extract(p,'$.serverEntryPoint')='.ohmyhost-worker/worker.js'
  AND json_extract(p,'$.serverConfigPath')='wrangler.jsonc' AND (CASE coalesce(json_type(p,'$.compatibilityDate'),'missing') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN NULL WHEN 'integer' THEN (p->'$.compatibilityDate') WHEN 'real' THEN (p->'$.compatibilityDate') ELSE CAST(json_extract(p,'$.compatibilityDate') AS TEXT) END)>='2024-09-23' AND (coalesce(json_type(p,'$.compatibilityFlags'),'missing')='array' AND json_array_length(p,'$.compatibilityFlags')=1 AND json_extract(p,'$.compatibilityFlags[0]')='nodejs_compat'))
 OR (((json_type(p)='object' AND (SELECT count(*) FROM json_each(p))=17 AND NOT EXISTS (SELECT 1 FROM json_each(p) WHERE key NOT IN ('adapter','runtime','installCommand','buildCommand','outputDirectory','schemaVersion','applicationRoot','runtimePolicy','database','auth','mail','storage','serverOutputDirectory','serverEntryPoint','serverConfigPath','compatibilityDate','compatibilityFlags'))) OR (json_type(p)='object' AND (SELECT count(*) FROM json_each(p))=18 AND NOT EXISTS (SELECT 1 FROM json_each(p) WHERE key NOT IN ('adapter','runtime','installCommand','buildCommand','outputDirectory','schemaVersion','applicationRoot','runtimePolicy','database','auth','mail','storage','serverOutputDirectory','serverEntryPoint','serverConfigPath','compatibilityDate','compatibilityFlags','functions')))) AND ((json_extract(p,'$.installCommand')='bun install --frozen-lockfile --ignore-scripts' AND json_extract(p,'$.buildCommand')='bun run build') OR (json_extract(p,'$.installCommand')='npm ci --ignore-scripts' AND json_extract(p,'$.buildCommand')='npm run build') OR (json_extract(p,'$.installCommand')='pnpm install --frozen-lockfile --ignore-scripts' AND json_extract(p,'$.buildCommand')='pnpm run build') OR (json_extract(p,'$.installCommand')='yarn install --immutable --mode=skip-build' AND json_extract(p,'$.buildCommand')='yarn run build')) AND json_extract(p,'$.adapter')='vite-static' AND json_extract(p,'$.runtime')='edge' AND NEW.runtime='cloudflare_workers_edge_ssr'
  AND json_extract(p,'$.outputDirectory')='dist' AND json_extract(p,'$.serverOutputDirectory')='.ohmyhost/vite-companion' AND json_extract(p,'$.serverEntryPoint')='.ohmyhost/vite-companion/worker.js'
  AND json_extract(p,'$.serverConfigPath')='.ohmyhost/vite-companion/wrangler.jsonc' AND (CASE coalesce(json_type(p,'$.compatibilityDate'),'missing') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN NULL WHEN 'integer' THEN (p->'$.compatibilityDate') WHEN 'real' THEN (p->'$.compatibilityDate') ELSE CAST(json_extract(p,'$.compatibilityDate') AS TEXT) END)='2025-01-01' AND (coalesce(json_type(p,'$.compatibilityFlags'),'missing')='array' AND json_array_length(p,'$.compatibilityFlags')=1 AND json_extract(p,'$.compatibilityFlags[0]')='nodejs_compat')
  AND (json_extract(json_extract(p,'$.auth'),'$.provider') IN ('none','omh-native') OR json_extract(json_extract(p,'$.auth'),'$.deployment')='companion'))
 OR (((json_type(p)='object' AND (SELECT count(*) FROM json_each(p))=12 AND NOT EXISTS (SELECT 1 FROM json_each(p) WHERE key NOT IN ('adapter','runtime','installCommand','schemaVersion','applicationRoot','runtimePolicy','database','auth','mail','storage','compatibilityDate','compatibilityFlags'))) OR (json_type(p)='object' AND (SELECT count(*) FROM json_each(p))=13 AND NOT EXISTS (SELECT 1 FROM json_each(p) WHERE key NOT IN ('adapter','runtime','installCommand','schemaVersion','applicationRoot','runtimePolicy','database','auth','mail','storage','compatibilityDate','compatibilityFlags','functions')))) AND json_extract(p,'$.adapter')='functions' AND json_extract(p,'$.runtime')='functions' AND NEW.runtime='cloudflare_workers_edge_ssr'
  AND json_extract(p,'$.installCommand') IN ('bun install --frozen-lockfile --ignore-scripts','npm ci --ignore-scripts','pnpm install --frozen-lockfile --ignore-scripts','yarn install --immutable --mode=skip-build') AND (CASE coalesce(json_type(p,'$.compatibilityDate'),'missing') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN NULL WHEN 'integer' THEN (p->'$.compatibilityDate') WHEN 'real' THEN (p->'$.compatibilityDate') ELSE CAST(json_extract(p,'$.compatibilityDate') AS TEXT) END)>='2025-01-01' AND (coalesce(json_type(p,'$.compatibilityFlags'),'missing')='array' AND json_array_length(p,'$.compatibilityFlags')=1 AND json_extract(p,'$.compatibilityFlags[0]')='nodejs_compat')
  AND (json_extract(json_extract(p,'$.auth'),'$.provider') IN ('none','omh-native') OR json_extract(json_extract(p,'$.auth'),'$.deployment')='companion'))
)) IS TRUE FROM plan);
 SELECT RAISE(ABORT,'Astro framework plan shape') WHERE json_extract(NEW.framework_plan,'$.adapter')='astro' AND ((
   json_type(NEW.framework_plan,'$.ssgCacheMaxBytes') IS NULL
   AND (json_extract(NEW.framework_plan,'$.runtime')='static' OR (json_extract(NEW.framework_plan,'$.serverEntryPoint')='dist/server/entry.mjs' AND (CASE coalesce(json_type(NEW.framework_plan,'$.compatibilityDate'),'missing') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN NULL WHEN 'integer' THEN (NEW.framework_plan->'$.compatibilityDate') WHEN 'real' THEN (NEW.framework_plan->'$.compatibilityDate') ELSE CAST(json_extract(NEW.framework_plan,'$.compatibilityDate') AS TEXT) END)>='2026-10-12'))
   AND (json_extract(NEW.framework_plan,'$.runtime')<>'static' OR (((json_type(json_extract(NEW.framework_plan,'$.database'))='object' AND (SELECT count(*) FROM json_each(json_extract(NEW.framework_plan,'$.database')))=1 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(NEW.framework_plan,'$.database')) WHERE key NOT IN ('enabled'))) AND json_type(json_extract(NEW.framework_plan,'$.database'),'$.enabled')='false') AND json_extract(NEW.framework_plan,'$.auth.provider') IN ('none','omh-native') AND ((json_type(json_extract(NEW.framework_plan,'$.mail'))='object' AND (SELECT count(*) FROM json_each(json_extract(NEW.framework_plan,'$.mail')))=1 AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(NEW.framework_plan,'$.mail')) WHERE key NOT IN ('enabled'))) AND json_type(json_extract(NEW.framework_plan,'$.mail'),'$.enabled')='false')))) IS NOT TRUE);
END;

CREATE TRIGGER deployment_plans_next_revalidate_path_shape BEFORE INSERT ON deployment_plans
WHEN json_type(NEW.framework_plan,'$.nextRevalidatePath') IS NOT NULL
BEGIN
 SELECT RAISE(ABORT,'deployment Next revalidation shape') WHERE NOT (
   json_type(NEW.framework_plan,'$.nextRevalidatePath')='true'
   AND json_extract(NEW.framework_plan,'$.adapter')='nextjs'
   AND json_extract(NEW.framework_plan,'$.runtime')='edge');
END;
