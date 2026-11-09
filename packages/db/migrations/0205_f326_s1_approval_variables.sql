CREATE TABLE "approval_matrices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_matrices_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "approval_matrices_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "approval_matrices_status" CHECK ("approval_matrices"."status" IN ('draft','enabled','disabled')),
	CONSTRAINT "approval_matrices_revision" CHECK ("approval_matrices"."revision" > 0),
	CONSTRAINT "approval_matrices_name" CHECK (char_length(btrim("approval_matrices"."name")) > 0),
	CONSTRAINT "approval_matrices_code_format" CHECK ("approval_matrices"."code" ~ '^[A-Za-z0-9_]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "approval_matrix_cells" (
	"tenant_id" uuid NOT NULL,
	"row_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	"ref_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	CONSTRAINT "approval_matrix_cells_pk" PRIMARY KEY("tenant_id","row_id","column_id"),
	CONSTRAINT "approval_matrix_cells_size" CHECK (cardinality("approval_matrix_cells"."ref_ids") <= 100)
);
--> statement-breakpoint
CREATE TABLE "approval_matrix_columns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matrix_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dimension" text,
	"include_children" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"seq" integer NOT NULL,
	"allow_multiple" boolean DEFAULT false NOT NULL,
	CONSTRAINT "approval_matrix_columns_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "approval_matrix_columns_name" UNIQUE("tenant_id","matrix_id","name"),
	CONSTRAINT "approval_matrix_columns_name_nonempty" CHECK (char_length(btrim("approval_matrix_columns"."name")) > 0),
	CONSTRAINT "approval_matrix_columns_kind" CHECK (("approval_matrix_columns"."kind" = 'condition' AND "approval_matrix_columns"."dimension" IS NOT NULL AND "approval_matrix_columns"."dimension" IN ('department','position','job'))
        OR ("approval_matrix_columns"."kind" = 'role' AND "approval_matrix_columns"."dimension" IS NULL)),
	CONSTRAINT "approval_matrix_columns_include_children" CHECK (NOT "approval_matrix_columns"."include_children" OR "approval_matrix_columns"."dimension" IS NOT DISTINCT FROM 'department'),
	CONSTRAINT "approval_matrix_columns_allow_multiple" CHECK (NOT "approval_matrix_columns"."allow_multiple" OR "approval_matrix_columns"."kind" = 'role')
);
--> statement-breakpoint
CREATE TABLE "approval_matrix_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"matrix_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	CONSTRAINT "approval_matrix_rows_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "approval_matrix_rows_seq" UNIQUE("tenant_id","matrix_id","seq"),
	CONSTRAINT "approval_matrix_rows_seq_positive" CHECK ("approval_matrix_rows"."seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "approval_variables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"app_id" text,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"data_type" text NOT NULL,
	"default_value" jsonb,
	"usage_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_variables_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "approval_variables_code" UNIQUE("tenant_id","code"),
	CONSTRAINT "approval_variables_scope" CHECK ("approval_variables"."scope" IN ('public','application')),
	CONSTRAINT "approval_variables_data_type" CHECK ("approval_variables"."data_type" IN ('string','integer','decimal','datetime','boolean','person','persons')),
	CONSTRAINT "approval_variables_status" CHECK ("approval_variables"."status" IN ('draft','enabled','disabled')),
	CONSTRAINT "approval_variables_revision" CHECK ("approval_variables"."revision" > 0),
	CONSTRAINT "approval_variables_name" CHECK (char_length(btrim("approval_variables"."name")) > 0),
	CONSTRAINT "approval_variables_code_format" CHECK (("approval_variables"."scope" = 'public' AND "approval_variables"."code" ~ '^Global\.B\.[A-Za-z][A-Za-z0-9_]{0,63}$')
        OR ("approval_variables"."scope" = 'application' AND "approval_variables"."code" ~ '^B\.[A-Za-z0-9_]{1,64}$')),
	CONSTRAINT "approval_variables_scope_columns" CHECK (("approval_variables"."scope" = 'public' AND "approval_variables"."app_id" IS NULL
          AND cardinality("approval_variables"."usage_scopes") >= 1
          AND "approval_variables"."usage_scopes" <@ ARRAY['process','business_rule','message_template']::text[])
        OR ("approval_variables"."scope" = 'application' AND "approval_variables"."app_id" IS NOT NULL
          AND cardinality("approval_variables"."usage_scopes") = 0 AND "approval_variables"."description" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "approval_matrices" ADD CONSTRAINT "approval_matrices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_matrices" ADD CONSTRAINT "approval_matrices_creator" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_matrices" ADD CONSTRAINT "approval_matrices_updater" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_matrix_cells" ADD CONSTRAINT "approval_matrix_cells_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_matrix_cells" ADD CONSTRAINT "approval_matrix_cells_row" FOREIGN KEY ("tenant_id","row_id") REFERENCES "public"."approval_matrix_rows"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_matrix_cells" ADD CONSTRAINT "approval_matrix_cells_column" FOREIGN KEY ("tenant_id","column_id") REFERENCES "public"."approval_matrix_columns"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_matrix_columns" ADD CONSTRAINT "approval_matrix_columns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_matrix_columns" ADD CONSTRAINT "approval_matrix_columns_matrix" FOREIGN KEY ("tenant_id","matrix_id") REFERENCES "public"."approval_matrices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_matrix_rows" ADD CONSTRAINT "approval_matrix_rows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_matrix_rows" ADD CONSTRAINT "approval_matrix_rows_matrix" FOREIGN KEY ("tenant_id","matrix_id") REFERENCES "public"."approval_matrices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_variables" ADD CONSTRAINT "approval_variables_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_variables" ADD CONSTRAINT "approval_variables_creator" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_variables" ADD CONSTRAINT "approval_variables_updater" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_matrices_list" ON "approval_matrices" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "approval_variables_list" ON "approval_variables" USING btree ("tenant_id","scope","status");--> statement-breakpoint
-- F-326 S1：五张表 FORCE RLS（租户隔离，F-212）；变量与矩阵头只启停不删除，故不授 DELETE（设计 §2.5）。
SELECT enable_tenant_isolation('approval_variables');--> statement-breakpoint
SELECT enable_tenant_isolation('approval_matrices');--> statement-breakpoint
SELECT enable_tenant_isolation('approval_matrix_columns');--> statement-breakpoint
SELECT enable_tenant_isolation('approval_matrix_rows');--> statement-breakpoint
SELECT enable_tenant_isolation('approval_matrix_cells');--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON approval_variables TO app_user;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON approval_matrices TO app_user;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON approval_matrix_columns TO app_user;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON approval_matrix_rows TO app_user;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON approval_matrix_cells TO app_user;
