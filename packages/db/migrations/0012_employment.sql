CREATE TABLE "employment_business_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_business_objects_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_business_objects_employee_id" UNIQUE("tenant_id","employee_id","id"),
	CONSTRAINT "employment_business_objects_revision_positive" CHECK ("employment_business_objects"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "employment_custom_field_inheritance_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"previous_version_id" uuid,
	"inherit" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_custom_field_inheritance_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_custom_field_inheritance_versions_field_id" UNIQUE("tenant_id","field_id","id"),
	CONSTRAINT "employment_custom_field_inheritance_versions_number" UNIQUE("tenant_id","field_id","version_no"),
	CONSTRAINT "employment_custom_field_inheritance_versions_positive" CHECK ("employment_custom_field_inheritance_versions"."version_no" > 0),
	CONSTRAINT "employment_custom_field_inheritance_versions_not_self" CHECK ("employment_custom_field_inheritance_versions"."previous_version_id" <> "employment_custom_field_inheritance_versions"."id")
);
--> statement-breakpoint
CREATE TABLE "employment_custom_field_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"object_type" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"value_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_custom_field_objects_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_custom_field_objects_tenant_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "employment_custom_field_objects_revision_positive" CHECK ("employment_custom_field_objects"."revision" > 0),
	CONSTRAINT "employment_custom_field_objects_object_type" CHECK ("employment_custom_field_objects"."object_type" IN ('employment', 'contract')),
	CONSTRAINT "employment_custom_field_objects_value_type" CHECK ("employment_custom_field_objects"."value_type" IN ('text', 'integer', 'decimal', 'boolean', 'date')),
	CONSTRAINT "employment_custom_field_objects_code_nonempty" CHECK (btrim("employment_custom_field_objects"."code") <> ''),
	CONSTRAINT "employment_custom_field_objects_name_nonempty" CHECK (btrim("employment_custom_field_objects"."name") <> '')
);
--> statement-breakpoint
CREATE TABLE "employment_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"entry_type" text NOT NULL,
	"employ_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_cycles_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_cycles_employee_id" UNIQUE("tenant_id","employee_id","id"),
	CONSTRAINT "employment_cycles_employee_entry" UNIQUE("tenant_id","employee_id","id","entry_date"),
	CONSTRAINT "employment_cycles_entry_type" CHECK ("employment_cycles"."entry_type" IN ('hire', 'rehire', 'retire_rehire')),
	CONSTRAINT "employment_cycles_employ_type" CHECK ("employment_cycles"."employ_type" IN ('internal', 'intern', 'external')),
	CONSTRAINT "employment_cycles_entry_finite" CHECK (isfinite("employment_cycles"."entry_date"))
);
--> statement-breakpoint
CREATE TABLE "employment_employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_employees_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_employees_revision_positive" CHECK ("employment_employees"."revision" > 0),
	CONSTRAINT "employment_employees_code_nonempty" CHECK (btrim("employment_employees"."code") <> ''),
	CONSTRAINT "employment_employees_name_nonempty" CHECK (btrim("employment_employees"."name") <> '')
);
--> statement-breakpoint
CREATE TABLE "employment_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid,
	"business_id" uuid,
	"object_type" text NOT NULL,
	"object_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_outbox_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_outbox_command_event" UNIQUE("tenant_id","command_id","event_type","object_id"),
	CONSTRAINT "employment_outbox_object_nonempty" CHECK (btrim("employment_outbox"."object_type") <> ''),
	CONSTRAINT "employment_outbox_event_nonempty" CHECK (btrim("employment_outbox"."event_type") <> ''),
	CONSTRAINT "employment_outbox_payload_object" CHECK (jsonb_typeof("employment_outbox"."payload") = 'object'),
	CONSTRAINT "employment_outbox_state" CHECK ("employment_outbox"."state" IN ('pending', 'sent', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "employment_outbox_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outbox_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"error_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_outbox_attempts_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_outbox_attempts_number" UNIQUE("tenant_id","outbox_id","attempt_no"),
	CONSTRAINT "employment_outbox_attempts_number_positive" CHECK ("employment_outbox_attempts"."attempt_no" > 0),
	CONSTRAINT "employment_outbox_attempts_state" CHECK ("employment_outbox_attempts"."state" IN ('pending', 'sent', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "employment_payload_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"previous_version_id" uuid,
	"kind" text NOT NULL,
	"mode" text NOT NULL,
	"effective_date" date NOT NULL,
	"last_work_date" date,
	"form_id" text NOT NULL,
	"selected_staff_id" uuid,
	"source_record_id" uuid,
	"source_staff_id" uuid,
	"department_id" uuid,
	"position_id" uuid,
	"post_id" uuid,
	"level_id" uuid,
	"grade_id" uuid,
	"place" text,
	"direct_manager_id" uuid,
	"dotted_manager_id" uuid,
	"employment_type" text,
	"employ_type" text,
	"employment_source" text,
	"employment_form" text,
	"sequence_id" uuid,
	"professional_line_id" uuid,
	"is_key_person" boolean,
	"dimension1" text,
	"dimension2" text,
	"dimension3" text,
	"dimension4" text,
	"dimension5" text,
	"job_number" text,
	"remarks" text,
	"is_department_head" boolean,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deferred_field_codes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"explicit_field_codes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"form_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_payload_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_payload_versions_employee_id" UNIQUE("tenant_id","employee_id","id"),
	CONSTRAINT "employment_payload_versions_business_id" UNIQUE("tenant_id","employee_id","business_id","id"),
	CONSTRAINT "employment_payload_versions_business_version" UNIQUE("tenant_id","business_id","version_no"),
	CONSTRAINT "employment_payload_versions_employ_type" CHECK ("employment_payload_versions"."employ_type" IN ('internal', 'intern', 'external')),
	CONSTRAINT "employment_payload_versions_custom_object" CHECK (jsonb_typeof("employment_payload_versions"."custom_fields") = 'object'),
	CONSTRAINT "employment_payload_versions_kind" CHECK ("employment_payload_versions"."kind" IN ('hire', 'rehire', 'retire_rehire', 'regularization', 'transfer',
      'org_adjustment', 'leave', 'retirement', 'intern_regularization')),
	CONSTRAINT "employment_payload_versions_version_positive" CHECK ("employment_payload_versions"."version_no" > 0),
	CONSTRAINT "employment_payload_versions_previous_not_self" CHECK ("employment_payload_versions"."previous_version_id" <> "employment_payload_versions"."id"),
	CONSTRAINT "employment_payload_versions_mode" CHECK ("employment_payload_versions"."mode" IN ('direct', 'application')),
	CONSTRAINT "employment_payload_versions_form_nonempty" CHECK (btrim("employment_payload_versions"."form_id") <> ''),
	CONSTRAINT "employment_payload_versions_source_pair" CHECK (("employment_payload_versions"."source_record_id" IS NULL) = ("employment_payload_versions"."source_staff_id" IS NULL)),
	CONSTRAINT "employment_payload_versions_form_object" CHECK (jsonb_typeof("employment_payload_versions"."form_snapshot") = 'object'),
	CONSTRAINT "employment_payload_versions_date_finite" CHECK (isfinite("employment_payload_versions"."effective_date"))
);
--> statement-breakpoint
CREATE TABLE "employment_record_tombstones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_record_tombstones_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_record_tombstones_record" UNIQUE("tenant_id","record_id")
);
--> statement-breakpoint
CREATE TABLE "employment_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"payload_version_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"kind" text NOT NULL,
	"start_date" date NOT NULL,
	"last_work_date" date,
	"service_type" text DEFAULT 'primary' NOT NULL,
	"is_inserted" boolean DEFAULT false NOT NULL,
	"inheritance_source_id" uuid,
	"department_id" uuid,
	"position_id" uuid,
	"post_id" uuid,
	"level_id" uuid,
	"grade_id" uuid,
	"place" text,
	"direct_manager_id" uuid,
	"dotted_manager_id" uuid,
	"employment_type" text,
	"employ_type" text NOT NULL,
	"employment_source" text,
	"employment_form" text,
	"sequence_id" uuid,
	"professional_line_id" uuid,
	"is_key_person" boolean,
	"dimension1" text,
	"dimension2" text,
	"dimension3" text,
	"dimension4" text,
	"dimension5" text,
	"job_number" text,
	"remarks" text,
	"is_department_head" boolean,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_records_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_records_employee_id" UNIQUE("tenant_id","employee_id","id"),
	CONSTRAINT "employment_records_employee_staff" UNIQUE("tenant_id","employee_id","id","staff_id"),
	CONSTRAINT "employment_records_employee_start_id" UNIQUE("tenant_id","employee_id","id","start_date"),
	CONSTRAINT "employment_records_employ_type" CHECK ("employment_records"."employ_type" IN ('internal', 'intern', 'external')),
	CONSTRAINT "employment_records_custom_object" CHECK (jsonb_typeof("employment_records"."custom_fields") = 'object'),
	CONSTRAINT "employment_records_kind" CHECK ("employment_records"."kind" IN ('hire', 'rehire', 'retire_rehire', 'regularization', 'transfer',
      'org_adjustment', 'leave', 'retirement', 'intern_regularization')),
	CONSTRAINT "employment_records_primary_only" CHECK ("employment_records"."service_type" = 'primary'),
	CONSTRAINT "employment_records_start_valid" CHECK (isfinite("employment_records"."start_date") AND "employment_records"."start_date" >= "employment_records"."entry_date"),
	CONSTRAINT "employment_records_source_not_self" CHECK ("employment_records"."inheritance_source_id" <> "employment_records"."id")
);
--> statement-breakpoint
CREATE TABLE "employment_setting_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"previous_version_id" uuid,
	"allow_direct_transfer" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_setting_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_setting_versions_number" UNIQUE("tenant_id","version_no"),
	CONSTRAINT "employment_setting_versions_positive" CHECK ("employment_setting_versions"."version_no" > 0),
	CONSTRAINT "employment_setting_versions_not_self" CHECK ("employment_setting_versions"."previous_version_id" <> "employment_setting_versions"."id")
);
--> statement-breakpoint
CREATE TABLE "employment_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_settings_revision_nonnegative" CHECK ("employment_settings"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "employment_state_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"payload_version_id" uuid NOT NULL,
	"state" text NOT NULL,
	"event_no" integer NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_state_events_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "employment_state_events_business_number" UNIQUE("tenant_id","business_id","event_no"),
	CONSTRAINT "employment_state_events_number_positive" CHECK ("employment_state_events"."event_no" > 0),
	CONSTRAINT "employment_state_events_state" CHECK ("employment_state_events"."state" IN ('draft', 'in_review', 'approved', 'rejected', 'effective', 'deleted')),
	CONSTRAINT "employment_state_events_command_nonempty" CHECK (btrim("employment_state_events"."command_id") <> '')
);
--> statement-breakpoint
CREATE TABLE "employment_timeline" (
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 1 NOT NULL,
	"start_date" date NOT NULL,
	"valid_during" daterange NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_timeline_tenant_id_record_id_pk" PRIMARY KEY("tenant_id","record_id"),
	CONSTRAINT "employment_timeline_cycle_start" UNIQUE("tenant_id","employee_id","staff_id","start_date"),
	CONSTRAINT "employment_timeline_lower_matches" CHECK (isempty("employment_timeline"."valid_during") OR (NOT lower_inf("employment_timeline"."valid_during")
        AND lower("employment_timeline"."valid_during") = "employment_timeline"."start_date")),
	CONSTRAINT "employment_timeline_sort_order" CHECK ("employment_timeline"."sort_order" IN (0, 1))
);
--> statement-breakpoint
ALTER TABLE "employment_business_objects" ADD CONSTRAINT "employment_business_objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_business_objects" ADD CONSTRAINT "employment_business_objects_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_custom_field_inheritance_versions" ADD CONSTRAINT "employment_custom_field_inheritance_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_custom_field_inheritance_versions" ADD CONSTRAINT "employment_custom_field_inheritance_versions_field_fk" FOREIGN KEY ("tenant_id","field_id") REFERENCES "public"."employment_custom_field_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_custom_field_inheritance_versions" ADD CONSTRAINT "employment_custom_field_inheritance_versions_previous_fk" FOREIGN KEY ("tenant_id","field_id","previous_version_id") REFERENCES "public"."employment_custom_field_inheritance_versions"("tenant_id","field_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_custom_field_objects" ADD CONSTRAINT "employment_custom_field_objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_cycles" ADD CONSTRAINT "employment_cycles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_cycles" ADD CONSTRAINT "employment_cycles_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_employees" ADD CONSTRAINT "employment_employees_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_outbox" ADD CONSTRAINT "employment_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_outbox" ADD CONSTRAINT "employment_outbox_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_outbox" ADD CONSTRAINT "employment_outbox_business_fk" FOREIGN KEY ("tenant_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_outbox" ADD CONSTRAINT "employment_outbox_employee_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_outbox_attempts" ADD CONSTRAINT "employment_outbox_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_outbox_attempts" ADD CONSTRAINT "employment_outbox_attempts_outbox_fk" FOREIGN KEY ("tenant_id","outbox_id") REFERENCES "public"."employment_outbox"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_previous_fk" FOREIGN KEY ("tenant_id","employee_id","business_id","previous_version_id") REFERENCES "public"."employment_payload_versions"("tenant_id","employee_id","business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_selected_cycle_fk" FOREIGN KEY ("tenant_id","employee_id","selected_staff_id") REFERENCES "public"."employment_cycles"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_source_fk" FOREIGN KEY ("tenant_id","employee_id","source_record_id","source_staff_id") REFERENCES "public"."employment_records"("tenant_id","employee_id","id","staff_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_department_fk" FOREIGN KEY ("tenant_id","department_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "public"."job_position_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_post_fk" FOREIGN KEY ("tenant_id","post_id") REFERENCES "public"."job_post_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_level_fk" FOREIGN KEY ("tenant_id","level_id") REFERENCES "public"."job_level_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_grade_fk" FOREIGN KEY ("tenant_id","grade_id") REFERENCES "public"."job_grade_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_direct_manager_fk" FOREIGN KEY ("tenant_id","direct_manager_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_dotted_manager_fk" FOREIGN KEY ("tenant_id","dotted_manager_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_sequence_fk" FOREIGN KEY ("tenant_id","sequence_id") REFERENCES "public"."job_sequence_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_professional_line_fk" FOREIGN KEY ("tenant_id","professional_line_id") REFERENCES "public"."job_professional_line_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_record_tombstones" ADD CONSTRAINT "employment_record_tombstones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_record_tombstones" ADD CONSTRAINT "employment_record_tombstones_record_fk" FOREIGN KEY ("tenant_id","employee_id","record_id") REFERENCES "public"."employment_records"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_payload_fk" FOREIGN KEY ("tenant_id","employee_id","id","payload_version_id") REFERENCES "public"."employment_payload_versions"("tenant_id","employee_id","business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_cycle_fk" FOREIGN KEY ("tenant_id","employee_id","staff_id","entry_date") REFERENCES "public"."employment_cycles"("tenant_id","employee_id","id","entry_date") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_inheritance_source_fk" FOREIGN KEY ("tenant_id","employee_id","inheritance_source_id") REFERENCES "public"."employment_records"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_department_fk" FOREIGN KEY ("tenant_id","department_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "public"."job_position_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_post_fk" FOREIGN KEY ("tenant_id","post_id") REFERENCES "public"."job_post_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_level_fk" FOREIGN KEY ("tenant_id","level_id") REFERENCES "public"."job_level_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_grade_fk" FOREIGN KEY ("tenant_id","grade_id") REFERENCES "public"."job_grade_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_direct_manager_fk" FOREIGN KEY ("tenant_id","direct_manager_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_dotted_manager_fk" FOREIGN KEY ("tenant_id","dotted_manager_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_sequence_fk" FOREIGN KEY ("tenant_id","sequence_id") REFERENCES "public"."job_sequence_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_records" ADD CONSTRAINT "employment_records_professional_line_fk" FOREIGN KEY ("tenant_id","professional_line_id") REFERENCES "public"."job_professional_line_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_setting_versions" ADD CONSTRAINT "employment_setting_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_setting_versions" ADD CONSTRAINT "employment_setting_versions_settings_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."employment_settings"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_setting_versions" ADD CONSTRAINT "employment_setting_versions_previous_fk" FOREIGN KEY ("tenant_id","previous_version_id") REFERENCES "public"."employment_setting_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_settings" ADD CONSTRAINT "employment_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_state_events" ADD CONSTRAINT "employment_state_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_state_events" ADD CONSTRAINT "employment_state_events_payload_fk" FOREIGN KEY ("tenant_id","employee_id","business_id","payload_version_id") REFERENCES "public"."employment_payload_versions"("tenant_id","employee_id","business_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_timeline" ADD CONSTRAINT "employment_timeline_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_timeline" ADD CONSTRAINT "employment_timeline_record_fk" FOREIGN KEY ("tenant_id","employee_id","record_id","staff_id") REFERENCES "public"."employment_records"("tenant_id","employee_id","id","staff_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employment_business_objects_employee_created" ON "employment_business_objects" USING btree ("tenant_id","employee_id","created_at","id");--> statement-breakpoint
CREATE INDEX "employment_custom_field_objects_tenant_type" ON "employment_custom_field_objects" USING btree ("tenant_id","object_type","id");--> statement-breakpoint
CREATE INDEX "employment_cycles_employee_date" ON "employment_cycles" USING btree ("tenant_id","employee_id","entry_date","id");--> statement-breakpoint
CREATE UNIQUE INDEX "employment_employees_tenant_code" ON "employment_employees" USING btree ("tenant_id",lower("code"));--> statement-breakpoint
CREATE INDEX "employment_employees_tenant_created" ON "employment_employees" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "employment_outbox_tenant_created" ON "employment_outbox" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "employment_outbox_employee_created" ON "employment_outbox" USING btree ("tenant_id","employee_id","created_at");--> statement-breakpoint
CREATE INDEX "employment_outbox_business_created" ON "employment_outbox" USING btree ("tenant_id","business_id","created_at");--> statement-breakpoint
CREATE INDEX "employment_outbox_attempts_pending" ON "employment_outbox_attempts" USING btree ("tenant_id","state","created_at");--> statement-breakpoint
CREATE INDEX "employment_records_position_start" ON "employment_records" USING btree ("tenant_id","position_id","start_date","employee_id");--> statement-breakpoint
CREATE INDEX "employment_timeline_employee_start" ON "employment_timeline" USING btree ("tenant_id","employee_id","start_date","sort_order");