-- Anonymous callers write contact requests and roadmap votes into the Core that also holds the Directory and the ledger.
-- Each row now carries the source bucket the Control API derived from the caller's address (a digest byte, 0 to 255;
-- an IPv6 address by its /64), never the address. -2 marks a row with no real bucket: every row that exists now, every
-- row an old Worker inserts during the rollout (the DEFAULT) and a caller whose address was missing. public_intake_budget
-- counts the live rows per kind, bucket and UTC creation day, and per kind and bucket in all (day 'total'); bucket -1
-- counts all buckets together. The triggers keep every counter equal to the rows (insert, retention, an operator's
-- DELETE), so recordPublicContact and recordPublicFeatureVote read four counters, not the tables. They refuse a row past
-- a real bucket's share or the shared pool; the -2 marker has no share of its own and counts only in the pool sums.
-- Additive: a Worker that does not read the budget is unaffected by it.
ALTER TABLE contact_requests ADD COLUMN source_bucket INTEGER NOT NULL DEFAULT -2 CHECK(source_bucket=-2 OR source_bucket BETWEEN 0 AND 255);
ALTER TABLE beta_feature_interests ADD COLUMN source_bucket INTEGER NOT NULL DEFAULT -2 CHECK(source_bucket=-2 OR source_bucket BETWEEN 0 AND 255);
CREATE TABLE public_intake_budget (
  kind TEXT NOT NULL CHECK(kind IN ('contact','vote')),
  bucket INTEGER NOT NULL CHECK(bucket BETWEEN -2 AND 255),
  day TEXT NOT NULL CHECK(day='total' OR (length(day)=10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  entries INTEGER NOT NULL CHECK(entries>=0),
  PRIMARY KEY(kind,bucket,day)
) STRICT, WITHOUT ROWID;
INSERT INTO public_intake_budget(kind,bucket,day,entries)
SELECT 'contact',source_bucket,substr(created_at,1,10),count(*) FROM contact_requests GROUP BY source_bucket,substr(created_at,1,10)
UNION ALL SELECT 'contact',-1,substr(created_at,1,10),count(*) FROM contact_requests GROUP BY substr(created_at,1,10)
UNION ALL SELECT 'contact',source_bucket,'total',count(*) FROM contact_requests GROUP BY source_bucket
UNION ALL SELECT 'contact',-1,'total',n FROM (SELECT count(*) n FROM contact_requests) WHERE n>0;
INSERT INTO public_intake_budget(kind,bucket,day,entries)
SELECT 'vote',source_bucket,substr(created_at,1,10),count(*) FROM beta_feature_interests GROUP BY source_bucket,substr(created_at,1,10)
UNION ALL SELECT 'vote',-1,substr(created_at,1,10),count(*) FROM beta_feature_interests GROUP BY substr(created_at,1,10)
UNION ALL SELECT 'vote',source_bucket,'total',count(*) FROM beta_feature_interests GROUP BY source_bucket
UNION ALL SELECT 'vote',-1,'total',n FROM (SELECT count(*) n FROM beta_feature_interests) WHERE n>0;
CREATE TRIGGER contact_requests_budget_insert AFTER INSERT ON contact_requests
BEGIN
  INSERT INTO public_intake_budget(kind,bucket,day,entries)
  VALUES('contact',NEW.source_bucket,substr(NEW.created_at,1,10),1),('contact',-1,substr(NEW.created_at,1,10),1),
        ('contact',NEW.source_bucket,'total',1),('contact',-1,'total',1)
  ON CONFLICT(kind,bucket,day) DO UPDATE SET entries=entries+1;
END;
CREATE TRIGGER contact_requests_budget_delete AFTER DELETE ON contact_requests
BEGIN
  UPDATE public_intake_budget SET entries=max(entries-1,0)
  WHERE kind='contact' AND bucket IN(OLD.source_bucket,-1) AND day IN(substr(OLD.created_at,1,10),'total');
  DELETE FROM public_intake_budget
  WHERE kind='contact' AND bucket IN(OLD.source_bucket,-1) AND day IN(substr(OLD.created_at,1,10),'total') AND entries=0;
END;
CREATE TRIGGER beta_feature_interests_budget_insert AFTER INSERT ON beta_feature_interests
BEGIN
  INSERT INTO public_intake_budget(kind,bucket,day,entries)
  VALUES('vote',NEW.source_bucket,substr(NEW.created_at,1,10),1),('vote',-1,substr(NEW.created_at,1,10),1),
        ('vote',NEW.source_bucket,'total',1),('vote',-1,'total',1)
  ON CONFLICT(kind,bucket,day) DO UPDATE SET entries=entries+1;
END;
CREATE TRIGGER beta_feature_interests_budget_delete AFTER DELETE ON beta_feature_interests
BEGIN
  UPDATE public_intake_budget SET entries=max(entries-1,0)
  WHERE kind='vote' AND bucket IN(OLD.source_bucket,-1) AND day IN(substr(OLD.created_at,1,10),'total');
  DELETE FROM public_intake_budget
  WHERE kind='vote' AND bucket IN(OLD.source_bucket,-1) AND day IN(substr(OLD.created_at,1,10),'total') AND entries=0;
END;
