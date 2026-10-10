CREATE TABLE "talent_review_flow_node_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"sort_no" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "talent_review_flow_node_roles_role" UNIQUE("tenant_id","node_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "talent_review_flow_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"node_key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"step_type" text NOT NULL,
	"mode" text NOT NULL,
	"allow_return" boolean DEFAULT false NOT NULL,
	"allow_transfer" boolean DEFAULT false NOT NULL,
	"allow_disagree" boolean DEFAULT false NOT NULL,
	"sort_no" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "talent_review_flow_nodes_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_review_flow_nodes_key" UNIQUE("tenant_id","flow_id","node_key"),
	CONSTRAINT "talent_review_flow_nodes_key_format" CHECK ("talent_review_flow_nodes"."node_key" ~ '^[a-z][a-z0-9_]{0,31}$'),
	CONSTRAINT "talent_review_flow_nodes_kind" CHECK ("talent_review_flow_nodes"."kind" IN ('single','countersign')),
	CONSTRAINT "talent_review_flow_nodes_step_type" CHECK ("talent_review_flow_nodes"."step_type" IN ('evaluate','calibrate')),
	CONSTRAINT "talent_review_flow_nodes_mode" CHECK ("talent_review_flow_nodes"."mode" IN ('single','batch')),
	CONSTRAINT "talent_review_flow_nodes_countersign" CHECK ("talent_review_flow_nodes"."kind" <> 'countersign' OR ("talent_review_flow_nodes"."step_type" = 'evaluate' AND "talent_review_flow_nodes"."mode" = 'single'))
);
--> statement-breakpoint
CREATE TABLE "talent_review_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_no" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_review_flows_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_review_flows_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "talent_review_flows_rev" CHECK ("talent_review_flows"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "talent_review_form_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"access" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"sort_no" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "talent_review_form_fields_field" UNIQUE("tenant_id","form_id","field_id"),
	CONSTRAINT "talent_review_form_fields_access" CHECK ("talent_review_form_fields"."access" IN ('edit','view','hidden')),
	CONSTRAINT "talent_review_form_fields_required" CHECK (NOT "talent_review_form_fields"."required" OR "talent_review_form_fields"."access" = 'edit')
);
--> statement-breakpoint
CREATE TABLE "talent_review_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"preset" boolean DEFAULT false NOT NULL,
	"sort_no" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_review_forms_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_review_forms_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "talent_review_forms_name" UNIQUE("tenant_id","name"),
	CONSTRAINT "talent_review_forms_code_format" CHECK ("talent_review_forms"."code" ~ '^[A-Za-z][A-Za-z0-9_]{0,49}$'),
	CONSTRAINT "talent_review_forms_kind" CHECK ("talent_review_forms"."kind" IN ('info','calibrate_edit','succession_edit')),
	CONSTRAINT "talent_review_forms_rev" CHECK ("talent_review_forms"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "talent_review_flow_node_roles" ADD CONSTRAINT "talent_review_flow_node_roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_flow_node_roles" ADD CONSTRAINT "talent_review_flow_node_roles_node_fk" FOREIGN KEY ("tenant_id","node_id") REFERENCES "public"."talent_review_flow_nodes"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_flow_node_roles" ADD CONSTRAINT "talent_review_flow_node_roles_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "public"."talent_review_roles"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_flow_nodes" ADD CONSTRAINT "talent_review_flow_nodes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_flow_nodes" ADD CONSTRAINT "talent_review_flow_nodes_flow_fk" FOREIGN KEY ("tenant_id","flow_id") REFERENCES "public"."talent_review_flows"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_flows" ADD CONSTRAINT "talent_review_flows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_form_fields" ADD CONSTRAINT "talent_review_form_fields_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_form_fields" ADD CONSTRAINT "talent_review_form_fields_form_fk" FOREIGN KEY ("tenant_id","form_id") REFERENCES "public"."talent_review_forms"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_form_fields" ADD CONSTRAINT "talent_review_form_fields_field_fk" FOREIGN KEY ("tenant_id","field_id") REFERENCES "public"."talent_review_fields"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_forms" ADD CONSTRAINT "talent_review_forms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_forms');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_form_fields');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_flows');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_flow_nodes');
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_flow_node_roles');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_review_forms, talent_review_form_fields, talent_review_flows, talent_review_flow_nodes, talent_review_flow_node_roles TO app_user;
