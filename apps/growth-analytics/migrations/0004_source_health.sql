CREATE TABLE growth_source_health (
  producer TEXT PRIMARY KEY,
  as_of TEXT NOT NULL,
  body TEXT NOT NULL CHECK (json_valid(body))
);
