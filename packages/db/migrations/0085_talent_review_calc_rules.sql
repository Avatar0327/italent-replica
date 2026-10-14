CREATE TABLE "talent_review_calc_rule_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"target_field_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"description" text,
	"formula" text NOT NULL,
	"sort_no" integer DEFAULT 0 NOT NULL,
	"uses_ranking" boolean DEFAULT false NOT NULL,
	CONSTRAINT "talent_review_calc_rule_items_target" UNIQUE("tenant_id","rule_id","target_field_id"),
	CONSTRAINT "talent_review_calc_rule_items_priority" CHECK ("talent_review_calc_rule_items"."priority" >= 0)
);
--> statement-breakpoint
CREATE TABLE "talent_review_calc_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"assessment_latest_window" text DEFAULT 'before_project_end' NOT NULL,
	"description" text,
	"sort_no" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_review_calc_rules_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_review_calc_rules_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "talent_review_calc_rules_window" CHECK ("talent_review_calc_rules"."assessment_latest_window" IN ('before_project_end','before_project_start')),
	CONSTRAINT "talent_review_calc_rules_rev" CHECK ("talent_review_calc_rules"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "talent_review_calc_rule_items" ADD CONSTRAINT "talent_review_calc_rule_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_calc_rule_items" ADD CONSTRAINT "talent_review_calc_rule_items_rule_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."talent_review_calc_rules"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_calc_rule_items" ADD CONSTRAINT "talent_review_calc_rule_items_field_fk" FOREIGN KEY ("tenant_id","target_field_id") REFERENCES "public"."talent_review_fields"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_calc_rules" ADD CONSTRAINT "talent_review_calc_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- R3-T04 PR-B5：计算规则与计算项目统一租户隔离（AGENTS §2；guard-rls）。项目随规则整体增删，应用角色需要 DELETE。
SELECT enable_tenant_isolation('talent_review_calc_rules');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_calc_rule_items');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_review_calc_rules, talent_review_calc_rule_items TO app_user;
