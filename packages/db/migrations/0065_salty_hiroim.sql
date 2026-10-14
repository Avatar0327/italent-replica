CREATE TABLE "talent_model_image_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"content_base64" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talent_model_image_attachments_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "talent_model_image_attachments_status" CHECK ("talent_model_image_attachments"."status" IN ('registered','uploaded','pending_cleanup')),
	CONSTRAINT "talent_model_image_attachments_size" CHECK ("talent_model_image_attachments"."byte_size" > 0 AND "talent_model_image_attachments"."byte_size" <= 5242880),
	CONSTRAINT "talent_model_image_attachments_sha256" CHECK ("talent_model_image_attachments"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "talent_model_image_attachments_content_type" CHECK ("talent_model_image_attachments"."content_type" IN ('image/jpeg','image/gif','image/png','image/bmp')),
	CONSTRAINT "talent_model_image_attachments_uploaded" CHECK ("talent_model_image_attachments"."status" <> 'uploaded' OR "talent_model_image_attachments"."content_base64" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "talent_model_image_attachments" ADD CONSTRAINT "talent_model_image_attachments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "talent_model_image_attachments_criterion" ON "talent_model_image_attachments" USING btree ("tenant_id","criterion_id");--> statement-breakpoint
CREATE INDEX "talent_model_image_attachments_cleanup" ON "talent_model_image_attachments" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "talent_model_image_attachments_current" ON "talent_model_image_attachments" USING btree ("tenant_id","criterion_id") WHERE "talent_model_image_attachments"."status" = 'uploaded';