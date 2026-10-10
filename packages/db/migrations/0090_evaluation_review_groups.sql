CREATE TABLE "ev_review_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"owner_org_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ev_review_groups_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ev_review_groups_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "ev_review_groups_code_format" CHECK ("ev_review_groups"."code" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$')
);
--> statement-breakpoint
CREATE TABLE "ev_review_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"is_leader" boolean DEFAULT false NOT NULL,
	"seq" integer NOT NULL,
	CONSTRAINT "ev_review_members_employee" UNIQUE("tenant_id","group_id","employee_id")
);
--> statement-breakpoint
ALTER TABLE "ev_review_groups" ADD CONSTRAINT "ev_review_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_review_groups" ADD CONSTRAINT "ev_review_groups_owner_org_fk" FOREIGN KEY ("tenant_id","owner_org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_review_members" ADD CONSTRAINT "ev_review_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_review_members" ADD CONSTRAINT "ev_review_members_group_fk" FOREIGN KEY ("tenant_id","group_id") REFERENCES "public"."ev_review_groups"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_review_members" ADD CONSTRAINT "ev_review_members_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ev_review_groups_owner_org" ON "ev_review_groups" USING btree ("tenant_id","owner_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ev_review_members_leader" ON "ev_review_members" USING btree ("tenant_id","group_id") WHERE "ev_review_members"."is_leader";--> statement-breakpoint
CREATE INDEX "ev_review_members_employee_idx" ON "ev_review_members" USING btree ("tenant_id","employee_id");--> statement-breakpoint
-- R3-T02 PR-B B3：统一租户隔离（AGENTS §2；guard-rls）。成员随评审组整组替换，应用角色需要 DELETE。
SELECT enable_tenant_isolation('ev_review_groups');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ev_review_groups TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ev_review_members');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ev_review_members TO app_user;
