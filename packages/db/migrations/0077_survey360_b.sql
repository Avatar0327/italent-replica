CREATE TABLE "survey360_report_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_email" text NOT NULL,
	"report_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"token_hash" text NOT NULL,
	"command_id" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "survey360_report_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"show_text_role" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "survey360_report_templates_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "survey360_report_templates_code" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "survey360_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"content" jsonb NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "survey360_reports_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "survey360_reports_object_template" UNIQUE("object_id","template_id")
);
--> statement-breakpoint
CREATE TABLE "survey360_todos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"done_reason" text,
	"sent_at" timestamp with time zone NOT NULL,
	"done_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "survey360_todos_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "survey360_todos_appraiser" UNIQUE("activity_id","person_id"),
	CONSTRAINT "survey360_todos_status" CHECK ("survey360_todos"."status" IN ('open', 'done')),
	CONSTRAINT "survey360_todos_done" CHECK (("survey360_todos"."status" = 'open' AND "survey360_todos"."done_reason" IS NULL AND "survey360_todos"."done_at" IS NULL)
        OR ("survey360_todos"."status" = 'done' AND "survey360_todos"."done_reason" IN ('completed', 'cancelled') AND "survey360_todos"."done_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "survey360_activities" ADD COLUMN "data_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "survey360_activities" ADD COLUMN "suspect_blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "survey360_activities" ADD COLUMN "reports_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "survey360_links" ADD COLUMN "last_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "survey360_questionnaires" ADD COLUMN "template" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "survey360_questionnaires" ADD COLUMN "scoring_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "survey360_score_batches" ADD COLUMN "questionnaire_revisions" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "survey360_sheets" ADD COLUMN "blocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "survey360_sheets" ADD COLUMN "blocked_source" text;--> statement-breakpoint
ALTER TABLE "survey360_sheets" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "survey360_sheets" ADD COLUMN "blocked_by" uuid;--> statement-breakpoint
ALTER TABLE "survey360_report_links" ADD CONSTRAINT "survey360_report_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_report_links" ADD CONSTRAINT "survey360_report_links_activity_fk" FOREIGN KEY ("tenant_id","activity_id") REFERENCES "public"."survey360_activities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_report_templates" ADD CONSTRAINT "survey360_report_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_reports" ADD CONSTRAINT "survey360_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_reports" ADD CONSTRAINT "survey360_reports_activity_fk" FOREIGN KEY ("tenant_id","activity_id") REFERENCES "public"."survey360_activities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_reports" ADD CONSTRAINT "survey360_reports_object_fk" FOREIGN KEY ("tenant_id","object_id") REFERENCES "public"."survey360_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_reports" ADD CONSTRAINT "survey360_reports_template_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."survey360_report_templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_reports" ADD CONSTRAINT "survey360_reports_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."survey360_score_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_todos" ADD CONSTRAINT "survey360_todos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_todos" ADD CONSTRAINT "survey360_todos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_todos" ADD CONSTRAINT "survey360_todos_activity_fk" FOREIGN KEY ("tenant_id","activity_id") REFERENCES "public"."survey360_activities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_todos" ADD CONSTRAINT "survey360_todos_person_fk" FOREIGN KEY ("tenant_id","person_id") REFERENCES "public"."survey360_people"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "survey360_report_links_token" ON "survey360_report_links" USING btree ("tenant_id","token_hash");--> statement-breakpoint
CREATE INDEX "survey360_todos_user" ON "survey360_todos" USING btree ("tenant_id","user_id");--> statement-breakpoint
ALTER TABLE "survey360_sheets" ADD CONSTRAINT "survey360_sheets_blocked" CHECK ((NOT "survey360_sheets"."blocked" AND "survey360_sheets"."blocked_source" IS NULL) OR ("survey360_sheets"."blocked" AND "survey360_sheets"."status" = 'submitted'
        AND "survey360_sheets"."blocked_source" IN ('manual', 'suspected')));