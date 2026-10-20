ALTER TABLE "retirement_rules" DROP CONSTRAINT "retirement_rules_purpose";--> statement-breakpoint
ALTER TABLE "retirement_rules" DROP CONSTRAINT "retirement_rules_rule_type";--> statement-breakpoint
ALTER TABLE "retirement_rules" DROP CONSTRAINT "retirement_rules_orgs";--> statement-breakpoint
ALTER TABLE "retirement_rules" DROP CONSTRAINT "retirement_rules_age";--> statement-breakpoint
ALTER TABLE "retirement_rules" ADD COLUMN "expected_function" text;--> statement-breakpoint
ALTER TABLE "retirement_rules" ADD COLUMN "earliest_function" text;--> statement-breakpoint
ALTER TABLE "retirement_rules" ADD COLUMN "latest_function" text;--> statement-breakpoint
ALTER TABLE "retirement_rules" ADD COLUMN "all_orgs" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "retirement_rules" ADD COLUMN "preset_code" text;--> statement-breakpoint
ALTER TABLE "retirement_rules" ADD CONSTRAINT "retirement_rules_preset" UNIQUE("tenant_id","preset_code");--> statement-breakpoint
ALTER TABLE "retirement_rules" ADD CONSTRAINT "retirement_rules_preset_code" CHECK ("retirement_rules"."preset_code" IS NULL OR "retirement_rules"."preset_code" IN ('expected_date_statutory', 'flexible_range_statutory'));--> statement-breakpoint
ALTER TABLE "retirement_rules" ADD CONSTRAINT "retirement_rules_expected_function" CHECK ("retirement_rules"."expected_function" IS NULL OR "retirement_rules"."expected_function" = 'statutory_expected_date');--> statement-breakpoint
ALTER TABLE "retirement_rules" ADD CONSTRAINT "retirement_rules_earliest_function" CHECK ("retirement_rules"."earliest_function" IS NULL OR "retirement_rules"."earliest_function" = 'statutory_earliest');--> statement-breakpoint
ALTER TABLE "retirement_rules" ADD CONSTRAINT "retirement_rules_latest_function" CHECK ("retirement_rules"."latest_function" IS NULL OR "retirement_rules"."latest_function" = 'statutory_latest');--> statement-breakpoint
ALTER TABLE "retirement_rules" ADD CONSTRAINT "retirement_rules_shape" CHECK (("retirement_rules"."rule_type" = 'fixed_age' AND "retirement_rules"."purpose" = 'expected_date'
          AND "retirement_rules"."expected_function" IS NULL AND "retirement_rules"."earliest_function" IS NULL AND "retirement_rules"."latest_function" IS NULL)
        OR ("retirement_rules"."rule_type" = 'builtin' AND "retirement_rules"."retirement_age_years" IS NULL AND "retirement_rules"."retirement_age_months" IS NULL
          AND (("retirement_rules"."purpose" = 'expected_date' AND "retirement_rules"."expected_function" IS NOT NULL
              AND "retirement_rules"."earliest_function" IS NULL AND "retirement_rules"."latest_function" IS NULL)
            OR ("retirement_rules"."purpose" = 'flexible_range' AND "retirement_rules"."expected_function" IS NULL
              AND "retirement_rules"."earliest_function" IS NOT NULL AND "retirement_rules"."latest_function" IS NOT NULL))));--> statement-breakpoint
ALTER TABLE "retirement_rules" ADD CONSTRAINT "retirement_rules_purpose" CHECK ("retirement_rules"."purpose" IN ('expected_date', 'flexible_range'));--> statement-breakpoint
ALTER TABLE "retirement_rules" ADD CONSTRAINT "retirement_rules_rule_type" CHECK ("retirement_rules"."rule_type" IN ('fixed_age', 'builtin'));--> statement-breakpoint
ALTER TABLE "retirement_rules" ADD CONSTRAINT "retirement_rules_orgs" CHECK (("retirement_rules"."all_orgs" AND cardinality("retirement_rules"."org_ids") = 0)
        OR (NOT "retirement_rules"."all_orgs" AND cardinality("retirement_rules"."org_ids") BETWEEN 1 AND 50));--> statement-breakpoint
ALTER TABLE "retirement_rules" ADD CONSTRAINT "retirement_rules_age" CHECK ("retirement_rules"."rule_type" <> 'fixed_age' OR ("retirement_rules"."retirement_age_years" BETWEEN 30 AND 80
        AND "retirement_rules"."retirement_age_months" BETWEEN 0 AND 11));
--> statement-breakpoint
-- R2 BE-5c1b：新列的更新授权（沿用 0154 的逐列授权）；规则用途、类型、预置编码创建后不可改，故不授权
GRANT UPDATE (expected_function, earliest_function, latest_function, all_orgs) ON retirement_rules TO app_user;
