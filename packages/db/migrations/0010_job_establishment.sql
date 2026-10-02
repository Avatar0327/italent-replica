-- Drizzle 生成；0009 已执行的六条组织 DDL 因旧快照未同步而重复，核对后仅从本迁移剔除。
CREATE TABLE "job_grade_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_grade_objects_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_grade_objects_revision_positive" CHECK ("job_grade_objects"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "job_grade_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"previous_version_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"stop_date" date DEFAULT '9999-12-31' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"established_on" date,
	"display_order" integer,
	"qualification_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"grade" integer,
	"score_low" numeric,
	"score_high" numeric,
	"layer_id" uuid,
	CONSTRAINT "job_grade_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_grade_versions_tenant_object_id" UNIQUE("tenant_id","object_id","id"),
	CONSTRAINT "job_grade_versions_tenant_object_version" UNIQUE("tenant_id","object_id","version_no"),
	CONSTRAINT "job_grade_versions_version_positive" CHECK ("job_grade_versions"."version_no" > 0),
	CONSTRAINT "job_grade_versions_code_nonempty" CHECK (btrim("job_grade_versions"."code") <> ''),
	CONSTRAINT "job_grade_versions_name_nonempty" CHECK (btrim("job_grade_versions"."name") <> ''),
	CONSTRAINT "job_grade_versions_dates_valid" CHECK ("job_grade_versions"."stop_date" >= "job_grade_versions"."start_date"),
	CONSTRAINT "job_grade_versions_previous_not_self" CHECK ("job_grade_versions"."previous_version_id" <> "job_grade_versions"."id"),
	CONSTRAINT "job_grade_versions_scores_valid" CHECK ("job_grade_versions"."score_high" >= "job_grade_versions"."score_low")
);
--> statement-breakpoint
CREATE TABLE "job_import_mappings" (
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_code" text NOT NULL,
	"layer_id" uuid,
	"grade_id" uuid,
	"level_type_id" uuid,
	"level_id" uuid,
	"sequence_id" uuid,
	"professional_line_id" uuid,
	"post_id" uuid,
	"position_id" uuid,
	CONSTRAINT "job_import_mappings_tenant_id_kind_source_code_pk" PRIMARY KEY("tenant_id","kind","source_code"),
	CONSTRAINT "job_import_mappings_target_valid" CHECK (num_nonnulls("job_import_mappings"."layer_id", "job_import_mappings"."grade_id", "job_import_mappings"."level_type_id", "job_import_mappings"."level_id",
    "job_import_mappings"."sequence_id", "job_import_mappings"."professional_line_id", "job_import_mappings"."post_id", "job_import_mappings"."position_id") = 1 AND (
    ("job_import_mappings"."kind" = 'layers' AND "job_import_mappings"."layer_id" IS NOT NULL) OR
    ("job_import_mappings"."kind" = 'grades' AND "job_import_mappings"."grade_id" IS NOT NULL) OR
    ("job_import_mappings"."kind" = 'level-types' AND "job_import_mappings"."level_type_id" IS NOT NULL) OR
    ("job_import_mappings"."kind" = 'levels' AND "job_import_mappings"."level_id" IS NOT NULL) OR
    ("job_import_mappings"."kind" = 'sequences' AND "job_import_mappings"."sequence_id" IS NOT NULL) OR
    ("job_import_mappings"."kind" = 'professional-lines' AND "job_import_mappings"."professional_line_id" IS NOT NULL) OR
    ("job_import_mappings"."kind" = 'posts' AND "job_import_mappings"."post_id" IS NOT NULL) OR
    ("job_import_mappings"."kind" = 'positions' AND "job_import_mappings"."position_id" IS NOT NULL)
  ))
);
--> statement-breakpoint
CREATE TABLE "job_import_results" (
	"tenant_id" uuid NOT NULL,
	"command_id" text NOT NULL,
	"row_index" integer NOT NULL,
	"kind" text NOT NULL,
	"source_code" text NOT NULL,
	"code" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"layer_id" uuid,
	"grade_id" uuid,
	"level_type_id" uuid,
	"level_id" uuid,
	"sequence_id" uuid,
	"professional_line_id" uuid,
	"post_id" uuid,
	"position_id" uuid,
	CONSTRAINT "job_import_results_tenant_id_command_id_row_index_pk" PRIMARY KEY("tenant_id","command_id","row_index"),
	CONSTRAINT "job_import_results_status_valid" CHECK ("job_import_results"."status" IN ('created', 'updated', 'conflict')),
	CONSTRAINT "job_import_results_row_index_valid" CHECK ("job_import_results"."row_index" >= 0),
	CONSTRAINT "job_import_results_kind_valid" CHECK ("job_import_results"."kind" IN
      ('layers', 'grades', 'level-types', 'levels', 'sequences', 'professional-lines', 'posts', 'positions')),
	CONSTRAINT "job_import_results_target_valid" CHECK (
      ("job_import_results"."status" = 'conflict' AND num_nonnulls("job_import_results"."layer_id", "job_import_results"."grade_id", "job_import_results"."level_type_id", "job_import_results"."level_id",
    "job_import_results"."sequence_id", "job_import_results"."professional_line_id", "job_import_results"."post_id", "job_import_results"."position_id") = 0) OR
      (num_nonnulls("job_import_results"."layer_id", "job_import_results"."grade_id", "job_import_results"."level_type_id", "job_import_results"."level_id",
    "job_import_results"."sequence_id", "job_import_results"."professional_line_id", "job_import_results"."post_id", "job_import_results"."position_id") = 1 AND (
    ("job_import_results"."kind" = 'layers' AND "job_import_results"."layer_id" IS NOT NULL) OR
    ("job_import_results"."kind" = 'grades' AND "job_import_results"."grade_id" IS NOT NULL) OR
    ("job_import_results"."kind" = 'level-types' AND "job_import_results"."level_type_id" IS NOT NULL) OR
    ("job_import_results"."kind" = 'levels' AND "job_import_results"."level_id" IS NOT NULL) OR
    ("job_import_results"."kind" = 'sequences' AND "job_import_results"."sequence_id" IS NOT NULL) OR
    ("job_import_results"."kind" = 'professional-lines' AND "job_import_results"."professional_line_id" IS NOT NULL) OR
    ("job_import_results"."kind" = 'posts' AND "job_import_results"."post_id" IS NOT NULL) OR
    ("job_import_results"."kind" = 'positions' AND "job_import_results"."position_id" IS NOT NULL)
  )))
);
--> statement-breakpoint
CREATE TABLE "job_layer_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_layer_objects_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_layer_objects_revision_positive" CHECK ("job_layer_objects"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "job_layer_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"previous_version_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"stop_date" date DEFAULT '9999-12-31' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"established_on" date,
	"display_order" integer,
	"qualification_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"layer_level" integer,
	CONSTRAINT "job_layer_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_layer_versions_tenant_object_id" UNIQUE("tenant_id","object_id","id"),
	CONSTRAINT "job_layer_versions_tenant_object_version" UNIQUE("tenant_id","object_id","version_no"),
	CONSTRAINT "job_layer_versions_version_positive" CHECK ("job_layer_versions"."version_no" > 0),
	CONSTRAINT "job_layer_versions_code_nonempty" CHECK (btrim("job_layer_versions"."code") <> ''),
	CONSTRAINT "job_layer_versions_name_nonempty" CHECK (btrim("job_layer_versions"."name") <> ''),
	CONSTRAINT "job_layer_versions_dates_valid" CHECK ("job_layer_versions"."stop_date" >= "job_layer_versions"."start_date"),
	CONSTRAINT "job_layer_versions_previous_not_self" CHECK ("job_layer_versions"."previous_version_id" <> "job_layer_versions"."id")
);
--> statement-breakpoint
CREATE TABLE "job_level_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_level_objects_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_level_objects_revision_positive" CHECK ("job_level_objects"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "job_level_type_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_level_type_objects_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_level_type_objects_revision_positive" CHECK ("job_level_type_objects"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "job_level_type_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"previous_version_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"stop_date" date DEFAULT '9999-12-31' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"established_on" date,
	"display_order" integer,
	"qualification_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_level_type_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_level_type_versions_tenant_object_id" UNIQUE("tenant_id","object_id","id"),
	CONSTRAINT "job_level_type_versions_tenant_object_version" UNIQUE("tenant_id","object_id","version_no"),
	CONSTRAINT "job_level_type_versions_version_positive" CHECK ("job_level_type_versions"."version_no" > 0),
	CONSTRAINT "job_level_type_versions_code_nonempty" CHECK (btrim("job_level_type_versions"."code") <> ''),
	CONSTRAINT "job_level_type_versions_name_nonempty" CHECK (btrim("job_level_type_versions"."name") <> ''),
	CONSTRAINT "job_level_type_versions_dates_valid" CHECK ("job_level_type_versions"."stop_date" >= "job_level_type_versions"."start_date"),
	CONSTRAINT "job_level_type_versions_previous_not_self" CHECK ("job_level_type_versions"."previous_version_id" <> "job_level_type_versions"."id")
);
--> statement-breakpoint
CREATE TABLE "job_level_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"previous_version_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"stop_date" date DEFAULT '9999-12-31' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"established_on" date,
	"display_order" integer,
	"qualification_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"level" integer,
	"level_type_id" uuid,
	"min_grade_id" uuid,
	"max_grade_id" uuid,
	CONSTRAINT "job_level_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_level_versions_tenant_object_id" UNIQUE("tenant_id","object_id","id"),
	CONSTRAINT "job_level_versions_tenant_object_version" UNIQUE("tenant_id","object_id","version_no"),
	CONSTRAINT "job_level_versions_version_positive" CHECK ("job_level_versions"."version_no" > 0),
	CONSTRAINT "job_level_versions_code_nonempty" CHECK (btrim("job_level_versions"."code") <> ''),
	CONSTRAINT "job_level_versions_name_nonempty" CHECK (btrim("job_level_versions"."name") <> ''),
	CONSTRAINT "job_level_versions_dates_valid" CHECK ("job_level_versions"."stop_date" >= "job_level_versions"."start_date"),
	CONSTRAINT "job_level_versions_previous_not_self" CHECK ("job_level_versions"."previous_version_id" <> "job_level_versions"."id")
);
--> statement-breakpoint
CREATE TABLE "job_position_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_position_objects_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_position_objects_revision_positive" CHECK ("job_position_objects"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "job_position_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"previous_version_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"stop_date" date DEFAULT '9999-12-31' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"established_on" date,
	"display_order" integer,
	"qualification_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sequence_id" uuid,
	"professional_line_id" uuid,
	"level_type_id" uuid,
	"min_level_id" uuid,
	"max_level_id" uuid,
	"min_grade_id" uuid,
	"max_grade_id" uuid,
	"org_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"direct_parent_id" uuid,
	"dotted_parent_id" uuid,
	"direct_sequence" integer,
	"dotted_sequence" integer,
	"standard_position_id" uuid,
	"work_location" text,
	"is_key" boolean DEFAULT false NOT NULL,
	"is_confidential" boolean DEFAULT false NOT NULL,
	"sync_sequence_to_assignments" boolean DEFAULT false NOT NULL,
	CONSTRAINT "job_position_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_position_versions_tenant_object_id" UNIQUE("tenant_id","object_id","id"),
	CONSTRAINT "job_position_versions_tenant_object_version" UNIQUE("tenant_id","object_id","version_no"),
	CONSTRAINT "job_position_versions_version_positive" CHECK ("job_position_versions"."version_no" > 0),
	CONSTRAINT "job_position_versions_code_nonempty" CHECK (btrim("job_position_versions"."code") <> ''),
	CONSTRAINT "job_position_versions_name_nonempty" CHECK (btrim("job_position_versions"."name") <> ''),
	CONSTRAINT "job_position_versions_dates_valid" CHECK ("job_position_versions"."stop_date" >= "job_position_versions"."start_date"),
	CONSTRAINT "job_position_versions_previous_not_self" CHECK ("job_position_versions"."previous_version_id" <> "job_position_versions"."id"),
	CONSTRAINT "job_position_versions_direct_not_self" CHECK ("job_position_versions"."direct_parent_id" <> "job_position_versions"."object_id"),
	CONSTRAINT "job_position_versions_dotted_not_self" CHECK ("job_position_versions"."dotted_parent_id" <> "job_position_versions"."object_id")
);
--> statement-breakpoint
CREATE TABLE "job_post_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_post_objects_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_post_objects_revision_positive" CHECK ("job_post_objects"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "job_post_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"previous_version_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"stop_date" date DEFAULT '9999-12-31' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"established_on" date,
	"display_order" integer,
	"qualification_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sequence_id" uuid,
	"professional_line_id" uuid,
	"level_type_id" uuid,
	"min_level_id" uuid,
	"max_level_id" uuid,
	"min_grade_id" uuid,
	"max_grade_id" uuid,
	"competency_model_id" uuid,
	"responsibilities" text,
	"requirements" text,
	"is_key" boolean DEFAULT false NOT NULL,
	"is_confidential" boolean DEFAULT false NOT NULL,
	"evaluation_score" numeric,
	"sync_sequence_to_assignments" boolean DEFAULT false NOT NULL,
	CONSTRAINT "job_post_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_post_versions_tenant_object_id" UNIQUE("tenant_id","object_id","id"),
	CONSTRAINT "job_post_versions_tenant_object_version" UNIQUE("tenant_id","object_id","version_no"),
	CONSTRAINT "job_post_versions_version_positive" CHECK ("job_post_versions"."version_no" > 0),
	CONSTRAINT "job_post_versions_code_nonempty" CHECK (btrim("job_post_versions"."code") <> ''),
	CONSTRAINT "job_post_versions_name_nonempty" CHECK (btrim("job_post_versions"."name") <> ''),
	CONSTRAINT "job_post_versions_dates_valid" CHECK ("job_post_versions"."stop_date" >= "job_post_versions"."start_date"),
	CONSTRAINT "job_post_versions_previous_not_self" CHECK ("job_post_versions"."previous_version_id" <> "job_post_versions"."id")
);
--> statement-breakpoint
CREATE TABLE "job_professional_line_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_professional_line_objects_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_professional_line_objects_revision_positive" CHECK ("job_professional_line_objects"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "job_professional_line_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"previous_version_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"stop_date" date DEFAULT '9999-12-31' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"established_on" date,
	"display_order" integer,
	"qualification_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parent_id" uuid,
	"level" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "job_professional_line_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_professional_line_versions_tenant_object_id" UNIQUE("tenant_id","object_id","id"),
	CONSTRAINT "job_professional_line_versions_tenant_object_version" UNIQUE("tenant_id","object_id","version_no"),
	CONSTRAINT "job_professional_line_versions_version_positive" CHECK ("job_professional_line_versions"."version_no" > 0),
	CONSTRAINT "job_professional_line_versions_code_nonempty" CHECK (btrim("job_professional_line_versions"."code") <> ''),
	CONSTRAINT "job_professional_line_versions_name_nonempty" CHECK (btrim("job_professional_line_versions"."name") <> ''),
	CONSTRAINT "job_professional_line_versions_dates_valid" CHECK ("job_professional_line_versions"."stop_date" >= "job_professional_line_versions"."start_date"),
	CONSTRAINT "job_professional_line_versions_previous_not_self" CHECK ("job_professional_line_versions"."previous_version_id" <> "job_professional_line_versions"."id"),
	CONSTRAINT "job_professional_line_versions_level_valid" CHECK ("job_professional_line_versions"."level" >= 1),
	CONSTRAINT "job_professional_line_versions_parent_not_self" CHECK ("job_professional_line_versions"."parent_id" <> "job_professional_line_versions"."object_id")
);
--> statement-breakpoint
CREATE TABLE "job_sequence_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_sequence_objects_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_sequence_objects_revision_positive" CHECK ("job_sequence_objects"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "job_sequence_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"previous_version_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"stop_date" date DEFAULT '9999-12-31' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"established_on" date,
	"display_order" integer,
	"qualification_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parent_id" uuid,
	"level" integer DEFAULT 1 NOT NULL,
	"first_sequence_id" uuid,
	"second_sequence_id" uuid,
	"third_sequence_id" uuid,
	"fourth_sequence_id" uuid,
	"fifth_sequence_id" uuid,
	"sixth_sequence_id" uuid,
	"seventh_sequence_id" uuid,
	"eighth_sequence_id" uuid,
	"ninth_sequence_id" uuid,
	"tenth_sequence_id" uuid,
	"level_type_id" uuid,
	"source" text,
	"external_id" text,
	CONSTRAINT "job_sequence_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_sequence_versions_tenant_object_id" UNIQUE("tenant_id","object_id","id"),
	CONSTRAINT "job_sequence_versions_tenant_object_version" UNIQUE("tenant_id","object_id","version_no"),
	CONSTRAINT "job_sequence_versions_version_positive" CHECK ("job_sequence_versions"."version_no" > 0),
	CONSTRAINT "job_sequence_versions_code_nonempty" CHECK (btrim("job_sequence_versions"."code") <> ''),
	CONSTRAINT "job_sequence_versions_name_nonempty" CHECK (btrim("job_sequence_versions"."name") <> ''),
	CONSTRAINT "job_sequence_versions_dates_valid" CHECK ("job_sequence_versions"."stop_date" >= "job_sequence_versions"."start_date"),
	CONSTRAINT "job_sequence_versions_previous_not_self" CHECK ("job_sequence_versions"."previous_version_id" <> "job_sequence_versions"."id"),
	CONSTRAINT "job_sequence_versions_level_valid" CHECK ("job_sequence_versions"."level" BETWEEN 1 AND 10),
	CONSTRAINT "job_sequence_versions_parent_not_self" CHECK ("job_sequence_versions"."parent_id" <> "job_sequence_versions"."object_id")
);
--> statement-breakpoint
CREATE TABLE "job_settings_objects" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_settings_objects_revision_valid" CHECK ("job_settings_objects"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "job_settings_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"previous_version_id" uuid,
	"start_date" date NOT NULL,
	"stop_date" date DEFAULT '9999-12-31' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"allow_duplicate_position_names" boolean DEFAULT false NOT NULL,
	"adjust_employee_direct_manager" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_settings_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_settings_versions_tenant_version" UNIQUE("tenant_id","version_no"),
	CONSTRAINT "job_settings_versions_version_positive" CHECK ("job_settings_versions"."version_no" > 0),
	CONSTRAINT "job_settings_versions_dates_valid" CHECK ("job_settings_versions"."stop_date" >= "job_settings_versions"."start_date"),
	CONSTRAINT "job_settings_versions_previous_not_self" CHECK ("job_settings_versions"."previous_version_id" <> "job_settings_versions"."id")
);
--> statement-breakpoint
CREATE TABLE "establishment_copy_job_items" (
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"capacity_id" uuid NOT NULL,
	CONSTRAINT "establishment_copy_job_items_tenant_id_job_id_capacity_id_pk" PRIMARY KEY("tenant_id","job_id","capacity_id")
);
--> statement-breakpoint
CREATE TABLE "establishment_copy_job_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"previous_version_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "est_copy_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "est_copy_versions_tenant_object_id" UNIQUE("tenant_id","job_id","id"),
	CONSTRAINT "est_copy_versions_tenant_number" UNIQUE("tenant_id","job_id","version_no"),
	CONSTRAINT "est_copy_versions_number_positive" CHECK ("establishment_copy_job_versions"."version_no" > 0),
	CONSTRAINT "est_copy_versions_status_valid" CHECK ("establishment_copy_job_versions"."status" IN ('pending', 'succeeded', 'failed')),
	CONSTRAINT "est_copy_versions_attempts_nonnegative" CHECK ("establishment_copy_job_versions"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "establishment_copy_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "est_copy_jobs_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "est_copy_jobs_revision_positive" CHECK ("establishment_copy_jobs"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "establishment_movement_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "est_movement_objects_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "est_movement_objects_business_id" UNIQUE("tenant_id","business_id"),
	CONSTRAINT "est_movement_objects_business_nonempty" CHECK (btrim("establishment_movement_objects"."business_id") <> ''),
	CONSTRAINT "est_movement_objects_revision_positive" CHECK ("establishment_movement_objects"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "establishment_movement_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"movement_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"previous_version_id" uuid,
	"status" text NOT NULL,
	"source_org_id" uuid NOT NULL,
	"target_org_id" uuid NOT NULL,
	"source_position_id" uuid,
	"target_position_id" uuid,
	"employee_id" uuid NOT NULL,
	"effective_date" date NOT NULL,
	"reserve_in" boolean DEFAULT false NOT NULL,
	"reserve_out" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "est_movement_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "est_movement_versions_tenant_object_id" UNIQUE("tenant_id","movement_id","id"),
	CONSTRAINT "est_movement_versions_tenant_number" UNIQUE("tenant_id","movement_id","version_no"),
	CONSTRAINT "est_movement_versions_number_positive" CHECK ("establishment_movement_versions"."version_no" > 0),
	CONSTRAINT "est_movement_versions_status_valid" CHECK ("establishment_movement_versions"."status" IN
      ('submitted', 'approved', 'rejected', 'withdrawn', 'effective', 'failed')),
	CONSTRAINT "est_movement_versions_attempts_nonnegative" CHECK ("establishment_movement_versions"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "establishment_notification_delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"notification_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "est_notice_delivery_tenant_attempt" UNIQUE("tenant_id","notification_id","attempt"),
	CONSTRAINT "est_notice_delivery_attempt_positive" CHECK ("establishment_notification_delivery_attempts"."attempt" > 0),
	CONSTRAINT "est_notice_delivery_status_valid" CHECK ("establishment_notification_delivery_attempts"."status" IN ('pending', 'sent', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "establishment_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid,
	"movement_id" uuid,
	"recipient_user_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "est_notifications_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "est_notifications_status_valid" CHECK ("establishment_notifications"."status" IN ('pending', 'sent', 'failed', 'unknown')),
	CONSTRAINT "est_notifications_attempt_nonnegative" CHECK ("establishment_notifications"."attempt" >= 0)
);
--> statement-breakpoint
CREATE TABLE "establishment_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"scheme_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "est_objects_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "est_objects_tenant_period" UNIQUE("tenant_id","org_id","scheme_id","period_start"),
	CONSTRAINT "est_objects_period_valid" CHECK ("establishment_objects"."period_end" >= "establishment_objects"."period_start"),
	CONSTRAINT "est_objects_revision_positive" CHECK ("establishment_objects"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "establishment_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"object_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "est_outbox_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "est_outbox_event_nonempty" CHECK (btrim("establishment_outbox"."event_type") <> ''),
	CONSTRAINT "est_outbox_object_nonempty" CHECK (btrim("establishment_outbox"."object_id") <> ''),
	CONSTRAINT "est_outbox_state_valid" CHECK ("establishment_outbox"."state" IN ('pending', 'sent', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "establishment_outbox_delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"outbox_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"state" text NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "est_outbox_delivery_tenant_attempt" UNIQUE("tenant_id","outbox_id","attempt"),
	CONSTRAINT "est_outbox_delivery_attempt_positive" CHECK ("establishment_outbox_delivery_attempts"."attempt" > 0),
	CONSTRAINT "est_outbox_delivery_state_valid" CHECK ("establishment_outbox_delivery_attempts"."state" IN ('pending', 'sent', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "establishment_scheme_exclusions" (
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	CONSTRAINT "establishment_scheme_exclusions_tenant_id_version_id_org_id_pk" PRIMARY KEY("tenant_id","version_id","org_id")
);
--> statement-breakpoint
CREATE TABLE "establishment_scheme_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "est_scheme_objects_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "est_scheme_objects_revision_positive" CHECK ("establishment_scheme_objects"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "establishment_scheme_ranges" (
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"employment_type" text NOT NULL,
	CONSTRAINT "establishment_scheme_ranges_tenant_id_version_id_ordinal_pk" PRIMARY KEY("tenant_id","version_id","ordinal"),
	CONSTRAINT "est_scheme_ranges_ordinal_valid" CHECK ("establishment_scheme_ranges"."ordinal" BETWEEN 0 AND 4),
	CONSTRAINT "est_scheme_ranges_type_nonempty" CHECK (btrim("establishment_scheme_ranges"."employment_type") <> '')
);
--> statement-breakpoint
CREATE TABLE "establishment_scheme_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scheme_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"previous_version_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"cycle" text NOT NULL,
	"maintenance_mode" text NOT NULL,
	"start_month" integer DEFAULT 1 NOT NULL,
	"subdivision" text DEFAULT 'none' NOT NULL,
	"unmatched_policy" text DEFAULT 'organization' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"start_date" date NOT NULL,
	"stop_date" date DEFAULT '9999-12-31' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "est_scheme_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "est_scheme_versions_tenant_object_id" UNIQUE("tenant_id","scheme_id","id"),
	CONSTRAINT "est_scheme_versions_tenant_number" UNIQUE("tenant_id","scheme_id","version_no"),
	CONSTRAINT "est_scheme_versions_number_positive" CHECK ("establishment_scheme_versions"."version_no" > 0),
	CONSTRAINT "est_scheme_versions_code_nonempty" CHECK (btrim("establishment_scheme_versions"."code") <> ''),
	CONSTRAINT "est_scheme_versions_name_nonempty" CHECK (btrim("establishment_scheme_versions"."name") <> ''),
	CONSTRAINT "est_scheme_versions_cycle_valid" CHECK ("establishment_scheme_versions"."cycle" IN ('annual', 'quarterly', 'monthly')),
	CONSTRAINT "est_scheme_versions_mode_valid" CHECK ("establishment_scheme_versions"."maintenance_mode" IN ('local', 'inclusive', 'both')),
	CONSTRAINT "est_scheme_versions_start_month_valid" CHECK ("establishment_scheme_versions"."start_month" BETWEEN 1 AND 12),
	CONSTRAINT "est_scheme_versions_subdivision_valid" CHECK ("establishment_scheme_versions"."subdivision" IN ('none', 'position')),
	CONSTRAINT "est_scheme_versions_policy_valid" CHECK ("establishment_scheme_versions"."unmatched_policy" IN ('organization', 'reject')),
	CONSTRAINT "est_scheme_versions_dates_valid" CHECK ("establishment_scheme_versions"."stop_date" >= "establishment_scheme_versions"."start_date")
);
--> statement-breakpoint
CREATE TABLE "establishment_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "est_settings_revision_nonnegative" CHECK ("establishment_settings"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "establishment_subdivisions" (
	"tenant_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"local_capacity" integer,
	"inclusive_capacity" integer,
	CONSTRAINT "establishment_subdivisions_tenant_id_version_id_position_id_pk" PRIMARY KEY("tenant_id","version_id","position_id"),
	CONSTRAINT "est_subdivisions_local_nonnegative" CHECK ("establishment_subdivisions"."local_capacity" IS NULL OR "establishment_subdivisions"."local_capacity" >= 0),
	CONSTRAINT "est_subdivisions_inclusive_nonnegative" CHECK ("establishment_subdivisions"."inclusive_capacity" IS NULL OR "establishment_subdivisions"."inclusive_capacity" >= 0),
	CONSTRAINT "est_subdivisions_capacity_present" CHECK ("establishment_subdivisions"."local_capacity" IS NOT NULL OR "establishment_subdivisions"."inclusive_capacity" IS NOT NULL),
	CONSTRAINT "est_subdivisions_inclusive_ge_local" CHECK ("establishment_subdivisions"."inclusive_capacity" IS NULL OR "establishment_subdivisions"."local_capacity" IS NULL
      OR "establishment_subdivisions"."inclusive_capacity" >= "establishment_subdivisions"."local_capacity")
);
--> statement-breakpoint
CREATE TABLE "establishment_timing_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"previous_version_id" uuid,
	"start_date" date NOT NULL,
	"transfer_in" text NOT NULL,
	"transfer_out" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "est_timing_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "est_timing_versions_tenant_number" UNIQUE("tenant_id","version_no"),
	CONSTRAINT "est_timing_versions_number_positive" CHECK ("establishment_timing_versions"."version_no" > 0),
	CONSTRAINT "est_timing_versions_in_valid" CHECK ("establishment_timing_versions"."transfer_in" IN ('submitted', 'approved')),
	CONSTRAINT "est_timing_versions_out_valid" CHECK ("establishment_timing_versions"."transfer_out" IN ('submitted', 'approved'))
);
--> statement-breakpoint
CREATE TABLE "establishment_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"previous_version_id" uuid,
	"start_date" date NOT NULL,
	"local_capacity" integer,
	"inclusive_capacity" integer,
	"reserved_local" integer DEFAULT 0 NOT NULL,
	"reserved_inclusive" integer DEFAULT 0 NOT NULL,
	"strict_control" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "est_versions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "est_versions_tenant_object_id" UNIQUE("tenant_id","object_id","id"),
	CONSTRAINT "est_versions_tenant_number" UNIQUE("tenant_id","object_id","version_no"),
	CONSTRAINT "est_versions_number_positive" CHECK ("establishment_versions"."version_no" > 0),
	CONSTRAINT "est_versions_local_nonnegative" CHECK ("establishment_versions"."local_capacity" IS NULL OR "establishment_versions"."local_capacity" >= 0),
	CONSTRAINT "est_versions_inclusive_nonnegative" CHECK ("establishment_versions"."inclusive_capacity" IS NULL OR "establishment_versions"."inclusive_capacity" >= 0),
	CONSTRAINT "est_versions_reserved_nonnegative" CHECK ("establishment_versions"."reserved_local" >= 0 AND "establishment_versions"."reserved_inclusive" >= 0),
	CONSTRAINT "est_versions_capacity_present" CHECK ("establishment_versions"."local_capacity" IS NOT NULL OR "establishment_versions"."inclusive_capacity" IS NOT NULL),
	CONSTRAINT "est_versions_inclusive_ge_local" CHECK ("establishment_versions"."inclusive_capacity" IS NULL OR "establishment_versions"."local_capacity" IS NULL
      OR "establishment_versions"."inclusive_capacity" >= "establishment_versions"."local_capacity")
);
--> statement-breakpoint
ALTER TABLE "job_grade_objects" ADD CONSTRAINT "job_grade_objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_grade_versions" ADD CONSTRAINT "job_grade_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_grade_versions" ADD CONSTRAINT "job_grade_versions_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."job_grade_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_grade_versions" ADD CONSTRAINT "job_grade_versions_previous_fk" FOREIGN KEY ("tenant_id","object_id","previous_version_id") REFERENCES "public"."job_grade_versions"("tenant_id","object_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_grade_versions" ADD CONSTRAINT "job_grade_versions_layer_fk" FOREIGN KEY ("tenant_id","layer_id") REFERENCES "public"."job_layer_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_import_mappings" ADD CONSTRAINT "job_import_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_import_mappings" ADD CONSTRAINT "job_import_mappings_layer_fk" FOREIGN KEY ("tenant_id","layer_id") REFERENCES "public"."job_layer_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_import_mappings" ADD CONSTRAINT "job_import_mappings_grade_fk" FOREIGN KEY ("tenant_id","grade_id") REFERENCES "public"."job_grade_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_import_mappings" ADD CONSTRAINT "job_import_mappings_level_type_fk" FOREIGN KEY ("tenant_id","level_type_id") REFERENCES "public"."job_level_type_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_import_mappings" ADD CONSTRAINT "job_import_mappings_level_fk" FOREIGN KEY ("tenant_id","level_id") REFERENCES "public"."job_level_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_import_mappings" ADD CONSTRAINT "job_import_mappings_sequence_fk" FOREIGN KEY ("tenant_id","sequence_id") REFERENCES "public"."job_sequence_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_import_mappings" ADD CONSTRAINT "job_import_mappings_professional_line_fk" FOREIGN KEY ("tenant_id","professional_line_id") REFERENCES "public"."job_professional_line_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_import_mappings" ADD CONSTRAINT "job_import_mappings_post_fk" FOREIGN KEY ("tenant_id","post_id") REFERENCES "public"."job_post_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_import_mappings" ADD CONSTRAINT "job_import_mappings_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "public"."job_position_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_import_results" ADD CONSTRAINT "job_import_results_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_import_results" ADD CONSTRAINT "job_import_results_layer_fk" FOREIGN KEY ("tenant_id","layer_id") REFERENCES "public"."job_layer_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_import_results" ADD CONSTRAINT "job_import_results_grade_fk" FOREIGN KEY ("tenant_id","grade_id") REFERENCES "public"."job_grade_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_import_results" ADD CONSTRAINT "job_import_results_level_type_fk" FOREIGN KEY ("tenant_id","level_type_id") REFERENCES "public"."job_level_type_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_import_results" ADD CONSTRAINT "job_import_results_level_fk" FOREIGN KEY ("tenant_id","level_id") REFERENCES "public"."job_level_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_import_results" ADD CONSTRAINT "job_import_results_sequence_fk" FOREIGN KEY ("tenant_id","sequence_id") REFERENCES "public"."job_sequence_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_import_results" ADD CONSTRAINT "job_import_results_professional_line_fk" FOREIGN KEY ("tenant_id","professional_line_id") REFERENCES "public"."job_professional_line_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_import_results" ADD CONSTRAINT "job_import_results_post_fk" FOREIGN KEY ("tenant_id","post_id") REFERENCES "public"."job_post_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_import_results" ADD CONSTRAINT "job_import_results_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "public"."job_position_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_layer_objects" ADD CONSTRAINT "job_layer_objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_layer_versions" ADD CONSTRAINT "job_layer_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_layer_versions" ADD CONSTRAINT "job_layer_versions_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."job_layer_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_layer_versions" ADD CONSTRAINT "job_layer_versions_previous_fk" FOREIGN KEY ("tenant_id","object_id","previous_version_id") REFERENCES "public"."job_layer_versions"("tenant_id","object_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_level_objects" ADD CONSTRAINT "job_level_objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_level_type_objects" ADD CONSTRAINT "job_level_type_objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_level_type_versions" ADD CONSTRAINT "job_level_type_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_level_type_versions" ADD CONSTRAINT "job_level_type_versions_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."job_level_type_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_level_type_versions" ADD CONSTRAINT "job_level_type_versions_previous_fk" FOREIGN KEY ("tenant_id","object_id","previous_version_id") REFERENCES "public"."job_level_type_versions"("tenant_id","object_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_level_versions" ADD CONSTRAINT "job_level_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_level_versions" ADD CONSTRAINT "job_level_versions_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."job_level_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_level_versions" ADD CONSTRAINT "job_level_versions_previous_fk" FOREIGN KEY ("tenant_id","object_id","previous_version_id") REFERENCES "public"."job_level_versions"("tenant_id","object_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_level_versions" ADD CONSTRAINT "job_level_versions_type_fk" FOREIGN KEY ("tenant_id","level_type_id") REFERENCES "public"."job_level_type_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_level_versions" ADD CONSTRAINT "job_level_versions_min_grade_fk" FOREIGN KEY ("tenant_id","min_grade_id") REFERENCES "public"."job_grade_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_level_versions" ADD CONSTRAINT "job_level_versions_max_grade_fk" FOREIGN KEY ("tenant_id","max_grade_id") REFERENCES "public"."job_grade_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_position_objects" ADD CONSTRAINT "job_position_objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_position_versions" ADD CONSTRAINT "job_position_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_position_versions" ADD CONSTRAINT "job_position_versions_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."job_position_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_position_versions" ADD CONSTRAINT "job_position_versions_previous_fk" FOREIGN KEY ("tenant_id","object_id","previous_version_id") REFERENCES "public"."job_position_versions"("tenant_id","object_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_position_versions" ADD CONSTRAINT "job_position_versions_sequence_fk" FOREIGN KEY ("tenant_id","sequence_id") REFERENCES "public"."job_sequence_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_position_versions" ADD CONSTRAINT "job_position_versions_professional_line_fk" FOREIGN KEY ("tenant_id","professional_line_id") REFERENCES "public"."job_professional_line_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_position_versions" ADD CONSTRAINT "job_position_versions_level_type_fk" FOREIGN KEY ("tenant_id","level_type_id") REFERENCES "public"."job_level_type_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_position_versions" ADD CONSTRAINT "job_position_versions_min_level_fk" FOREIGN KEY ("tenant_id","min_level_id") REFERENCES "public"."job_level_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_position_versions" ADD CONSTRAINT "job_position_versions_max_level_fk" FOREIGN KEY ("tenant_id","max_level_id") REFERENCES "public"."job_level_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_position_versions" ADD CONSTRAINT "job_position_versions_min_grade_fk" FOREIGN KEY ("tenant_id","min_grade_id") REFERENCES "public"."job_grade_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_position_versions" ADD CONSTRAINT "job_position_versions_max_grade_fk" FOREIGN KEY ("tenant_id","max_grade_id") REFERENCES "public"."job_grade_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_position_versions" ADD CONSTRAINT "job_position_versions_org_fk" FOREIGN KEY ("tenant_id","org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_position_versions" ADD CONSTRAINT "job_position_versions_post_fk" FOREIGN KEY ("tenant_id","post_id") REFERENCES "public"."job_post_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_position_versions" ADD CONSTRAINT "job_position_versions_direct_parent_fk" FOREIGN KEY ("tenant_id","direct_parent_id") REFERENCES "public"."job_position_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_position_versions" ADD CONSTRAINT "job_position_versions_dotted_parent_fk" FOREIGN KEY ("tenant_id","dotted_parent_id") REFERENCES "public"."job_position_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_position_versions" ADD CONSTRAINT "job_position_versions_standard_fk" FOREIGN KEY ("tenant_id","standard_position_id") REFERENCES "public"."job_position_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_post_objects" ADD CONSTRAINT "job_post_objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_post_versions" ADD CONSTRAINT "job_post_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_post_versions" ADD CONSTRAINT "job_post_versions_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."job_post_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_post_versions" ADD CONSTRAINT "job_post_versions_previous_fk" FOREIGN KEY ("tenant_id","object_id","previous_version_id") REFERENCES "public"."job_post_versions"("tenant_id","object_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_post_versions" ADD CONSTRAINT "job_post_versions_sequence_fk" FOREIGN KEY ("tenant_id","sequence_id") REFERENCES "public"."job_sequence_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_post_versions" ADD CONSTRAINT "job_post_versions_professional_line_fk" FOREIGN KEY ("tenant_id","professional_line_id") REFERENCES "public"."job_professional_line_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_post_versions" ADD CONSTRAINT "job_post_versions_level_type_fk" FOREIGN KEY ("tenant_id","level_type_id") REFERENCES "public"."job_level_type_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_post_versions" ADD CONSTRAINT "job_post_versions_min_level_fk" FOREIGN KEY ("tenant_id","min_level_id") REFERENCES "public"."job_level_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_post_versions" ADD CONSTRAINT "job_post_versions_max_level_fk" FOREIGN KEY ("tenant_id","max_level_id") REFERENCES "public"."job_level_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_post_versions" ADD CONSTRAINT "job_post_versions_min_grade_fk" FOREIGN KEY ("tenant_id","min_grade_id") REFERENCES "public"."job_grade_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_post_versions" ADD CONSTRAINT "job_post_versions_max_grade_fk" FOREIGN KEY ("tenant_id","max_grade_id") REFERENCES "public"."job_grade_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_professional_line_objects" ADD CONSTRAINT "job_professional_line_objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_professional_line_versions" ADD CONSTRAINT "job_professional_line_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_professional_line_versions" ADD CONSTRAINT "job_professional_line_versions_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."job_professional_line_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_professional_line_versions" ADD CONSTRAINT "job_professional_line_versions_previous_fk" FOREIGN KEY ("tenant_id","object_id","previous_version_id") REFERENCES "public"."job_professional_line_versions"("tenant_id","object_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_professional_line_versions" ADD CONSTRAINT "job_professional_line_versions_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."job_professional_line_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sequence_objects" ADD CONSTRAINT "job_sequence_objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sequence_versions" ADD CONSTRAINT "job_sequence_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sequence_versions" ADD CONSTRAINT "job_sequence_versions_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."job_sequence_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sequence_versions" ADD CONSTRAINT "job_sequence_versions_previous_fk" FOREIGN KEY ("tenant_id","object_id","previous_version_id") REFERENCES "public"."job_sequence_versions"("tenant_id","object_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sequence_versions" ADD CONSTRAINT "job_sequence_versions_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."job_sequence_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sequence_versions" ADD CONSTRAINT "job_sequence_versions_first_fk" FOREIGN KEY ("tenant_id","first_sequence_id") REFERENCES "public"."job_sequence_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sequence_versions" ADD CONSTRAINT "job_sequence_versions_second_fk" FOREIGN KEY ("tenant_id","second_sequence_id") REFERENCES "public"."job_sequence_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sequence_versions" ADD CONSTRAINT "job_sequence_versions_third_fk" FOREIGN KEY ("tenant_id","third_sequence_id") REFERENCES "public"."job_sequence_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sequence_versions" ADD CONSTRAINT "job_sequence_versions_fourth_fk" FOREIGN KEY ("tenant_id","fourth_sequence_id") REFERENCES "public"."job_sequence_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sequence_versions" ADD CONSTRAINT "job_sequence_versions_fifth_fk" FOREIGN KEY ("tenant_id","fifth_sequence_id") REFERENCES "public"."job_sequence_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sequence_versions" ADD CONSTRAINT "job_sequence_versions_sixth_fk" FOREIGN KEY ("tenant_id","sixth_sequence_id") REFERENCES "public"."job_sequence_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sequence_versions" ADD CONSTRAINT "job_sequence_versions_seventh_fk" FOREIGN KEY ("tenant_id","seventh_sequence_id") REFERENCES "public"."job_sequence_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sequence_versions" ADD CONSTRAINT "job_sequence_versions_eighth_fk" FOREIGN KEY ("tenant_id","eighth_sequence_id") REFERENCES "public"."job_sequence_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sequence_versions" ADD CONSTRAINT "job_sequence_versions_ninth_fk" FOREIGN KEY ("tenant_id","ninth_sequence_id") REFERENCES "public"."job_sequence_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sequence_versions" ADD CONSTRAINT "job_sequence_versions_tenth_fk" FOREIGN KEY ("tenant_id","tenth_sequence_id") REFERENCES "public"."job_sequence_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sequence_versions" ADD CONSTRAINT "job_sequence_versions_type_fk" FOREIGN KEY ("tenant_id","level_type_id") REFERENCES "public"."job_level_type_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_settings_objects" ADD CONSTRAINT "job_settings_objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_settings_versions" ADD CONSTRAINT "job_settings_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_settings_versions" ADD CONSTRAINT "job_settings_versions_object_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."job_settings_objects"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_settings_versions" ADD CONSTRAINT "job_settings_versions_previous_fk" FOREIGN KEY ("tenant_id","previous_version_id") REFERENCES "public"."job_settings_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_copy_job_items" ADD CONSTRAINT "establishment_copy_job_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_copy_job_items" ADD CONSTRAINT "est_copy_items_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."establishment_copy_jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_copy_job_items" ADD CONSTRAINT "est_copy_items_capacity_fk" FOREIGN KEY ("tenant_id","capacity_id") REFERENCES "public"."establishment_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_copy_job_versions" ADD CONSTRAINT "establishment_copy_job_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_copy_job_versions" ADD CONSTRAINT "est_copy_versions_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."establishment_copy_jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_copy_job_versions" ADD CONSTRAINT "est_copy_versions_previous_fk" FOREIGN KEY ("tenant_id","job_id","previous_version_id") REFERENCES "public"."establishment_copy_job_versions"("tenant_id","job_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_copy_jobs" ADD CONSTRAINT "establishment_copy_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_copy_jobs" ADD CONSTRAINT "est_copy_jobs_creator_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_movement_objects" ADD CONSTRAINT "establishment_movement_objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_movement_versions" ADD CONSTRAINT "establishment_movement_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_movement_versions" ADD CONSTRAINT "est_movement_versions_object_fk" FOREIGN KEY ("tenant_id","movement_id") REFERENCES "public"."establishment_movement_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_movement_versions" ADD CONSTRAINT "est_movement_versions_previous_fk" FOREIGN KEY ("tenant_id","movement_id","previous_version_id") REFERENCES "public"."establishment_movement_versions"("tenant_id","movement_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_movement_versions" ADD CONSTRAINT "est_movement_versions_source_org_fk" FOREIGN KEY ("tenant_id","source_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_movement_versions" ADD CONSTRAINT "est_movement_versions_target_org_fk" FOREIGN KEY ("tenant_id","target_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_movement_versions" ADD CONSTRAINT "est_movement_versions_source_position_fk" FOREIGN KEY ("tenant_id","source_position_id") REFERENCES "public"."job_position_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_movement_versions" ADD CONSTRAINT "est_movement_versions_target_position_fk" FOREIGN KEY ("tenant_id","target_position_id") REFERENCES "public"."job_position_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_notification_delivery_attempts" ADD CONSTRAINT "establishment_notification_delivery_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_notification_delivery_attempts" ADD CONSTRAINT "est_notice_delivery_notice_fk" FOREIGN KEY ("tenant_id","notification_id") REFERENCES "public"."establishment_notifications"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_notifications" ADD CONSTRAINT "establishment_notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_notifications" ADD CONSTRAINT "est_notifications_job_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."establishment_copy_jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_notifications" ADD CONSTRAINT "est_notifications_movement_fk" FOREIGN KEY ("tenant_id","movement_id") REFERENCES "public"."establishment_movement_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_notifications" ADD CONSTRAINT "est_notifications_recipient_fk" FOREIGN KEY ("tenant_id","recipient_user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_objects" ADD CONSTRAINT "establishment_objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_objects" ADD CONSTRAINT "est_objects_org_fk" FOREIGN KEY ("tenant_id","org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_objects" ADD CONSTRAINT "est_objects_scheme_fk" FOREIGN KEY ("tenant_id","scheme_id") REFERENCES "public"."establishment_scheme_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_outbox" ADD CONSTRAINT "establishment_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_outbox_delivery_attempts" ADD CONSTRAINT "establishment_outbox_delivery_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_outbox_delivery_attempts" ADD CONSTRAINT "est_outbox_delivery_event_fk" FOREIGN KEY ("tenant_id","outbox_id") REFERENCES "public"."establishment_outbox"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_scheme_exclusions" ADD CONSTRAINT "establishment_scheme_exclusions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_scheme_exclusions" ADD CONSTRAINT "est_scheme_exclusions_version_fk" FOREIGN KEY ("tenant_id","version_id") REFERENCES "public"."establishment_scheme_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_scheme_exclusions" ADD CONSTRAINT "est_scheme_exclusions_org_fk" FOREIGN KEY ("tenant_id","org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_scheme_objects" ADD CONSTRAINT "establishment_scheme_objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_scheme_ranges" ADD CONSTRAINT "establishment_scheme_ranges_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_scheme_ranges" ADD CONSTRAINT "est_scheme_ranges_version_fk" FOREIGN KEY ("tenant_id","version_id") REFERENCES "public"."establishment_scheme_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_scheme_versions" ADD CONSTRAINT "establishment_scheme_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_scheme_versions" ADD CONSTRAINT "est_scheme_versions_object_fk" FOREIGN KEY ("tenant_id","scheme_id") REFERENCES "public"."establishment_scheme_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_scheme_versions" ADD CONSTRAINT "est_scheme_versions_previous_fk" FOREIGN KEY ("tenant_id","scheme_id","previous_version_id") REFERENCES "public"."establishment_scheme_versions"("tenant_id","scheme_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_settings" ADD CONSTRAINT "establishment_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_subdivisions" ADD CONSTRAINT "establishment_subdivisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_subdivisions" ADD CONSTRAINT "est_subdivisions_version_fk" FOREIGN KEY ("tenant_id","version_id") REFERENCES "public"."establishment_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_subdivisions" ADD CONSTRAINT "est_subdivisions_position_fk" FOREIGN KEY ("tenant_id","position_id") REFERENCES "public"."job_position_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_timing_versions" ADD CONSTRAINT "establishment_timing_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_timing_versions" ADD CONSTRAINT "est_timing_versions_settings_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."establishment_settings"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_timing_versions" ADD CONSTRAINT "est_timing_versions_previous_fk" FOREIGN KEY ("tenant_id","previous_version_id") REFERENCES "public"."establishment_timing_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_versions" ADD CONSTRAINT "establishment_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_versions" ADD CONSTRAINT "est_versions_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."establishment_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "establishment_versions" ADD CONSTRAINT "est_versions_previous_fk" FOREIGN KEY ("tenant_id","object_id","previous_version_id") REFERENCES "public"."establishment_versions"("tenant_id","object_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_grade_versions_tenant_as_of" ON "job_grade_versions" USING btree ("tenant_id","object_id","start_date","version_no");--> statement-breakpoint
CREATE INDEX "job_layer_versions_tenant_as_of" ON "job_layer_versions" USING btree ("tenant_id","object_id","start_date","version_no");--> statement-breakpoint
CREATE INDEX "job_level_type_versions_tenant_as_of" ON "job_level_type_versions" USING btree ("tenant_id","object_id","start_date","version_no");--> statement-breakpoint
CREATE INDEX "job_level_versions_tenant_as_of" ON "job_level_versions" USING btree ("tenant_id","object_id","start_date","version_no");--> statement-breakpoint
CREATE INDEX "job_position_versions_tenant_as_of" ON "job_position_versions" USING btree ("tenant_id","object_id","start_date","version_no");--> statement-breakpoint
CREATE INDEX "job_post_versions_tenant_as_of" ON "job_post_versions" USING btree ("tenant_id","object_id","start_date","version_no");--> statement-breakpoint
CREATE INDEX "job_professional_line_versions_tenant_as_of" ON "job_professional_line_versions" USING btree ("tenant_id","object_id","start_date","version_no");--> statement-breakpoint
CREATE INDEX "job_sequence_versions_tenant_as_of" ON "job_sequence_versions" USING btree ("tenant_id","object_id","start_date","version_no");--> statement-breakpoint
CREATE INDEX "job_settings_versions_tenant_as_of" ON "job_settings_versions" USING btree ("tenant_id","start_date","version_no");--> statement-breakpoint
CREATE INDEX "est_movement_versions_period" ON "establishment_movement_versions" USING btree ("tenant_id","effective_date");--> statement-breakpoint
CREATE INDEX "est_outbox_tenant_created" ON "establishment_outbox" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "est_scheme_versions_as_of" ON "establishment_scheme_versions" USING btree ("tenant_id","scheme_id","start_date","version_no");--> statement-breakpoint
CREATE INDEX "est_versions_as_of" ON "establishment_versions" USING btree ("tenant_id","object_id","start_date","version_no");
