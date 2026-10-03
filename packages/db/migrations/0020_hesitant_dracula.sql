CREATE TABLE "personnel_awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"name" text,
	"category" text,
	"level" text,
	"award_date" date,
	"description" text,
	CONSTRAINT "personnel_awards_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "personnel_awards_owner_id" UNIQUE("tenant_id","employee_id","id"),
	CONSTRAINT "personnel_awards_revision_positive" CHECK ("personnel_awards"."revision" > 0),
	CONSTRAINT "personnel_awards_source" CHECK ("personnel_awards"."source_type" IN ('hr_direct','self_service','info_collection')
    AND ("personnel_awards"."source_type" = 'hr_direct' OR "personnel_awards"."source_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "personnel_awards_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"record_id" uuid NOT NULL,
	"name" text,
	"category" text,
	"level" text,
	"award_date" date,
	"description" text,
	CONSTRAINT "personnel_awards_versions_revision" UNIQUE("tenant_id","record_id","revision")
);
--> statement-breakpoint
CREATE TABLE "personnel_certificate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"name" text,
	"type" text,
	"number" text,
	"issuer" text,
	"obtained_date" date,
	"start_date" date,
	"end_date" date,
	"attachment_id" uuid,
	"learning_certificate_id" text,
	CONSTRAINT "personnel_certificate_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "personnel_certificate_owner_id" UNIQUE("tenant_id","employee_id","id"),
	CONSTRAINT "personnel_certificate_revision_positive" CHECK ("personnel_certificate"."revision" > 0),
	CONSTRAINT "personnel_certificate_source" CHECK ("personnel_certificate"."source_type" IN ('hr_direct','self_service','info_collection')
    AND ("personnel_certificate"."source_type" = 'hr_direct' OR "personnel_certificate"."source_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "personnel_certificate_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"record_id" uuid NOT NULL,
	"name" text,
	"type" text,
	"number" text,
	"issuer" text,
	"obtained_date" date,
	"start_date" date,
	"end_date" date,
	"attachment_id" uuid,
	"learning_certificate_id" text,
	CONSTRAINT "personnel_certificate_versions_revision" UNIQUE("tenant_id","record_id","revision")
);
--> statement-breakpoint
CREATE TABLE "personnel_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"subset" text NOT NULL,
	"record_id" uuid,
	"target_revision" integer NOT NULL,
	"values" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"created_by" uuid NOT NULL,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personnel_change_requests_owner_id" UNIQUE("tenant_id","employee_id","id"),
	CONSTRAINT "personnel_change_requests_state" CHECK ("personnel_change_requests"."status" IN ('pending_approval','applied')),
	CONSTRAINT "personnel_change_requests_revision_positive" CHECK ("personnel_change_requests"."revision">0 AND "personnel_change_requests"."target_revision">=0)
);
--> statement-breakpoint
CREATE TABLE "personnel_education" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"education_level" text,
	"degree" text,
	"school" text,
	"school_type" text,
	"major" text,
	"major_category" text,
	"major_description" text,
	"main_courses" text,
	"start_date" date,
	"end_date" date,
	"learning_form" text,
	"schooling_length" text,
	"graduation_type" text,
	"training_mode" text,
	"is_first_education" boolean,
	"is_highest_education" boolean,
	"is_highest_degree" boolean,
	"is_main_major" boolean,
	"education_certificate" uuid,
	"education_certificate_number" text,
	"degree_certificate" uuid,
	"degree_certificate_number" text,
	"degree_country" text,
	"gpa" numeric,
	"class_rank" integer,
	"major_rank" integer,
	"attachment_id" uuid,
	CONSTRAINT "personnel_education_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "personnel_education_owner_id" UNIQUE("tenant_id","employee_id","id"),
	CONSTRAINT "personnel_education_revision_positive" CHECK ("personnel_education"."revision" > 0),
	CONSTRAINT "personnel_education_source" CHECK ("personnel_education"."source_type" IN ('hr_direct','self_service','info_collection')
    AND ("personnel_education"."source_type" = 'hr_direct' OR "personnel_education"."source_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "personnel_education_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"record_id" uuid NOT NULL,
	"education_level" text,
	"degree" text,
	"school" text,
	"school_type" text,
	"major" text,
	"major_category" text,
	"major_description" text,
	"main_courses" text,
	"start_date" date,
	"end_date" date,
	"learning_form" text,
	"schooling_length" text,
	"graduation_type" text,
	"training_mode" text,
	"is_first_education" boolean,
	"is_highest_education" boolean,
	"is_highest_degree" boolean,
	"is_main_major" boolean,
	"education_certificate" uuid,
	"education_certificate_number" text,
	"degree_certificate" uuid,
	"degree_certificate_number" text,
	"degree_country" text,
	"gpa" numeric,
	"class_rank" integer,
	"major_rank" integer,
	"attachment_id" uuid,
	CONSTRAINT "personnel_education_versions_revision" UNIQUE("tenant_id","record_id","revision")
);
--> statement-breakpoint
CREATE TABLE "personnel_employee_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"previous_version_id" uuid,
	"command_id" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text,
	"display_name" text,
	"eng_name" text,
	"lastname" text,
	"firstname" text,
	"gender" text,
	"birthday" date,
	"nation" text,
	"nationality" text,
	"regist_address" text,
	"marry_category" text,
	"political_status" text,
	"work_date" date,
	"id_photo" uuid,
	"id_type" text,
	"id_number" text,
	"id_start_date" date,
	"id_end_date" date,
	"id_long_term" boolean,
	"id_issuer" text,
	"id_front" uuid,
	"id_back" uuid,
	"mobile_phone" text,
	"email" text,
	"work_email" text,
	"backup_mail" text,
	"office_phone" text,
	"home_phone" text,
	"contact_address" text,
	"household_address" text,
	"household_category" text,
	"emergency_contact" text,
	"emergency_phone" text,
	"emergency_relationship" text,
	"is_rehire" boolean,
	"rehire_type" text,
	"confirm_rehire_user_id" uuid,
	"expected_retirement_date" date,
	"actual_retirement_date" date,
	"allow_to_login_in" boolean,
	"name_pinyin" text,
	"pinyin_initials" text,
	"last_name_pinyin" text,
	"first_name_pinyin" text,
	"education_level" text,
	"last_school" text,
	"major" text,
	"graduate_date" date,
	"first_education_level" text,
	"highest_degree" text,
	"highest_technical_level" text,
	"highest_vocational_level" text,
	"account_activation_status" text,
	"invitation_status" text,
	"approval_status" text,
	"approval_object_data_id" uuid,
	"approval_object_data_id2" uuid,
	"approval_type" text,
	"current_approver_id" uuid,
	CONSTRAINT "personnel_employee_versions_owner_id" UNIQUE("tenant_id","employee_id","id"),
	CONSTRAINT "personnel_employee_versions_revision" UNIQUE("tenant_id","employee_id","revision"),
	CONSTRAINT "personnel_employee_revision_positive" CHECK ("personnel_employee_versions"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "personnel_estimation_result" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"year" integer,
	"cycle_name" text,
	"cycle_order" integer,
	"cycle_start_date" date,
	"cycle_end_date" date,
	"activity" text,
	"performance_id" text,
	"department" text,
	"final_score" numeric,
	"total_grade" text,
	"ability_grade" text,
	"ability_score" numeric,
	"values_grade" text,
	"values_score" numeric,
	"coefficient" numeric,
	"nine_box_result" text,
	"comments" text,
	"development_plan" text,
	CONSTRAINT "personnel_estimation_result_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "personnel_estimation_result_owner_id" UNIQUE("tenant_id","employee_id","id"),
	CONSTRAINT "personnel_estimation_result_revision_positive" CHECK ("personnel_estimation_result"."revision" > 0),
	CONSTRAINT "personnel_estimation_result_source" CHECK ("personnel_estimation_result"."source_type" IN ('hr_direct','self_service','info_collection')
    AND ("personnel_estimation_result"."source_type" = 'hr_direct' OR "personnel_estimation_result"."source_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "personnel_estimation_result_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"record_id" uuid NOT NULL,
	"year" integer,
	"cycle_name" text,
	"cycle_order" integer,
	"cycle_start_date" date,
	"cycle_end_date" date,
	"activity" text,
	"performance_id" text,
	"department" text,
	"final_score" numeric,
	"total_grade" text,
	"ability_grade" text,
	"ability_score" numeric,
	"values_grade" text,
	"values_score" numeric,
	"coefficient" numeric,
	"nine_box_result" text,
	"comments" text,
	"development_plan" text,
	CONSTRAINT "personnel_estimation_result_versions_revision" UNIQUE("tenant_id","record_id","revision")
);
--> statement-breakpoint
CREATE TABLE "personnel_family" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"name" text,
	"relationship" text,
	"gender" text,
	"birthday" date,
	"company" text,
	"post" text,
	"phone" text,
	"mobile_phone" text,
	"email" text,
	"nationality" text,
	"nation" text,
	"political_status" text,
	"id_number" text,
	"id_front" uuid,
	"id_back" uuid,
	"id_start_date" date,
	"id_end_date" date,
	"id_issuer" text,
	"previous_childcare_days" numeric,
	"childcare_start_year" integer,
	CONSTRAINT "personnel_family_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "personnel_family_owner_id" UNIQUE("tenant_id","employee_id","id"),
	CONSTRAINT "personnel_family_revision_positive" CHECK ("personnel_family"."revision" > 0),
	CONSTRAINT "personnel_family_source" CHECK ("personnel_family"."source_type" IN ('hr_direct','self_service','info_collection')
    AND ("personnel_family"."source_type" = 'hr_direct' OR "personnel_family"."source_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "personnel_family_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"record_id" uuid NOT NULL,
	"name" text,
	"relationship" text,
	"gender" text,
	"birthday" date,
	"company" text,
	"post" text,
	"phone" text,
	"mobile_phone" text,
	"email" text,
	"nationality" text,
	"nation" text,
	"political_status" text,
	"id_number" text,
	"id_front" uuid,
	"id_back" uuid,
	"id_start_date" date,
	"id_end_date" date,
	"id_issuer" text,
	"previous_childcare_days" numeric,
	"childcare_start_year" integer,
	CONSTRAINT "personnel_family_versions_revision" UNIQUE("tenant_id","record_id","revision")
);
--> statement-breakpoint
CREATE TABLE "personnel_job_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"company" text,
	"department" text,
	"post" text,
	"position" text,
	"level" text,
	"start_date" date,
	"end_date" date,
	"entry_date" date,
	"leave_date" date,
	"leave_reason" text,
	"responsibilities" text,
	"achievements" text,
	"reference_name" text,
	"reference_title" text,
	"reference_phone" text,
	"company_type" text,
	"industry" text,
	"company_size" text,
	"subordinate_count" integer,
	"reports_to" text,
	"monthly_salary" numeric,
	"is_this_company" boolean,
	"employment_record_id" uuid,
	"employment_type" text,
	"department_full_name" text,
	CONSTRAINT "personnel_job_history_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "personnel_job_history_owner_id" UNIQUE("tenant_id","employee_id","id"),
	CONSTRAINT "personnel_job_history_revision_positive" CHECK ("personnel_job_history"."revision" > 0),
	CONSTRAINT "personnel_job_history_source" CHECK ("personnel_job_history"."source_type" IN ('hr_direct','self_service','info_collection')
    AND ("personnel_job_history"."source_type" = 'hr_direct' OR "personnel_job_history"."source_id" IS NOT NULL)),
	CONSTRAINT "personnel_job_history_link" CHECK (("personnel_job_history"."is_this_company" IS TRUE) = ("personnel_job_history"."employment_record_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "personnel_job_history_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"record_id" uuid NOT NULL,
	"company" text,
	"department" text,
	"post" text,
	"position" text,
	"level" text,
	"start_date" date,
	"end_date" date,
	"entry_date" date,
	"leave_date" date,
	"leave_reason" text,
	"responsibilities" text,
	"achievements" text,
	"reference_name" text,
	"reference_title" text,
	"reference_phone" text,
	"company_type" text,
	"industry" text,
	"company_size" text,
	"subordinate_count" integer,
	"reports_to" text,
	"monthly_salary" numeric,
	"is_this_company" boolean,
	"employment_record_id" uuid,
	"employment_type" text,
	"department_full_name" text,
	CONSTRAINT "personnel_job_history_versions_revision" UNIQUE("tenant_id","record_id","revision")
);
--> statement-breakpoint
CREATE TABLE "personnel_language_ability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"language" text,
	"proficiency" text,
	"listening" text,
	"speaking" text,
	"reading" text,
	"writing" text,
	"is_native" boolean,
	"description" text,
	CONSTRAINT "personnel_language_ability_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "personnel_language_ability_owner_id" UNIQUE("tenant_id","employee_id","id"),
	CONSTRAINT "personnel_language_ability_revision_positive" CHECK ("personnel_language_ability"."revision" > 0),
	CONSTRAINT "personnel_language_ability_source" CHECK ("personnel_language_ability"."source_type" IN ('hr_direct','self_service','info_collection')
    AND ("personnel_language_ability"."source_type" = 'hr_direct' OR "personnel_language_ability"."source_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "personnel_language_ability_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"record_id" uuid NOT NULL,
	"language" text,
	"proficiency" text,
	"listening" text,
	"speaking" text,
	"reading" text,
	"writing" text,
	"is_native" boolean,
	"description" text,
	CONSTRAINT "personnel_language_ability_versions_revision" UNIQUE("tenant_id","record_id","revision")
);
--> statement-breakpoint
CREATE TABLE "personnel_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"object_type" text NOT NULL,
	"object_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"revision" integer NOT NULL,
	"command_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personnel_outbox_event" UNIQUE("tenant_id","object_type","object_id","revision"),
	CONSTRAINT "personnel_outbox_state" CHECK ("personnel_outbox"."state" IN ('pending','sent','failed','unknown'))
);
--> statement-breakpoint
CREATE TABLE "personnel_professional_technical_post" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"qualification_name" text,
	"level" text,
	"appointed_post" text,
	"appointed_level" text,
	"company" text,
	"start_date" date,
	"end_date" date,
	"assessment_date" date,
	"assessment_institution" text,
	"qualification_route" text,
	"is_highest_level" boolean,
	CONSTRAINT "personnel_professional_technical_post_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "personnel_professional_technical_post_owner_id" UNIQUE("tenant_id","employee_id","id"),
	CONSTRAINT "personnel_professional_technical_post_revision_positive" CHECK ("personnel_professional_technical_post"."revision" > 0),
	CONSTRAINT "personnel_professional_technical_post_source" CHECK ("personnel_professional_technical_post"."source_type" IN ('hr_direct','self_service','info_collection')
    AND ("personnel_professional_technical_post"."source_type" = 'hr_direct' OR "personnel_professional_technical_post"."source_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "personnel_professional_technical_post_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"record_id" uuid NOT NULL,
	"qualification_name" text,
	"level" text,
	"appointed_post" text,
	"appointed_level" text,
	"company" text,
	"start_date" date,
	"end_date" date,
	"assessment_date" date,
	"assessment_institution" text,
	"qualification_route" text,
	"is_highest_level" boolean,
	CONSTRAINT "personnel_professional_technical_post_versions_revision" UNIQUE("tenant_id","record_id","revision")
);
--> statement-breakpoint
CREATE TABLE "personnel_project_experience" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"name" text,
	"start_date" date,
	"end_date" date,
	"post" text,
	"position" text,
	"responsibilities" text,
	"results" text,
	"headcount" integer,
	"description" text,
	"hardware_environment" text,
	"software_environment" text,
	"development_tools" text,
	CONSTRAINT "personnel_project_experience_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "personnel_project_experience_owner_id" UNIQUE("tenant_id","employee_id","id"),
	CONSTRAINT "personnel_project_experience_revision_positive" CHECK ("personnel_project_experience"."revision" > 0),
	CONSTRAINT "personnel_project_experience_source" CHECK ("personnel_project_experience"."source_type" IN ('hr_direct','self_service','info_collection')
    AND ("personnel_project_experience"."source_type" = 'hr_direct' OR "personnel_project_experience"."source_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "personnel_project_experience_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"record_id" uuid NOT NULL,
	"name" text,
	"start_date" date,
	"end_date" date,
	"post" text,
	"position" text,
	"responsibilities" text,
	"results" text,
	"headcount" integer,
	"description" text,
	"hardware_environment" text,
	"software_environment" text,
	"development_tools" text,
	CONSTRAINT "personnel_project_experience_versions_revision" UNIQUE("tenant_id","record_id","revision")
);
--> statement-breakpoint
CREATE TABLE "personnel_punish" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"month" text,
	"description" text,
	CONSTRAINT "personnel_punish_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "personnel_punish_owner_id" UNIQUE("tenant_id","employee_id","id"),
	CONSTRAINT "personnel_punish_revision_positive" CHECK ("personnel_punish"."revision" > 0),
	CONSTRAINT "personnel_punish_source" CHECK ("personnel_punish"."source_type" IN ('hr_direct','self_service','info_collection')
    AND ("personnel_punish"."source_type" = 'hr_direct' OR "personnel_punish"."source_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "personnel_punish_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"record_id" uuid NOT NULL,
	"month" text,
	"description" text,
	CONSTRAINT "personnel_punish_versions_revision" UNIQUE("tenant_id","record_id","revision")
);
--> statement-breakpoint
CREATE TABLE "personnel_skill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"name" text,
	"category" text,
	"proficiency" text,
	"months" numeric,
	CONSTRAINT "personnel_skill_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "personnel_skill_owner_id" UNIQUE("tenant_id","employee_id","id"),
	CONSTRAINT "personnel_skill_revision_positive" CHECK ("personnel_skill"."revision" > 0),
	CONSTRAINT "personnel_skill_source" CHECK ("personnel_skill"."source_type" IN ('hr_direct','self_service','info_collection')
    AND ("personnel_skill"."source_type" = 'hr_direct' OR "personnel_skill"."source_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "personnel_skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"record_id" uuid NOT NULL,
	"name" text,
	"category" text,
	"proficiency" text,
	"months" numeric,
	CONSTRAINT "personnel_skill_versions_revision" UNIQUE("tenant_id","record_id","revision")
);
--> statement-breakpoint
CREATE TABLE "personnel_training" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"name" text,
	"category" text,
	"institution" text,
	"start_date" date,
	"end_date" date,
	"hours" numeric,
	"score" numeric,
	"passed" boolean,
	"completed" boolean,
	"credits" numeric,
	"certificate" text,
	"lecturer" text,
	"mentor" text,
	"activity_number" text,
	"has_medal" boolean,
	CONSTRAINT "personnel_training_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "personnel_training_owner_id" UNIQUE("tenant_id","employee_id","id"),
	CONSTRAINT "personnel_training_revision_positive" CHECK ("personnel_training"."revision" > 0),
	CONSTRAINT "personnel_training_source" CHECK ("personnel_training"."source_type" IN ('hr_direct','self_service','info_collection')
    AND ("personnel_training"."source_type" = 'hr_direct' OR "personnel_training"."source_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "personnel_training_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"record_id" uuid NOT NULL,
	"name" text,
	"category" text,
	"institution" text,
	"start_date" date,
	"end_date" date,
	"hours" numeric,
	"score" numeric,
	"passed" boolean,
	"completed" boolean,
	"credits" numeric,
	"certificate" text,
	"lecturer" text,
	"mentor" text,
	"activity_number" text,
	"has_medal" boolean,
	CONSTRAINT "personnel_training_versions_revision" UNIQUE("tenant_id","record_id","revision")
);
--> statement-breakpoint
CREATE TABLE "personnel_vocational_qualification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"name" text,
	"type" text,
	"level" text,
	"certificate_number" text,
	"issuer" text,
	"obtained_date" date,
	"end_date" date,
	"duration_type" text,
	"major" text,
	"qualification_route" text,
	"is_highest_level" boolean,
	"attachment_id" uuid,
	CONSTRAINT "personnel_vocational_qualification_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "personnel_vocational_qualification_owner_id" UNIQUE("tenant_id","employee_id","id"),
	CONSTRAINT "personnel_vocational_qualification_revision_positive" CHECK ("personnel_vocational_qualification"."revision" > 0),
	CONSTRAINT "personnel_vocational_qualification_source" CHECK ("personnel_vocational_qualification"."source_type" IN ('hr_direct','self_service','info_collection')
    AND ("personnel_vocational_qualification"."source_type" = 'hr_direct' OR "personnel_vocational_qualification"."source_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "personnel_vocational_qualification_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"command_id" text NOT NULL,
	"record_id" uuid NOT NULL,
	"name" text,
	"type" text,
	"level" text,
	"certificate_number" text,
	"issuer" text,
	"obtained_date" date,
	"end_date" date,
	"duration_type" text,
	"major" text,
	"qualification_route" text,
	"is_highest_level" boolean,
	"attachment_id" uuid,
	CONSTRAINT "personnel_vocational_qualification_versions_revision" UNIQUE("tenant_id","record_id","revision")
);
--> statement-breakpoint
ALTER TABLE "personnel_awards" ADD CONSTRAINT "personnel_awards_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_awards" ADD CONSTRAINT "personnel_awards_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_awards_versions" ADD CONSTRAINT "personnel_awards_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_awards_versions" ADD CONSTRAINT "personnel_awards_versions_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_awards_versions" ADD CONSTRAINT "personnel_awards_versions_record_fk" FOREIGN KEY ("tenant_id","employee_id","record_id") REFERENCES "public"."personnel_awards"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_certificate" ADD CONSTRAINT "personnel_certificate_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_certificate" ADD CONSTRAINT "personnel_certificate_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_certificate_versions" ADD CONSTRAINT "personnel_certificate_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_certificate_versions" ADD CONSTRAINT "personnel_certificate_versions_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_certificate_versions" ADD CONSTRAINT "personnel_certificate_versions_record_fk" FOREIGN KEY ("tenant_id","employee_id","record_id") REFERENCES "public"."personnel_certificate"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_change_requests" ADD CONSTRAINT "personnel_change_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_change_requests" ADD CONSTRAINT "personnel_change_requests_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_education" ADD CONSTRAINT "personnel_education_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_education" ADD CONSTRAINT "personnel_education_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_education_versions" ADD CONSTRAINT "personnel_education_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_education_versions" ADD CONSTRAINT "personnel_education_versions_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_education_versions" ADD CONSTRAINT "personnel_education_versions_record_fk" FOREIGN KEY ("tenant_id","employee_id","record_id") REFERENCES "public"."personnel_education"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_employee_versions" ADD CONSTRAINT "personnel_employee_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_employee_versions" ADD CONSTRAINT "personnel_employee_versions_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_employee_versions" ADD CONSTRAINT "personnel_employee_previous_fk" FOREIGN KEY ("tenant_id","employee_id","previous_version_id") REFERENCES "public"."personnel_employee_versions"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_estimation_result" ADD CONSTRAINT "personnel_estimation_result_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_estimation_result" ADD CONSTRAINT "personnel_estimation_result_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_estimation_result_versions" ADD CONSTRAINT "personnel_estimation_result_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_estimation_result_versions" ADD CONSTRAINT "personnel_estimation_result_versions_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_estimation_result_versions" ADD CONSTRAINT "personnel_estimation_result_versions_record_fk" FOREIGN KEY ("tenant_id","employee_id","record_id") REFERENCES "public"."personnel_estimation_result"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_family" ADD CONSTRAINT "personnel_family_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_family" ADD CONSTRAINT "personnel_family_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_family_versions" ADD CONSTRAINT "personnel_family_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_family_versions" ADD CONSTRAINT "personnel_family_versions_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_family_versions" ADD CONSTRAINT "personnel_family_versions_record_fk" FOREIGN KEY ("tenant_id","employee_id","record_id") REFERENCES "public"."personnel_family"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_job_history" ADD CONSTRAINT "personnel_job_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_job_history" ADD CONSTRAINT "personnel_job_history_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_job_history" ADD CONSTRAINT "personnel_job_history_employment_fk" FOREIGN KEY ("tenant_id","employee_id","employment_record_id") REFERENCES "public"."employment_records"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_job_history_versions" ADD CONSTRAINT "personnel_job_history_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_job_history_versions" ADD CONSTRAINT "personnel_job_history_versions_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_job_history_versions" ADD CONSTRAINT "personnel_job_history_versions_record_fk" FOREIGN KEY ("tenant_id","employee_id","record_id") REFERENCES "public"."personnel_job_history"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_language_ability" ADD CONSTRAINT "personnel_language_ability_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_language_ability" ADD CONSTRAINT "personnel_language_ability_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_language_ability_versions" ADD CONSTRAINT "personnel_language_ability_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_language_ability_versions" ADD CONSTRAINT "personnel_language_ability_versions_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_language_ability_versions" ADD CONSTRAINT "personnel_language_ability_versions_record_fk" FOREIGN KEY ("tenant_id","employee_id","record_id") REFERENCES "public"."personnel_language_ability"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_outbox" ADD CONSTRAINT "personnel_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_outbox" ADD CONSTRAINT "personnel_outbox_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_professional_technical_post" ADD CONSTRAINT "personnel_professional_technical_post_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_professional_technical_post" ADD CONSTRAINT "personnel_professional_technical_post_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_professional_technical_post_versions" ADD CONSTRAINT "personnel_professional_technical_post_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_professional_technical_post_versions" ADD CONSTRAINT "personnel_professional_technical_post_versions_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_professional_technical_post_versions" ADD CONSTRAINT "personnel_professional_technical_post_versions_record_fk" FOREIGN KEY ("tenant_id","employee_id","record_id") REFERENCES "public"."personnel_professional_technical_post"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_project_experience" ADD CONSTRAINT "personnel_project_experience_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_project_experience" ADD CONSTRAINT "personnel_project_experience_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_project_experience_versions" ADD CONSTRAINT "personnel_project_experience_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_project_experience_versions" ADD CONSTRAINT "personnel_project_experience_versions_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_project_experience_versions" ADD CONSTRAINT "personnel_project_experience_versions_record_fk" FOREIGN KEY ("tenant_id","employee_id","record_id") REFERENCES "public"."personnel_project_experience"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_punish" ADD CONSTRAINT "personnel_punish_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_punish" ADD CONSTRAINT "personnel_punish_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_punish_versions" ADD CONSTRAINT "personnel_punish_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_punish_versions" ADD CONSTRAINT "personnel_punish_versions_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_punish_versions" ADD CONSTRAINT "personnel_punish_versions_record_fk" FOREIGN KEY ("tenant_id","employee_id","record_id") REFERENCES "public"."personnel_punish"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_skill" ADD CONSTRAINT "personnel_skill_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_skill" ADD CONSTRAINT "personnel_skill_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_skill_versions" ADD CONSTRAINT "personnel_skill_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_skill_versions" ADD CONSTRAINT "personnel_skill_versions_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_skill_versions" ADD CONSTRAINT "personnel_skill_versions_record_fk" FOREIGN KEY ("tenant_id","employee_id","record_id") REFERENCES "public"."personnel_skill"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_training" ADD CONSTRAINT "personnel_training_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_training" ADD CONSTRAINT "personnel_training_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_training_versions" ADD CONSTRAINT "personnel_training_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_training_versions" ADD CONSTRAINT "personnel_training_versions_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_training_versions" ADD CONSTRAINT "personnel_training_versions_record_fk" FOREIGN KEY ("tenant_id","employee_id","record_id") REFERENCES "public"."personnel_training"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_vocational_qualification" ADD CONSTRAINT "personnel_vocational_qualification_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_vocational_qualification" ADD CONSTRAINT "personnel_vocational_qualification_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_vocational_qualification_versions" ADD CONSTRAINT "personnel_vocational_qualification_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_vocational_qualification_versions" ADD CONSTRAINT "personnel_vocational_qualification_versions_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_vocational_qualification_versions" ADD CONSTRAINT "personnel_vocational_qualification_versions_record_fk" FOREIGN KEY ("tenant_id","employee_id","record_id") REFERENCES "public"."personnel_vocational_qualification"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personnel_awards_employee" ON "personnel_awards" USING btree ("tenant_id","employee_id","id");--> statement-breakpoint
CREATE INDEX "personnel_certificate_employee" ON "personnel_certificate" USING btree ("tenant_id","employee_id","id");--> statement-breakpoint
CREATE INDEX "personnel_education_employee" ON "personnel_education" USING btree ("tenant_id","employee_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "personnel_education_is_first_education_one" ON "personnel_education" USING btree ("tenant_id","employee_id") WHERE "personnel_education"."is_first_education" = true AND NOT "personnel_education"."deleted";--> statement-breakpoint
CREATE UNIQUE INDEX "personnel_education_is_highest_education_one" ON "personnel_education" USING btree ("tenant_id","employee_id") WHERE "personnel_education"."is_highest_education" = true AND NOT "personnel_education"."deleted";--> statement-breakpoint
CREATE UNIQUE INDEX "personnel_education_is_highest_degree_one" ON "personnel_education" USING btree ("tenant_id","employee_id") WHERE "personnel_education"."is_highest_degree" = true AND NOT "personnel_education"."deleted";--> statement-breakpoint
CREATE UNIQUE INDEX "personnel_education_is_main_major_one" ON "personnel_education" USING btree ("tenant_id","employee_id") WHERE "personnel_education"."is_main_major" = true AND NOT "personnel_education"."deleted";--> statement-breakpoint
CREATE INDEX "personnel_estimation_result_employee" ON "personnel_estimation_result" USING btree ("tenant_id","employee_id","id");--> statement-breakpoint
CREATE INDEX "personnel_family_employee" ON "personnel_family" USING btree ("tenant_id","employee_id","id");--> statement-breakpoint
CREATE INDEX "personnel_job_history_employee" ON "personnel_job_history" USING btree ("tenant_id","employee_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "personnel_job_history_employment" ON "personnel_job_history" USING btree ("tenant_id","employment_record_id") WHERE "personnel_job_history"."employment_record_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "personnel_language_ability_employee" ON "personnel_language_ability" USING btree ("tenant_id","employee_id","id");--> statement-breakpoint
CREATE INDEX "personnel_outbox_cursor" ON "personnel_outbox" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "personnel_professional_technical_post_employee" ON "personnel_professional_technical_post" USING btree ("tenant_id","employee_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "personnel_professional_technical_post_is_highest_level_one" ON "personnel_professional_technical_post" USING btree ("tenant_id","employee_id") WHERE "personnel_professional_technical_post"."is_highest_level" = true AND NOT "personnel_professional_technical_post"."deleted";--> statement-breakpoint
CREATE INDEX "personnel_project_experience_employee" ON "personnel_project_experience" USING btree ("tenant_id","employee_id","id");--> statement-breakpoint
CREATE INDEX "personnel_punish_employee" ON "personnel_punish" USING btree ("tenant_id","employee_id","id");--> statement-breakpoint
CREATE INDEX "personnel_skill_employee" ON "personnel_skill" USING btree ("tenant_id","employee_id","id");--> statement-breakpoint
CREATE INDEX "personnel_training_employee" ON "personnel_training" USING btree ("tenant_id","employee_id","id");--> statement-breakpoint
CREATE INDEX "personnel_vocational_qualification_employee" ON "personnel_vocational_qualification" USING btree ("tenant_id","employee_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "personnel_vocational_qualification_is_highest_level_one" ON "personnel_vocational_qualification" USING btree ("tenant_id","employee_id") WHERE "personnel_vocational_qualification"."is_highest_level" = true AND NOT "personnel_vocational_qualification"."deleted";