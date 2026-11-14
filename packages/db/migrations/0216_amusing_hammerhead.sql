ALTER TABLE "employment_custom_field_objects" DROP CONSTRAINT "employment_custom_field_objects_value_type";--> statement-breakpoint
ALTER TABLE "employment_custom_field_objects" ADD COLUMN "options" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "employment_custom_field_objects" ADD CONSTRAINT "employment_custom_field_options_array" CHECK (jsonb_typeof("employment_custom_field_objects"."options") = 'array');--> statement-breakpoint
ALTER TABLE "employment_custom_field_objects" ADD CONSTRAINT "employment_custom_field_select_options" CHECK (("employment_custom_field_objects"."value_type" = 'select') = (jsonb_array_length("employment_custom_field_objects"."options") > 0));--> statement-breakpoint
ALTER TABLE "employment_custom_field_objects" ADD CONSTRAINT "employment_custom_field_objects_value_type" CHECK ("employment_custom_field_objects"."value_type" IN ('text', 'integer', 'decimal', 'boolean', 'date', 'select'));--> statement-breakpoint
-- F-474-6a §3.1 / DEC-896：仅定义表放开选项，其他元数据继续由专用触发器保护。
CREATE OR REPLACE FUNCTION protect_employment_custom_field_metadata() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['revision','options']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['revision','options']) THEN
    RAISE EXCEPTION 'custom field identity fields are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
GRANT UPDATE (revision, options) ON employment_custom_field_objects TO app_user;
