CREATE TABLE "ev_activity_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sync_qualification" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ev_activity_types_tenant_id" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "ev_activity_types" ADD CONSTRAINT "ev_activity_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ev_activity_types_order" ON "ev_activity_types" USING btree ("tenant_id","display_order");--> statement-breakpoint
-- R3-T02 PR-B B1a：统一租户隔离（AGENTS §2；guard-rls）。删除走业务命令，应用角色需要 DELETE。
SELECT enable_tenant_isolation('ev_activity_types');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ev_activity_types TO app_user;
