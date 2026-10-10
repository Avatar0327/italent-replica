CREATE TABLE "ev_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ev_cycles_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ev_cycles_name" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "ev_general_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ev_general_items_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "ev_general_items_name" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
ALTER TABLE "ev_cycles" ADD CONSTRAINT "ev_cycles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ev_general_items" ADD CONSTRAINT "ev_general_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- R3-T02 PR-B B1b：统一租户隔离（AGENTS §2；guard-rls）。删除走业务命令，应用角色需要 DELETE。
SELECT enable_tenant_isolation('ev_cycles');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ev_cycles TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('ev_general_items');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ev_general_items TO app_user;
