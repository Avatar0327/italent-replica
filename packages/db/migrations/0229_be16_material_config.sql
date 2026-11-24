CREATE TABLE "onboarding_material_items" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"case_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"rule_revision" integer NOT NULL,
	"definition_id" uuid NOT NULL,
	"definition_revision" integer NOT NULL,
	"definition_name" text NOT NULL,
	"required" boolean NOT NULL,
	"allow_supplement" boolean NOT NULL,
	"position" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	CONSTRAINT "onboarding_material_items_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "onboarding_material_item_case_definition" UNIQUE("tenant_id","case_id","definition_id"),
	CONSTRAINT "onboarding_material_item_versions" CHECK ("onboarding_material_items"."revision" > 0 AND "onboarding_material_items"."rule_revision" > 0 AND "onboarding_material_items"."definition_revision" > 0 AND "onboarding_material_items"."position" >= 0),
	CONSTRAINT "onboarding_material_item_status" CHECK (("onboarding_material_items"."status" = 'pending' AND "onboarding_material_items"."submitted_at" IS NULL AND "onboarding_material_items"."received_at" IS NULL)
        OR ("onboarding_material_items"."status" = 'submitted' AND "onboarding_material_items"."submitted_at" IS NOT NULL AND "onboarding_material_items"."received_at" IS NULL)
        OR ("onboarding_material_items"."status" = 'received' AND "onboarding_material_items"."submitted_at" IS NOT NULL
          AND "onboarding_material_items"."received_at" IS NOT NULL AND "onboarding_material_items"."received_at" >= "onboarding_material_items"."submitted_at"))
);
--> statement-breakpoint
CREATE TABLE "onboarding_material_rule_items" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"rule_id" uuid NOT NULL,
	"name" text NOT NULL,
	"required" boolean NOT NULL,
	"allow_supplement" boolean NOT NULL,
	"position" integer NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	CONSTRAINT "onboarding_material_rule_items_tenant_rule_id" UNIQUE("tenant_id","rule_id","id"),
	CONSTRAINT "onboarding_material_rule_item_revision" CHECK ("onboarding_material_rule_items"."revision" > 0),
	CONSTRAINT "onboarding_material_rule_item_position" CHECK ("onboarding_material_rule_items"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "onboarding_material_rules" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"priority" integer NOT NULL,
	"remind_after_hire" boolean DEFAULT false NOT NULL,
	"remind_days" integer,
	CONSTRAINT "onboarding_material_rules_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "onboarding_material_rule_revision" CHECK ("onboarding_material_rules"."revision" > 0),
	CONSTRAINT "onboarding_material_rule_archive" CHECK (NOT "onboarding_material_rules"."archived" OR NOT "onboarding_material_rules"."enabled"),
	CONSTRAINT "onboarding_material_rule_priority" CHECK ("onboarding_material_rules"."priority" >= 0),
	CONSTRAINT "onboarding_material_rule_remind_days" CHECK (("onboarding_material_rules"."remind_days" IS NULL OR "onboarding_material_rules"."remind_days" > 0)
        AND (NOT "onboarding_material_rules"."remind_after_hire" OR "onboarding_material_rules"."remind_days" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "onboarding_material_scope_orgs" (
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	CONSTRAINT "onboarding_material_scope_orgs_tenant_id_rule_id_org_id_pk" PRIMARY KEY("tenant_id","rule_id","org_id")
);
--> statement-breakpoint
ALTER TABLE "onboarding_material_items" ADD CONSTRAINT "onboarding_material_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_material_items" ADD CONSTRAINT "onboarding_material_items_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_material_items" ADD CONSTRAINT "onboarding_material_items_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_material_items" ADD CONSTRAINT "onboarding_material_item_case_fk" FOREIGN KEY ("tenant_id","case_id") REFERENCES "public"."onboarding_entry_cases"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_material_items" ADD CONSTRAINT "onboarding_material_item_definition_fk" FOREIGN KEY ("tenant_id","rule_id","definition_id") REFERENCES "public"."onboarding_material_rule_items"("tenant_id","rule_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_material_rule_items" ADD CONSTRAINT "onboarding_material_rule_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_material_rule_items" ADD CONSTRAINT "onboarding_material_rule_item_rule_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."onboarding_material_rules"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_material_rules" ADD CONSTRAINT "onboarding_material_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_material_rules" ADD CONSTRAINT "onboarding_material_rules_created_by_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_material_rules" ADD CONSTRAINT "onboarding_material_rules_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_material_scope_orgs" ADD CONSTRAINT "onboarding_material_scope_orgs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_material_scope_orgs" ADD CONSTRAINT "onboarding_material_scope_rule_fk" FOREIGN KEY ("tenant_id","rule_id") REFERENCES "public"."onboarding_material_rules"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_material_scope_orgs" ADD CONSTRAINT "onboarding_material_scope_org_fk" FOREIGN KEY ("tenant_id","org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboarding_material_item_definition" ON "onboarding_material_items" USING btree ("tenant_id","rule_id","definition_id");--> statement-breakpoint
CREATE INDEX "onboarding_material_rule_item_list" ON "onboarding_material_rule_items" USING btree ("tenant_id","rule_id","archived","position","id");--> statement-breakpoint
CREATE INDEX "onboarding_material_rules_match" ON "onboarding_material_rules" USING btree ("tenant_id","archived","enabled","priority","id");--> statement-breakpoint
CREATE INDEX "onboarding_material_scope_org" ON "onboarding_material_scope_orgs" USING btree ("tenant_id","org_id","rule_id");
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_material_rules');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_material_scope_orgs');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_material_rule_items');
--> statement-breakpoint
SELECT enable_tenant_isolation('onboarding_material_items');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON onboarding_material_rules, onboarding_material_rule_items,
  onboarding_material_items TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON onboarding_material_scope_orgs TO app_user;
