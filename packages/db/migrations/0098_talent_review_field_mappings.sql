CREATE TABLE "talent_review_field_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"scene" text NOT NULL,
	"source_field_id" uuid NOT NULL,
	"target_field_id" uuid NOT NULL,
	"preset" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_review_field_mappings_pair" UNIQUE("tenant_id","scene","source_field_id","target_field_id"),
	CONSTRAINT "talent_review_field_mappings_scene" CHECK ("talent_review_field_mappings"."scene" IN ('carry_last','talent_pool')),
	CONSTRAINT "talent_review_field_mappings_rev" CHECK ("talent_review_field_mappings"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "talent_review_field_mappings" ADD CONSTRAINT "talent_review_field_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_field_mappings" ADD CONSTRAINT "talent_review_field_mappings_source_fk" FOREIGN KEY ("tenant_id","source_field_id") REFERENCES "public"."talent_review_fields"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talent_review_field_mappings" ADD CONSTRAINT "talent_review_field_mappings_target_fk" FOREIGN KEY ("tenant_id","target_field_id") REFERENCES "public"."talent_review_fields"("tenant_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
SELECT enable_tenant_isolation('talent_review_field_mappings');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON talent_review_field_mappings TO app_user;
