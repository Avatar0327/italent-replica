CREATE TABLE "ev_condition_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"condition_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"seq" integer NOT NULL,
	"source" text NOT NULL,
	"field" text NOT NULL,
	"operator" text NOT NULL,
	"value1" text,
	"value2" text,
	"value1_type" text,
	"value2_type" text,
	CONSTRAINT "ev_condition_details_seq" UNIQUE("tenant_id","condition_id","seq"),
	CONSTRAINT "ev_condition_details_position" UNIQUE("tenant_id","condition_id","position"),
	CONSTRAINT "ev_condition_details_order" CHECK ("ev_condition_details"."seq" > 0 AND "ev_condition_details"."position" >= 0),
	CONSTRAINT "ev_condition_details_field" CHECK (length(btrim("ev_condition_details"."source")) > 0 AND length(btrim("ev_condition_details"."field")) > 0),
	CONSTRAINT "ev_condition_details_operator" CHECK ("ev_condition_details"."operator" IN ('eq', 'ne', 'gt', 'lt', 'ge', 'le', 'is_empty', 'not_empty', 'between')),
	CONSTRAINT "ev_condition_details_types" CHECK (("ev_condition_details"."value1" IS NULL) = ("ev_condition_details"."value1_type" IS NULL)
      AND ("ev_condition_details"."value2" IS NULL) = ("ev_condition_details"."value2_type" IS NULL)
      AND ("ev_condition_details"."value1_type" IS NULL OR "ev_condition_details"."value1_type" IN ('string', 'number'))
      AND ("ev_condition_details"."value2_type" IS NULL OR "ev_condition_details"."value2_type" IN ('string', 'number'))),
	CONSTRAINT "ev_condition_details_values" CHECK (CASE WHEN "ev_condition_details"."operator" IN ('is_empty', 'not_empty') THEN "ev_condition_details"."value1" IS NULL AND "ev_condition_details"."value2" IS NULL
      WHEN "ev_condition_details"."operator" = 'between' THEN "ev_condition_details"."value1" IS NOT NULL AND "ev_condition_details"."value2" IS NOT NULL
      ELSE "ev_condition_details"."value1" IS NOT NULL AND "ev_condition_details"."value2" IS NULL END)
);
--> statement-breakpoint
CREATE TABLE "ev_conditions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"applicant_kind" text NOT NULL,
	"category_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"level_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"expression" text,
	CONSTRAINT "ev_conditions_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ev_conditions_seq" UNIQUE("tenant_id","activity_id","seq"),
	CONSTRAINT "ev_conditions_kind" CHECK ("ev_conditions"."kind" IN ('common', 'extra')),
	CONSTRAINT "ev_conditions_applicant" CHECK ("ev_conditions"."applicant_kind" IN ('self', 'others')),
	CONSTRAINT "ev_conditions_seq_nonnegative" CHECK ("ev_conditions"."seq" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ev_condition_details" ADD CONSTRAINT "ev_condition_details_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_condition_details" ADD CONSTRAINT "ev_condition_details_condition_fk" FOREIGN KEY ("tenant_id","condition_id") REFERENCES "public"."ev_conditions"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_conditions" ADD CONSTRAINT "ev_conditions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_conditions" ADD CONSTRAINT "ev_conditions_activity_fk" FOREIGN KEY ("tenant_id","activity_id") REFERENCES "public"."ev_activities"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- B6：条件与明细按租户隔离，随活动整份替换或级联删除（AGENTS §2 / §10）。
SELECT enable_tenant_isolation('ev_conditions');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ev_conditions TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ev_condition_details');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ev_condition_details TO app_user;
