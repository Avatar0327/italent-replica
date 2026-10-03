ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_tenant_id" UNIQUE("tenant_id","id");--> statement-breakpoint
CREATE TABLE "permission_dynamic_org_grants" (
	"tenant_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"role_code" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "permission_dynamic_org_grants_tenant_id_grant_id_pk" PRIMARY KEY("tenant_id","grant_id"),
	CONSTRAINT "permission_dynamic_grants_role" CHECK ("permission_dynamic_org_grants"."role_code" IN ('head','hrbp')),
	CONSTRAINT "permission_dynamic_grants_revision" CHECK ("permission_dynamic_org_grants"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "permission_identity_scopes" (
	"tenant_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"app_code" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_code" text DEFAULT '' NOT NULL,
	"see_all" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "permission_identity_scopes_tenant_id_profile_id_app_code_target_kind_target_code_pk" PRIMARY KEY("tenant_id","profile_id","app_code","target_kind","target_code"),
	CONSTRAINT "permission_identity_scopes_target" CHECK ("permission_identity_scopes"."target_kind" IN ('app','entity','page','datasource')),
	CONSTRAINT "permission_identity_scopes_code" CHECK (("permission_identity_scopes"."target_kind"='app' AND "permission_identity_scopes"."target_code"='')
    OR ("permission_identity_scopes"."target_kind"<>'app' AND btrim("permission_identity_scopes"."target_code")<>'')),
	CONSTRAINT "permission_identity_scopes_revision" CHECK ("permission_identity_scopes"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "permission_mou_org_refs" (
	"tenant_id" uuid NOT NULL,
	"mou_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"dimension" text DEFAULT 'admin' NOT NULL,
	"include_descendants" boolean DEFAULT false NOT NULL,
	CONSTRAINT "permission_mou_org_refs_tenant_id_mou_id_org_id_dimension_pk" PRIMARY KEY("tenant_id","mou_id","org_id","dimension"),
	CONSTRAINT "permission_mou_refs_dimension" CHECK ("permission_mou_org_refs"."dimension" IN ('admin','business','product','reserve4','reserve5'))
);
--> statement-breakpoint
CREATE TABLE "permission_mous" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"kind" text DEFAULT 'named' NOT NULL,
	"owner_user_id" uuid,
	"app_code" text,
	"status" text DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_mous_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "permission_mous_tenant_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "permission_mous_kind" CHECK ("permission_mous"."kind" IN ('named', 'virtual')),
	CONSTRAINT "permission_mous_status" CHECK ("permission_mous"."status" IN ('active', 'disabled', 'deleted')),
	CONSTRAINT "permission_mous_owner_kind" CHECK (("permission_mous"."kind"='named' AND "permission_mous"."owner_user_id" IS NULL AND "permission_mous"."app_code" IS NULL)
    OR ("permission_mous"."kind"='virtual' AND "permission_mous"."owner_user_id" IS NOT NULL AND "permission_mous"."app_code" IS NOT NULL)),
	CONSTRAINT "permission_mous_revision" CHECK ("permission_mous"."revision" > 0),
	CONSTRAINT "permission_mous_name" CHECK (btrim("permission_mous"."code") <> '' AND btrim("permission_mous"."name") <> '')
);
--> statement-breakpoint
CREATE TABLE "permission_scope_apps" (
	"tenant_id" uuid NOT NULL,
	"app_code" text NOT NULL,
	"family" text DEFAULT 'other' NOT NULL,
	"allowed_kinds" text[] DEFAULT ARRAY['default','mou','org_range']::text[] NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "permission_scope_apps_tenant_id_app_code_pk" PRIMARY KEY("tenant_id","app_code"),
	CONSTRAINT "permission_scope_apps_family" CHECK ("permission_scope_apps"."family" IN ('hr','attendance','other','payroll')),
	CONSTRAINT "permission_scope_apps_kinds" CHECK ("permission_scope_apps"."allowed_kinds" <@ ARRAY['default','mou','org_range']::text[]),
	CONSTRAINT "permission_scope_apps_revision" CHECK ("permission_scope_apps"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "permission_scope_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"app_code" text NOT NULL,
	"object_code" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_code" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"person_field" text,
	"department_field" text,
	"creator_field" text,
	CONSTRAINT "permission_scope_policies_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "permission_scope_policies_target" UNIQUE("tenant_id","app_code","object_code","target_kind","target_code"),
	CONSTRAINT "permission_scope_policies_target_kind" CHECK ("permission_scope_policies"."target_kind" IN ('entity','page','datasource')),
	CONSTRAINT "permission_scope_policies_revision" CHECK ("permission_scope_policies"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "permission_scope_policy_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"dimension" text NOT NULL,
	"role_code" text,
	"relation_mode" text,
	CONSTRAINT "permission_scope_rules_dimension" CHECK ("permission_scope_policy_rules"."dimension" IN ('management','organization','reporting','using_user'))
);
--> statement-breakpoint
CREATE TABLE "permission_scope_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"command_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_scope_versions_object_revision" UNIQUE("tenant_id","object_type","object_id","revision"),
	CONSTRAINT "permission_scope_versions_revision" CHECK ("permission_scope_versions"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "permission_user_app_scopes" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"app_code" text NOT NULL,
	"kind" text DEFAULT 'default' NOT NULL,
	"mou_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "permission_user_app_scopes_tenant_id_user_id_app_code_pk" PRIMARY KEY("tenant_id","user_id","app_code"),
	CONSTRAINT "permission_scopes_kind" CHECK ("permission_user_app_scopes"."kind" IN ('default', 'mou', 'org_range')),
	CONSTRAINT "permission_scopes_mou_kind" CHECK (("permission_user_app_scopes"."kind"='default' AND "permission_user_app_scopes"."mou_id" IS NULL)
    OR ("permission_user_app_scopes"."kind"<>'default' AND "permission_user_app_scopes"."mou_id" IS NOT NULL)),
	CONSTRAINT "permission_scopes_revision" CHECK ("permission_user_app_scopes"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "permission_user_person_links" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "permission_user_person_links_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id"),
	CONSTRAINT "permission_person_links_employee" UNIQUE("tenant_id","employee_id"),
	CONSTRAINT "permission_person_links_revision" CHECK ("permission_user_person_links"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "permission_dynamic_org_grants" ADD CONSTRAINT "permission_dynamic_org_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_dynamic_org_grants" ADD CONSTRAINT "permission_dynamic_grants_grant" FOREIGN KEY ("tenant_id","grant_id") REFERENCES "public"."permission_grants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_identity_scopes" ADD CONSTRAINT "permission_identity_scopes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_identity_scopes" ADD CONSTRAINT "permission_identity_scopes_profile" FOREIGN KEY ("tenant_id","profile_id") REFERENCES "public"."permission_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_mou_org_refs" ADD CONSTRAINT "permission_mou_org_refs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_mou_org_refs" ADD CONSTRAINT "permission_mou_refs_mou" FOREIGN KEY ("tenant_id","mou_id") REFERENCES "public"."permission_mous"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_mou_org_refs" ADD CONSTRAINT "permission_mou_refs_org" FOREIGN KEY ("tenant_id","org_id") REFERENCES "public"."org_objects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_mous" ADD CONSTRAINT "permission_mous_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_mous" ADD CONSTRAINT "permission_mous_parent" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."permission_mous"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_mous" ADD CONSTRAINT "permission_mous_owner" FOREIGN KEY ("tenant_id","owner_user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_scope_apps" ADD CONSTRAINT "permission_scope_apps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_scope_policies" ADD CONSTRAINT "permission_scope_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_scope_policy_rules" ADD CONSTRAINT "permission_scope_policy_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_scope_policy_rules" ADD CONSTRAINT "permission_scope_rules_policy" FOREIGN KEY ("tenant_id","policy_id") REFERENCES "public"."permission_scope_policies"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_scope_versions" ADD CONSTRAINT "permission_scope_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_user_app_scopes" ADD CONSTRAINT "permission_user_app_scopes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_user_app_scopes" ADD CONSTRAINT "permission_scopes_member" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_user_app_scopes" ADD CONSTRAINT "permission_scopes_mou" FOREIGN KEY ("tenant_id","mou_id") REFERENCES "public"."permission_mous"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_user_person_links" ADD CONSTRAINT "permission_user_person_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_user_person_links" ADD CONSTRAINT "permission_person_links_member" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_user_person_links" ADD CONSTRAINT "permission_person_links_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "permission_mous_virtual_owner" ON "permission_mous" USING btree ("tenant_id","owner_user_id","app_code") WHERE "permission_mous"."kind" = 'virtual';--> statement-breakpoint
CREATE INDEX "permission_mous_list" ON "permission_mous" USING btree ("tenant_id","kind","status","code");--> statement-breakpoint
CREATE INDEX "permission_scope_rules_policy_lookup" ON "permission_scope_policy_rules" USING btree ("tenant_id","policy_id");--> statement-breakpoint
CREATE INDEX "permission_scopes_mou_usage" ON "permission_user_app_scopes" USING btree ("tenant_id","mou_id");--> statement-breakpoint
