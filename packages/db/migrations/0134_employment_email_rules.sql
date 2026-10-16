CREATE TABLE "employment_email_rule_sets" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employment_email_rules" (
	"tenant_id" uuid NOT NULL,
	"set_revision" integer NOT NULL,
	"rule_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"name" text NOT NULL,
	"priority" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"org_ids" uuid[] NOT NULL,
	"employ_types" text[] DEFAULT '{}' NOT NULL,
	"prefix_field" text NOT NULL,
	"domain" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employment_email_rules_pk" PRIMARY KEY("tenant_id","set_revision","ordinal"),
	CONSTRAINT "employment_email_rules_rule" UNIQUE("tenant_id","set_revision","rule_id"),
	CONSTRAINT "employment_email_rules_priority" CHECK ("employment_email_rules"."priority" >= 0),
	CONSTRAINT "employment_email_rules_prefix_field" CHECK ("employment_email_rules"."prefix_field" IN ('employeeCode', 'namePinyin', 'pinyinInitials')),
	CONSTRAINT "employment_email_rules_orgs" CHECK (cardinality("employment_email_rules"."org_ids") BETWEEN 1 AND 50),
	CONSTRAINT "employment_email_rules_name" CHECK (btrim("employment_email_rules"."name") <> '')
);
--> statement-breakpoint
ALTER TABLE "employment_email_rule_sets" ADD CONSTRAINT "employment_email_rule_sets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_email_rules" ADD CONSTRAINT "employment_email_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employment_email_rules_set" ON "employment_email_rules" USING btree ("tenant_id","set_revision");--> statement-breakpoint
-- R2 BE-2b：入职生成邮箱规则，租户隔离；头表只改版本号，规则行按版本只追加（不给 UPDATE / DELETE）
SELECT enable_tenant_isolation('employment_email_rule_sets');
--> statement-breakpoint
SELECT enable_tenant_isolation('employment_email_rules');
--> statement-breakpoint
GRANT SELECT, INSERT ON employment_email_rule_sets TO app_user;
--> statement-breakpoint
GRANT UPDATE (revision, updated_at) ON employment_email_rule_sets TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT ON employment_email_rules TO app_user;
--> statement-breakpoint
CREATE TRIGGER employment_email_rules_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON employment_email_rules FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
