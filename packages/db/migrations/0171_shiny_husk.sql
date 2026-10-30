CREATE TABLE "exit_account_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"early_enabled" boolean DEFAULT false NOT NULL,
	"basis" text,
	"time" text,
	"in_review" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exit_account_tasks" (
	"tenant_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"handler_user_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"command_id" text NOT NULL,
	"restore_requested" boolean DEFAULT false NOT NULL,
	"auto_revision" integer,
	"recipient_user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	CONSTRAINT "exit_account_tasks_tenant_id_business_id_pk" PRIMARY KEY("tenant_id","business_id"),
	CONSTRAINT "exit_account_tasks_status" CHECK ("exit_account_tasks"."status" IN ('pending','disabled','blocked','restored','skipped','failed'))
);
--> statement-breakpoint
ALTER TABLE "exit_account_settings" ADD CONSTRAINT "exit_account_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_account_tasks" ADD CONSTRAINT "exit_account_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_account_tasks" ADD CONSTRAINT "exit_account_tasks_business_fk" FOREIGN KEY ("tenant_id","employee_id","business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exit_account_tasks_user" ON "exit_account_tasks" USING btree ("tenant_id","user_id","business_id");
--> statement-breakpoint
ALTER TABLE exit_account_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE exit_account_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON exit_account_settings USING (tenant_id=current_tenant_id())
  WITH CHECK (tenant_id=current_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON exit_account_settings TO app_user;

--> statement-breakpoint
ALTER TABLE exit_account_tasks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE exit_account_tasks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON exit_account_tasks USING (tenant_id=current_tenant_id())
  WITH CHECK (tenant_id=current_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON exit_account_tasks TO app_user;
