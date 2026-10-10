CREATE TABLE "ev_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"owner_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"org_range" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"manager_employee_id" uuid,
	"applicant_mode" text NOT NULL,
	"category_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"level_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"max_level_jump" smallint DEFAULT 1 NOT NULL,
	"effective_date" date,
	"notice_org_range" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"apply_count" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ev_activities_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ev_activities_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "ev_activities_dates" CHECK ("ev_activities"."start_date" <= "ev_activities"."end_date"),
	CONSTRAINT "ev_activities_max_level_jump" CHECK ("ev_activities"."max_level_jump" BETWEEN 1 AND 5),
	CONSTRAINT "ev_activities_applicant_mode" CHECK ("ev_activities"."applicant_mode" IN ('self', 'others', 'both')),
	CONSTRAINT "ev_activities_status" CHECK ("ev_activities"."status" IN ('draft', 'published', 'completed')),
	CONSTRAINT "ev_activities_apply_count" CHECK ("ev_activities"."apply_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ev_chains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"type" text NOT NULL,
	"seq" integer NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"form_id" uuid,
	"approval_process_code" text,
	"material_template" text,
	"hard_deadline" boolean DEFAULT false NOT NULL,
	"allow_exception" boolean DEFAULT false NOT NULL,
	"exception_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"transfer_mode" text DEFAULT 'manual' NOT NULL,
	"notice_template_code" text,
	CONSTRAINT "ev_chains_type" UNIQUE("tenant_id","activity_id","type"),
	CONSTRAINT "ev_chains_type_check" CHECK ("ev_chains"."type" IN ('apply', 'material', 'defense', 'result')),
	CONSTRAINT "ev_chains_dates" CHECK ("ev_chains"."start_date" <= "ev_chains"."end_date"),
	CONSTRAINT "ev_chains_transfer_mode" CHECK ("ev_chains"."transfer_mode" IN ('auto', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "ev_activities" ADD CONSTRAINT "ev_activities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_activities" ADD CONSTRAINT "ev_activities_owner_org_fk" FOREIGN KEY ("tenant_id","owner_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_activities" ADD CONSTRAINT "ev_activities_type_fk" FOREIGN KEY ("tenant_id","type_id") REFERENCES "public"."ev_activity_types"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_activities" ADD CONSTRAINT "ev_activities_cycle_fk" FOREIGN KEY ("tenant_id","cycle_id") REFERENCES "public"."ev_cycles"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_activities" ADD CONSTRAINT "ev_activities_manager_fk" FOREIGN KEY ("tenant_id","manager_employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_chains" ADD CONSTRAINT "ev_chains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_chains" ADD CONSTRAINT "ev_chains_activity_fk" FOREIGN KEY ("tenant_id","activity_id") REFERENCES "public"."ev_activities"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_chains" ADD CONSTRAINT "ev_chains_form_fk" FOREIGN KEY ("tenant_id","form_id") REFERENCES "public"."ev_forms"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ev_activities_owner_org" ON "ev_activities" USING btree ("tenant_id","owner_org_id");--> statement-breakpoint
CREATE INDEX "ev_activities_status" ON "ev_activities" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "ev_chains_form" ON "ev_chains" USING btree ("tenant_id","form_id");
--> statement-breakpoint
-- R3-T02 PR-B B5：统一租户隔离（AGENTS §2；guard-rls）。环节按类型就地更新、移除时删除，应用角色需要 DELETE。
SELECT enable_tenant_isolation('ev_activities');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ev_activities TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ev_chains');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ev_chains TO app_user;
