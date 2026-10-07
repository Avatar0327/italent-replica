CREATE TABLE "survey360_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"scene" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"form" text NOT NULL,
	"welcome" text,
	"show_appraiser_name" boolean NOT NULL,
	"role_display" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"score_batch_id" uuid,
	"scored_at" timestamp with time zone,
	"deleted" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "survey360_activities_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "survey360_activities_status" CHECK ("survey360_activities"."status" IN ('draft', 'enabled', 'disabled')),
	CONSTRAINT "survey360_activities_form" CHECK ("survey360_activities"."form" IN ('single', 'multiple')),
	CONSTRAINT "survey360_activities_role_display" CHECK ("survey360_activities"."role_display" IN ('name', 'fixed_text', 'hidden'))
);
--> statement-breakpoint
CREATE TABLE "survey360_activity_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "survey360_activity_grants_user" UNIQUE("activity_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "survey360_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sheet_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"remark" text,
	CONSTRAINT "survey360_answers_item" UNIQUE("sheet_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "survey360_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"confirmer_person_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "survey360_confirmations_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "survey360_confirmations_status" CHECK ("survey360_confirmations"."status" IN ('pending', 'confirmed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "survey360_dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"questionnaire_id" uuid NOT NULL,
	"key" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"definition" text,
	"weight" double precision NOT NULL,
	"scale_id" uuid,
	"role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	CONSTRAINT "survey360_dimensions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "survey360_dimensions_key" UNIQUE("questionnaire_id","key"),
	CONSTRAINT "survey360_dimensions_weight" CHECK ("survey360_dimensions"."weight" >= 0)
);
--> statement-breakpoint
CREATE TABLE "survey360_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"person_id" uuid NOT NULL,
	"confirmation_id" uuid,
	"token_hash" text NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "survey360_links_kind" CHECK ("survey360_links"."kind" IN ('answer', 'confirm'))
);
--> statement-breakpoint
CREATE TABLE "survey360_object_questionnaires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"questionnaire_id" uuid NOT NULL,
	CONSTRAINT "survey360_object_questionnaires_pair" UNIQUE("object_id","questionnaire_id")
);
--> statement-breakpoint
CREATE TABLE "survey360_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"removed" boolean DEFAULT false NOT NULL,
	"report_generated_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "survey360_objects_tenant_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "survey360_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"object_id" uuid NOT NULL,
	"command_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "survey360_people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"mobile" text,
	"staff_code" text,
	"department" text,
	"position" text,
	"superior_person_id" uuid,
	"employee_id" uuid,
	"previous_employee_id" uuid,
	"email_locked" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "survey360_people_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "survey360_people_source" CHECK ("survey360_people"."source" IN ('manual', 'import', 'org_sync')),
	CONSTRAINT "survey360_people_name_nonempty" CHECK (btrim("survey360_people"."name") <> ''),
	CONSTRAINT "survey360_people_email_nonempty" CHECK (btrim("survey360_people"."email") <> '')
);
--> statement-breakpoint
CREATE TABLE "survey360_person_link_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"previous_employee_id" uuid,
	"reason" text NOT NULL,
	"matched_by" text[] DEFAULT '{}'::text[] NOT NULL,
	"actor_user_id" uuid,
	"command_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "survey360_person_link_logs_reason" CHECK ("survey360_person_link_logs"."reason" IN ('new', 'employee', 'admin_confirm'))
);
--> statement-breakpoint
CREATE TABLE "survey360_questionnaire_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"questionnaire_id" uuid NOT NULL,
	"key" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"role_id" uuid NOT NULL,
	"weight" integer NOT NULL,
	CONSTRAINT "survey360_questionnaire_roles_role" UNIQUE("questionnaire_id","role_id"),
	CONSTRAINT "survey360_questionnaire_roles_key" UNIQUE("questionnaire_id","key"),
	CONSTRAINT "survey360_questionnaire_roles_weight" CHECK ("survey360_questionnaire_roles"."weight" >= 0)
);
--> statement-breakpoint
CREATE TABLE "survey360_questionnaires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"score_method" text DEFAULT 'weighted_average' NOT NULL,
	"guide" text,
	"excellent_line_percent" numeric,
	"excellent_max_rate" numeric,
	"deleted" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "survey360_questionnaires_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "survey360_questionnaires_type" CHECK ("survey360_questionnaires"."type" IN ('key_behavior', 'rating')),
	CONSTRAINT "survey360_questionnaires_status" CHECK ("survey360_questionnaires"."status" IN ('draft', 'enabled', 'used')),
	CONSTRAINT "survey360_questionnaires_method" CHECK ("survey360_questionnaires"."score_method" IN ('weighted_average', 'weighted_sum'))
);
--> statement-breakpoint
CREATE TABLE "survey360_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"questionnaire_id" uuid NOT NULL,
	"key" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"dimension_id" uuid NOT NULL,
	"text" text NOT NULL,
	"weight" double precision NOT NULL,
	"scale_id" uuid NOT NULL,
	"allow_remark" boolean DEFAULT false NOT NULL,
	"role_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	CONSTRAINT "survey360_questions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "survey360_questions_key" UNIQUE("questionnaire_id","key"),
	CONSTRAINT "survey360_questions_weight" CHECK ("survey360_questions"."weight" >= 0)
);
--> statement-breakpoint
CREATE TABLE "survey360_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"appraiser_person_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"source" text NOT NULL,
	"removed" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "survey360_relations_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "survey360_relations_source" CHECK ("survey360_relations"."source" IN ('manual', 'import', 'org', 'confirm'))
);
--> statement-breakpoint
CREATE TABLE "survey360_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"display_text" text,
	"sort" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "survey360_roles_tenant_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "survey360_scale_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"questionnaire_id" uuid NOT NULL,
	"key" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"scale_id" uuid NOT NULL,
	"label" text NOT NULL,
	"value" double precision,
	"not_scored" boolean DEFAULT false NOT NULL,
	"remark_required" boolean DEFAULT false NOT NULL,
	CONSTRAINT "survey360_scale_options_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "survey360_scale_options_key" UNIQUE("questionnaire_id","key"),
	CONSTRAINT "survey360_scale_options_value" CHECK ("survey360_scale_options"."not_scored" OR "survey360_scale_options"."value" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "survey360_scales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"questionnaire_id" uuid NOT NULL,
	"key" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "survey360_scales_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "survey360_scales_key" UNIQUE("questionnaire_id","key")
);
--> statement-breakpoint
CREATE TABLE "survey360_score_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "survey360_score_batches_tenant_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "survey360_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"questionnaire_id" uuid NOT NULL,
	"level" text NOT NULL,
	"item_id" uuid,
	"scope" text NOT NULL,
	"role_id" uuid,
	"score" double precision,
	"rater_count" integer NOT NULL,
	CONSTRAINT "survey360_scores_level" CHECK ("survey360_scores"."level" IN ('questionnaire', 'dimension', 'question')),
	CONSTRAINT "survey360_scores_scope" CHECK ("survey360_scores"."scope" IN ('self', 'other', 'role'))
);
--> statement-breakpoint
CREATE TABLE "survey360_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"fine_permission" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "survey360_sheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"relation_id" uuid NOT NULL,
	"questionnaire_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"suggestion" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	CONSTRAINT "survey360_sheets_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "survey360_sheets_pair" UNIQUE("relation_id","questionnaire_id"),
	CONSTRAINT "survey360_sheets_status" CHECK ("survey360_sheets"."status" IN ('draft', 'submitted'))
);
--> statement-breakpoint
CREATE TABLE "survey360_sync_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"candidate_person_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"matched_by" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolution" text,
	"resolved_person_id" uuid,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "survey360_sync_conflicts_status" CHECK ("survey360_sync_conflicts"."status" IN ('pending', 'resolved', 'ignored'))
);
--> statement-breakpoint
ALTER TABLE "survey360_activities" ADD CONSTRAINT "survey360_activities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_activity_grants" ADD CONSTRAINT "survey360_activity_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_activity_grants" ADD CONSTRAINT "survey360_activity_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_activity_grants" ADD CONSTRAINT "survey360_activity_grants_activity_fk" FOREIGN KEY ("tenant_id","activity_id") REFERENCES "public"."survey360_activities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_answers" ADD CONSTRAINT "survey360_answers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_answers" ADD CONSTRAINT "survey360_answers_sheet_fk" FOREIGN KEY ("tenant_id","sheet_id") REFERENCES "public"."survey360_sheets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_answers" ADD CONSTRAINT "survey360_answers_option_fk" FOREIGN KEY ("tenant_id","option_id") REFERENCES "public"."survey360_scale_options"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_confirmations" ADD CONSTRAINT "survey360_confirmations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_confirmations" ADD CONSTRAINT "survey360_confirmations_activity_fk" FOREIGN KEY ("tenant_id","activity_id") REFERENCES "public"."survey360_activities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_confirmations" ADD CONSTRAINT "survey360_confirmations_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."survey360_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_confirmations" ADD CONSTRAINT "survey360_confirmations_confirmer_fk" FOREIGN KEY ("tenant_id","confirmer_person_id") REFERENCES "public"."survey360_people"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_dimensions" ADD CONSTRAINT "survey360_dimensions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_dimensions" ADD CONSTRAINT "survey360_dimensions_questionnaire_fk" FOREIGN KEY ("tenant_id","questionnaire_id") REFERENCES "public"."survey360_questionnaires"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_dimensions" ADD CONSTRAINT "survey360_dimensions_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."survey360_dimensions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_dimensions" ADD CONSTRAINT "survey360_dimensions_scale_fk" FOREIGN KEY ("tenant_id","scale_id") REFERENCES "public"."survey360_scales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_links" ADD CONSTRAINT "survey360_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_links" ADD CONSTRAINT "survey360_links_activity_fk" FOREIGN KEY ("tenant_id","activity_id") REFERENCES "public"."survey360_activities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_links" ADD CONSTRAINT "survey360_links_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."survey360_people"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_links" ADD CONSTRAINT "survey360_links_confirmation_fk" FOREIGN KEY ("tenant_id","confirmation_id") REFERENCES "public"."survey360_confirmations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_object_questionnaires" ADD CONSTRAINT "survey360_object_questionnaires_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_object_questionnaires" ADD CONSTRAINT "survey360_object_questionnaires_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."survey360_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_object_questionnaires" ADD CONSTRAINT "survey360_object_questionnaires_questionnaire_fk" FOREIGN KEY ("tenant_id","questionnaire_id") REFERENCES "public"."survey360_questionnaires"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_objects" ADD CONSTRAINT "survey360_objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_objects" ADD CONSTRAINT "survey360_objects_activity_fk" FOREIGN KEY ("tenant_id","activity_id") REFERENCES "public"."survey360_activities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_objects" ADD CONSTRAINT "survey360_objects_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."survey360_people"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_outbox" ADD CONSTRAINT "survey360_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_people" ADD CONSTRAINT "survey360_people_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_people" ADD CONSTRAINT "survey360_people_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_people" ADD CONSTRAINT "survey360_people_superior_fk" FOREIGN KEY ("tenant_id","superior_person_id") REFERENCES "public"."survey360_people"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_person_link_logs" ADD CONSTRAINT "survey360_person_link_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_person_link_logs" ADD CONSTRAINT "survey360_person_link_logs_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."survey360_people"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_questionnaire_roles" ADD CONSTRAINT "survey360_questionnaire_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_questionnaire_roles" ADD CONSTRAINT "survey360_questionnaire_roles_questionnaire_fk" FOREIGN KEY ("tenant_id","questionnaire_id") REFERENCES "public"."survey360_questionnaires"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_questionnaire_roles" ADD CONSTRAINT "survey360_questionnaire_roles_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "public"."survey360_roles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_questionnaires" ADD CONSTRAINT "survey360_questionnaires_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_questions" ADD CONSTRAINT "survey360_questions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_questions" ADD CONSTRAINT "survey360_questions_questionnaire_fk" FOREIGN KEY ("tenant_id","questionnaire_id") REFERENCES "public"."survey360_questionnaires"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_questions" ADD CONSTRAINT "survey360_questions_dimension_fk" FOREIGN KEY ("tenant_id","dimension_id") REFERENCES "public"."survey360_dimensions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_questions" ADD CONSTRAINT "survey360_questions_scale_fk" FOREIGN KEY ("tenant_id","scale_id") REFERENCES "public"."survey360_scales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_relations" ADD CONSTRAINT "survey360_relations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_relations" ADD CONSTRAINT "survey360_relations_activity_fk" FOREIGN KEY ("tenant_id","activity_id") REFERENCES "public"."survey360_activities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_relations" ADD CONSTRAINT "survey360_relations_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."survey360_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_relations" ADD CONSTRAINT "survey360_relations_appraiser_fk" FOREIGN KEY ("tenant_id","appraiser_person_id") REFERENCES "public"."survey360_people"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_relations" ADD CONSTRAINT "survey360_relations_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "public"."survey360_roles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_roles" ADD CONSTRAINT "survey360_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_scale_options" ADD CONSTRAINT "survey360_scale_options_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_scale_options" ADD CONSTRAINT "survey360_scale_options_questionnaire_fk" FOREIGN KEY ("tenant_id","questionnaire_id") REFERENCES "public"."survey360_questionnaires"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_scale_options" ADD CONSTRAINT "survey360_scale_options_scale_fk" FOREIGN KEY ("tenant_id","scale_id") REFERENCES "public"."survey360_scales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_scales" ADD CONSTRAINT "survey360_scales_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_scales" ADD CONSTRAINT "survey360_scales_questionnaire_fk" FOREIGN KEY ("tenant_id","questionnaire_id") REFERENCES "public"."survey360_questionnaires"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_score_batches" ADD CONSTRAINT "survey360_score_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_score_batches" ADD CONSTRAINT "survey360_score_batches_activity_fk" FOREIGN KEY ("tenant_id","activity_id") REFERENCES "public"."survey360_activities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_scores" ADD CONSTRAINT "survey360_scores_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_scores" ADD CONSTRAINT "survey360_scores_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."survey360_score_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_settings" ADD CONSTRAINT "survey360_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_settings" ADD CONSTRAINT "survey360_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_sheets" ADD CONSTRAINT "survey360_sheets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_sheets" ADD CONSTRAINT "survey360_sheets_activity_fk" FOREIGN KEY ("tenant_id","activity_id") REFERENCES "public"."survey360_activities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_sheets" ADD CONSTRAINT "survey360_sheets_relation_fk" FOREIGN KEY ("tenant_id","relation_id") REFERENCES "public"."survey360_relations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_sheets" ADD CONSTRAINT "survey360_sheets_questionnaire_fk" FOREIGN KEY ("tenant_id","questionnaire_id") REFERENCES "public"."survey360_questionnaires"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_sync_conflicts" ADD CONSTRAINT "survey360_sync_conflicts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_sync_conflicts" ADD CONSTRAINT "survey360_sync_conflicts_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "survey360_confirmations_object" ON "survey360_confirmations" USING btree ("object_id") WHERE "survey360_confirmations"."status" <> 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX "survey360_links_token" ON "survey360_links" USING btree ("tenant_id","token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "survey360_links_answer" ON "survey360_links" USING btree ("activity_id","person_id") WHERE "survey360_links"."kind" = 'answer' AND NOT "survey360_links"."revoked";--> statement-breakpoint
CREATE UNIQUE INDEX "survey360_links_confirm" ON "survey360_links" USING btree ("confirmation_id") WHERE "survey360_links"."kind" = 'confirm' AND NOT "survey360_links"."revoked";--> statement-breakpoint
CREATE UNIQUE INDEX "survey360_objects_person" ON "survey360_objects" USING btree ("activity_id","person_id") WHERE NOT "survey360_objects"."removed";--> statement-breakpoint
CREATE UNIQUE INDEX "survey360_people_email" ON "survey360_people" USING btree ("tenant_id",lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "survey360_people_employee" ON "survey360_people" USING btree ("tenant_id","employee_id") WHERE "survey360_people"."employee_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "survey360_relations_pair" ON "survey360_relations" USING btree ("object_id","appraiser_person_id") WHERE NOT "survey360_relations"."removed";--> statement-breakpoint
CREATE INDEX "survey360_relations_appraiser" ON "survey360_relations" USING btree ("tenant_id","activity_id","appraiser_person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "survey360_roles_code" ON "survey360_roles" USING btree ("tenant_id","code") WHERE "survey360_roles"."code" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "survey360_roles_name" ON "survey360_roles" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "survey360_scores_object" ON "survey360_scores" USING btree ("tenant_id","batch_id","object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "survey360_sync_conflicts_pending" ON "survey360_sync_conflicts" USING btree ("tenant_id","employee_id") WHERE "survey360_sync_conflicts"."status" = 'pending';