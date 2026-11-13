ALTER TABLE "employment_custom_field_objects" DROP CONSTRAINT "employment_custom_field_objects_object_type";--> statement-breakpoint
ALTER TABLE "employment_custom_field_objects" ADD CONSTRAINT "employment_custom_field_objects_object_type" CHECK ("employment_custom_field_objects"."object_type" IN ('employment', 'contract', 'organization', 'personnel'));
--> statement-breakpoint
-- F-474-6a §3.1 / DEC-893：定义表单独保护元数据，本轮只允许 revision 更新。
CREATE FUNCTION protect_employment_custom_field_metadata() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (to_jsonb(NEW) - 'revision') IS DISTINCT FROM (to_jsonb(OLD) - 'revision') THEN
    RAISE EXCEPTION 'custom field identity fields are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER employment_custom_field_objects_metadata_only ON employment_custom_field_objects;
--> statement-breakpoint
CREATE TRIGGER employment_custom_field_objects_metadata_only
  BEFORE UPDATE ON employment_custom_field_objects
  FOR EACH ROW EXECUTE FUNCTION protect_employment_custom_field_metadata();
--> statement-breakpoint
GRANT UPDATE (revision) ON employment_custom_field_objects TO app_user;
