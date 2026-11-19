// Paid access granted by the operator is recorded as 'granted'; the service no longer calls
// anything a beta, so the stored source loses that name together with the public copy.
// The migration transaction holds the table lock until the append-only guard is restored.
export function up(pgm) {
  pgm.sql(`ALTER TABLE organization_paid_access DROP CONSTRAINT organization_paid_access_source_check;
    ALTER TABLE organization_paid_access_events DROP CONSTRAINT organization_paid_access_events_source_check;
    UPDATE organization_paid_access SET source='granted' WHERE source='beta';
    ALTER TABLE organization_paid_access_events DISABLE TRIGGER organization_paid_access_events_append_only;
    UPDATE organization_paid_access_events SET source='granted' WHERE source='beta';
    ALTER TABLE organization_paid_access_events ENABLE TRIGGER organization_paid_access_events_append_only;
    ALTER TABLE organization_paid_access
      ADD CONSTRAINT organization_paid_access_source_check CHECK(source IN ('granted','manual'));
    ALTER TABLE organization_paid_access_events
      ADD CONSTRAINT organization_paid_access_events_source_check CHECK(source IN ('granted','manual'));`);
}

export function down(pgm) {
  pgm.sql(`ALTER TABLE organization_paid_access DROP CONSTRAINT organization_paid_access_source_check;
    ALTER TABLE organization_paid_access_events DROP CONSTRAINT organization_paid_access_events_source_check;
    UPDATE organization_paid_access SET source='beta' WHERE source='granted';
    ALTER TABLE organization_paid_access_events DISABLE TRIGGER organization_paid_access_events_append_only;
    UPDATE organization_paid_access_events SET source='beta' WHERE source='granted';
    ALTER TABLE organization_paid_access_events ENABLE TRIGGER organization_paid_access_events_append_only;
    ALTER TABLE organization_paid_access
      ADD CONSTRAINT organization_paid_access_source_check CHECK(source IN ('beta','manual'));
    ALTER TABLE organization_paid_access_events
      ADD CONSTRAINT organization_paid_access_events_source_check CHECK(source IN ('beta','manual'));`);
}
