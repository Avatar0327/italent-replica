CREATE TABLE "permission_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"event_type" text NOT NULL,
	"revision" integer,
	"command_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_outbox_state" CHECK ("permission_outbox"."state" IN ('pending', 'sent', 'failed', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "license_seats" DROP CONSTRAINT "license_seats_pool";
--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD COLUMN "user_type" text;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD COLUMN "business_identity" text;--> statement-breakpoint
ALTER TABLE "permission_outbox" ADD CONSTRAINT "permission_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "permission_outbox_cursor" ON "permission_outbox" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_type_valid" CHECK ("tenant_memberships"."user_type" IN ('internal', 'external'));--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_business_identity" CHECK (("tenant_memberships"."user_type" = 'external' AND "tenant_memberships"."business_identity" IS NOT NULL AND btrim("tenant_memberships"."business_identity") <> '')
    OR ("tenant_memberships"."user_type" IS DISTINCT FROM 'external' AND "tenant_memberships"."business_identity" IS NULL));