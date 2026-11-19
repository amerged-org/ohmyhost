ALTER TABLE user_signup ADD COLUMN utm_parameters TEXT
  CHECK (utm_parameters IS NULL OR (json_valid(utm_parameters) AND json_type(utm_parameters) = 'object'));
