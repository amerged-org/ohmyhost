-- Preserve legacy profile and quote bytes; new profiles are immutable from insertion.
ALTER TABLE preview_sessions ADD COLUMN provider_instance_type TEXT CHECK(provider_instance_type IS NULL OR provider_instance_type = 'standard-3');
CREATE TRIGGER preview_provider_profile_immutable BEFORE UPDATE ON preview_sessions
WHEN NEW.provider_instance_type IS NOT OLD.provider_instance_type
BEGIN SELECT RAISE(ABORT,'preview_provider_profile_immutable'); END;
