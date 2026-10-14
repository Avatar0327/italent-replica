CREATE TABLE "account_avatar_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"content_base64" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_avatar_status" CHECK ("account_avatar_attachments"."status" IN ('registered','uploaded','pending_cleanup')),
	CONSTRAINT "account_avatar_size" CHECK ("account_avatar_attachments"."byte_size">0 AND "account_avatar_attachments"."byte_size"<=5242880),
	CONSTRAINT "account_avatar_hash" CHECK ("account_avatar_attachments"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "account_avatar_mime" CHECK ("account_avatar_attachments"."content_type" IN ('image/jpeg','image/png','image/gif','image/bmp')),
	CONSTRAINT "account_avatar_uploaded" CHECK ("account_avatar_attachments"."status"<>'uploaded' OR "account_avatar_attachments"."content_base64" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "account_avatar_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"command_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_avatar_outbox_state" CHECK ("account_avatar_outbox"."state" IN ('pending','sent','failed','unknown'))
);
--> statement-breakpoint
CREATE TABLE "account_avatar_settings" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_avatar_settings_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id"),
	CONSTRAINT "account_avatar_revision_positive" CHECK ("account_avatar_settings"."revision">0)
);
--> statement-breakpoint
ALTER TABLE "account_avatar_attachments" ADD CONSTRAINT "account_avatar_attachment_owner_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."account_avatar_settings"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_avatar_outbox" ADD CONSTRAINT "account_avatar_outbox_owner_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."account_avatar_settings"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_avatar_settings" ADD CONSTRAINT "account_avatar_member_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_avatar_current" ON "account_avatar_attachments" USING btree ("tenant_id","user_id") WHERE "account_avatar_attachments"."status"='uploaded';--> statement-breakpoint
CREATE INDEX "account_avatar_cleanup" ON "account_avatar_attachments" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "account_avatar_outbox_command" ON "account_avatar_outbox" USING btree ("tenant_id","command_id");--> statement-breakpoint
CREATE INDEX "account_avatar_outbox_cursor" ON "account_avatar_outbox" USING btree ("tenant_id","created_at","id");