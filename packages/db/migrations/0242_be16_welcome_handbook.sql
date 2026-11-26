CREATE TABLE "onboarding_handbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"blocks" jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "onboarding_handbooks_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "onboarding_handbooks_revision" CHECK ("onboarding_handbooks"."revision" > 0),
	CONSTRAINT "onboarding_handbooks_text" CHECK (char_length(btrim("onboarding_handbooks"."name")) BETWEEN 1 AND 100 AND char_length(btrim("onboarding_handbooks"."title")) BETWEEN 1 AND 200),
	CONSTRAINT "onboarding_handbooks_blocks" CHECK (jsonb_typeof("onboarding_handbooks"."blocks") = 'array'),
	CONSTRAINT "onboarding_handbooks_archived" CHECK ("onboarding_handbooks"."archived_at" IS NULL OR NOT "onboarding_handbooks"."enabled")
);
--> statement-breakpoint
CREATE TABLE "onboarding_welcome_jobs" (
	"tenant_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "onboarding_welcome_jobs_tenant_id_case_id_pk" PRIMARY KEY("tenant_id","case_id"),
	CONSTRAINT "onboarding_welcome_job_status" CHECK ("onboarding_welcome_jobs"."status" IN ('pending','done','skipped','failed')),
	CONSTRAINT "onboarding_welcome_job_attempts" CHECK ("onboarding_welcome_jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "onboarding_welcome_letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"variables" jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "onboarding_welcome_letters_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "onboarding_welcome_letters_revision" CHECK ("onboarding_welcome_letters"."revision" > 0),
	CONSTRAINT "onboarding_welcome_letters_text" CHECK (char_length(btrim("onboarding_welcome_letters"."name")) BETWEEN 1 AND 100 AND char_length(btrim("onboarding_welcome_letters"."title")) BETWEEN 1 AND 200
        AND char_length(btrim("onboarding_welcome_letters"."body")) BETWEEN 1 AND 5000),
	CONSTRAINT "onboarding_welcome_letters_variables" CHECK (jsonb_typeof("onboarding_welcome_letters"."variables") = 'array'),
	CONSTRAINT "onboarding_welcome_letters_archived" CHECK ("onboarding_welcome_letters"."archived_at" IS NULL OR NOT "onboarding_welcome_letters"."enabled")
);
--> statement-breakpoint
ALTER TABLE "onboarding_handbooks" ADD CONSTRAINT "onboarding_handbooks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_handbooks" ADD CONSTRAINT "onboarding_handbooks_creator_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_handbooks" ADD CONSTRAINT "onboarding_handbooks_updater_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_welcome_jobs" ADD CONSTRAINT "onboarding_welcome_job_case_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."onboarding_entry_cases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_welcome_letters" ADD CONSTRAINT "onboarding_welcome_letters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_welcome_letters" ADD CONSTRAINT "onboarding_welcome_letters_creator_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_welcome_letters" ADD CONSTRAINT "onboarding_welcome_letters_updater_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboarding_handbooks_list" ON "onboarding_handbooks" USING btree ("tenant_id","name","id");--> statement-breakpoint
CREATE INDEX "onboarding_welcome_job_due" ON "onboarding_welcome_jobs" USING btree ("tenant_id","next_attempt_at","case_id") WHERE "onboarding_welcome_jobs"."status" IN ('pending','failed');--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_welcome_letters_one_enabled" ON "onboarding_welcome_letters" USING btree ("tenant_id") WHERE "onboarding_welcome_letters"."enabled";--> statement-breakpoint
CREATE INDEX "onboarding_welcome_letters_list" ON "onboarding_welcome_letters" USING btree ("tenant_id","name","id");
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_welcome_letters');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_handbooks');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_welcome_jobs');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON onboarding_welcome_letters, onboarding_handbooks, onboarding_welcome_jobs TO app_user;
