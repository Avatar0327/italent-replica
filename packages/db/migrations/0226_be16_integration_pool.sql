CREATE TABLE "onboarding_integration_task_pool" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"assessment_type" text,
	"assessment_name" text,
	"form_fields" jsonb,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "onboarding_integration_pool_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "onboarding_integration_pool_tenant_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "onboarding_integration_pool_category" CHECK ("onboarding_integration_task_pool"."category" IN ('administrative', 'team_integration', 'work_integration', 'new_employee_introduction', 'probation_assessment', 'other')),
	CONSTRAINT "onboarding_integration_pool_revision" CHECK ("onboarding_integration_task_pool"."revision" > 0),
	CONSTRAINT "onboarding_integration_pool_title" CHECK (char_length(btrim("onboarding_integration_task_pool"."code")) BETWEEN 1 AND 100 AND char_length(btrim("onboarding_integration_task_pool"."name")) BETWEEN 1 AND 100),
	CONSTRAINT "onboarding_integration_pool_action" CHECK (("onboarding_integration_task_pool"."category" = 'probation_assessment'
        AND "onboarding_integration_task_pool"."assessment_type" IS NOT NULL AND "onboarding_integration_task_pool"."assessment_type" IN ('probation', 'regularization')
        AND "onboarding_integration_task_pool"."assessment_name" IS NOT NULL AND char_length(btrim("onboarding_integration_task_pool"."assessment_name")) BETWEEN 1 AND 100
        AND "onboarding_integration_task_pool"."form_fields" IS NULL)
        OR ("onboarding_integration_task_pool"."category" <> 'probation_assessment' AND "onboarding_integration_task_pool"."assessment_type" IS NULL AND "onboarding_integration_task_pool"."assessment_name" IS NULL
        AND "onboarding_integration_task_pool"."form_fields" IS NOT NULL AND jsonb_typeof("onboarding_integration_task_pool"."form_fields") = 'array'))
);
--> statement-breakpoint
ALTER TABLE "onboarding_integration_task_pool" ADD CONSTRAINT "onboarding_integration_task_pool_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_integration_task_pool" ADD CONSTRAINT "onboarding_integration_pool_creator_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_integration_task_pool" ADD CONSTRAINT "onboarding_integration_pool_updater_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboarding_integration_pool_category_status" ON "onboarding_integration_task_pool" USING btree ("tenant_id","category","enabled","code","id");--> statement-breakpoint
CREATE INDEX "onboarding_integration_pool_status" ON "onboarding_integration_task_pool" USING btree ("tenant_id","enabled","code","id");
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_integration_task_pool');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON onboarding_integration_task_pool TO app_user;
