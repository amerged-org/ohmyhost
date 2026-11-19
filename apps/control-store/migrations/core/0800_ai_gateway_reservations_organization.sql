-- The open-call guard of an admission counts the markers of one organization. Without an index on the organization every
-- admission scanned the whole marker table, which grows with each call until the sweep removes its resolved markers.
CREATE INDEX ai_gateway_reservations_organization ON ai_gateway_reservations(organization_id);
