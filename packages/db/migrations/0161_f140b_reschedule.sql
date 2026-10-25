ALTER TABLE "employment_activation_attempts" DROP CONSTRAINT "employment_activation_attempts_outcome";--> statement-breakpoint
ALTER TABLE "employment_activation_attempts" ADD CONSTRAINT "employment_activation_attempts_outcome" CHECK ("employment_activation_attempts"."outcome" IN ('effective', 'failed', 'suspended', 'replanned'));
--> statement-breakpoint
-- F-140：所有载荷写入均持业务头锁，序号必须大于本业务已有的最大序号；禁止回填乱序版本。
CREATE FUNCTION employment_payload_monotonic_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM 1 FROM employment_business_objects
    WHERE tenant_id=NEW.tenant_id AND id=NEW.business_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM employment_payload_versions
    WHERE tenant_id=NEW.tenant_id AND business_id=NEW.business_id AND version_no>=NEW.version_no) THEN
    RAISE EXCEPTION 'employment payload version must increase' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER employment_payload_monotonic_version BEFORE INSERT ON employment_payload_versions
  FOR EACH ROW EXECUTE FUNCTION employment_payload_monotonic_version();
