CREATE TABLE "attachment_blobs" (
	"tenant_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_blobs_tenant_id_file_id_pk" PRIMARY KEY("tenant_id","file_id"),
	CONSTRAINT "attachment_blobs_size" CHECK (octet_length("attachment_blobs"."bytes") <= 10485760)
);
--> statement-breakpoint
CREATE TABLE "attachment_cleanup_attempts" (
	"tenant_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"period" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_cleanup_attempts_tenant_id_file_id_kind_pk" PRIMARY KEY("tenant_id","file_id","kind"),
	CONSTRAINT "attachment_cleanup_kind" CHECK ("attachment_cleanup_attempts"."kind" IN ('expire','purge')),
	CONSTRAINT "attachment_cleanup_status" CHECK ("attachment_cleanup_attempts"."status" IN ('succeeded','failed')),
	CONSTRAINT "attachment_cleanup_attempts_nonneg" CHECK ("attachment_cleanup_attempts"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "attachment_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"owner_employee_id" uuid NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"business_type" text,
	"business_id" uuid,
	"sealed_at" timestamp with time zone,
	"filename" text NOT NULL,
	"declared_type" text NOT NULL,
	"content_type" text,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_at" timestamp with time zone,
	"cleanup_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	CONSTRAINT "attachment_files_tenant_id" UNIQUE("tenant_id","id"),
	CONSTRAINT "attachment_files_status" CHECK ("attachment_files"."status" IN ('registered','uploaded','bound','detached','pending_cleanup','purged')),
	CONSTRAINT "attachment_files_purpose" CHECK ("attachment_files"."purpose" IN ('exit.handwritten_application')),
	CONSTRAINT "attachment_files_size" CHECK ("attachment_files"."byte_size" BETWEEN 1 AND 10485760),
	CONSTRAINT "attachment_files_hash" CHECK ("attachment_files"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "attachment_files_mime" CHECK ("attachment_files"."content_type" IS NULL OR "attachment_files"."content_type" IN ('image/jpeg','image/png','image/gif','image/bmp')),
	CONSTRAINT "attachment_files_bound_business" CHECK ("attachment_files"."status" NOT IN ('bound','detached') OR ("attachment_files"."business_type" IS NOT NULL AND "attachment_files"."business_id" IS NOT NULL)),
	CONSTRAINT "attachment_files_revision" CHECK ("attachment_files"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "attachment_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"command_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_outbox_state" CHECK ("attachment_outbox"."state" IN ('pending','sent','failed','unknown'))
);
--> statement-breakpoint
ALTER TABLE "attachment_blobs" ADD CONSTRAINT "attachment_blobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_blobs" ADD CONSTRAINT "attachment_blobs_file_fk" FOREIGN KEY ("tenant_id","file_id") REFERENCES "public"."attachment_files"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_cleanup_attempts" ADD CONSTRAINT "attachment_cleanup_attempts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_cleanup_attempts" ADD CONSTRAINT "attachment_cleanup_file_fk" FOREIGN KEY ("tenant_id","file_id") REFERENCES "public"."attachment_files"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_files" ADD CONSTRAINT "attachment_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_files" ADD CONSTRAINT "attachment_files_owner_member_fk" FOREIGN KEY ("tenant_id","owner_user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_files" ADD CONSTRAINT "attachment_files_owner_employee_fk" FOREIGN KEY ("tenant_id","owner_employee_id") REFERENCES "public"."employment_employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_outbox" ADD CONSTRAINT "attachment_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_outbox" ADD CONSTRAINT "attachment_outbox_file_fk" FOREIGN KEY ("tenant_id","file_id") REFERENCES "public"."attachment_files"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_files_owner" ON "attachment_files" USING btree ("tenant_id","owner_user_id","purpose","status");--> statement-breakpoint
CREATE INDEX "attachment_files_business" ON "attachment_files" USING btree ("tenant_id","business_type","business_id");--> statement-breakpoint
CREATE INDEX "attachment_files_expiry" ON "attachment_files" USING btree ("tenant_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "attachment_files_cleanup" ON "attachment_files" USING btree ("tenant_id","status","cleanup_at");--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_outbox_command" ON "attachment_outbox" USING btree ("tenant_id","command_id","event_type","file_id");--> statement-breakpoint
CREATE INDEX "attachment_outbox_cursor" ON "attachment_outbox" USING btree ("tenant_id","created_at","id");
--> statement-breakpoint
-- F-479 S1：租户隔离（ENABLE + FORCE RLS，策略 tenant_isolation）与最小授权。
-- attachment_files 不物理删除（清理只改状态）；字节表允许删除（S3 清理释放存储）。
SELECT enable_tenant_isolation('attachment_files');
--> statement-breakpoint
SELECT enable_tenant_isolation('attachment_blobs');
--> statement-breakpoint
SELECT enable_tenant_isolation('attachment_cleanup_attempts');
--> statement-breakpoint
SELECT enable_tenant_isolation('attachment_outbox');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON attachment_files, attachment_cleanup_attempts, attachment_outbox TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON attachment_blobs TO app_user;
--> statement-breakpoint
-- 不可改列（设计 §2.1）：租户、用途、所有人、哈希、大小一经登记不得改写；content_type 与 sealed_at 非空后不得再改，
-- 防止事后改写哈希、改类型或解封。违反按 CHECK 违例（23514）拒绝，业务层映射为 409。
CREATE FUNCTION attachment_files_guard_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
     OR NEW.owner_employee_id IS DISTINCT FROM OLD.owner_employee_id
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
     OR (OLD.content_type IS NOT NULL AND NEW.content_type IS DISTINCT FROM OLD.content_type)
     OR (OLD.sealed_at IS NOT NULL AND NEW.sealed_at IS DISTINCT FROM OLD.sealed_at)
  THEN
    RAISE EXCEPTION '附件元数据的不可改列不得更新' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER attachment_files_immutable
  BEFORE UPDATE ON attachment_files
  FOR EACH ROW EXECUTE FUNCTION attachment_files_guard_immutable();
