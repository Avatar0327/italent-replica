CREATE TABLE "survey360_answer_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "survey360_answer_sessions_token" UNIQUE("tenant_id","token_hash")
);
--> statement-breakpoint
CREATE TABLE "survey360_key_retire_runs" (
	"run_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"credential_key_version" smallint NOT NULL,
	"compromised" boolean NOT NULL,
	"status" text NOT NULL,
	"cursor_link_id" uuid,
	"credentials_done" integer DEFAULT 0 NOT NULL,
	"sessions_done" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "survey360_key_retire_runs_tenant_id_run_id_pk" PRIMARY KEY("tenant_id","run_id"),
	CONSTRAINT "survey360_key_retire_runs_status" CHECK ("survey360_key_retire_runs"."status" IN ('running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "survey360_login_throttle" (
	"tenant_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"key_hash" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "survey360_login_throttle_tenant_id_scope_key_hash_pk" PRIMARY KEY("tenant_id","scope","key_hash"),
	CONSTRAINT "survey360_login_throttle_scope" CHECK ("survey360_login_throttle"."scope" IN ('ip', 'pair', 'tenant')),
	CONSTRAINT "survey360_login_throttle_counts" CHECK ("survey360_login_throttle"."requests" >= 0 AND "survey360_login_throttle"."failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE "survey360_security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"link_id" uuid,
	"old_link_id" uuid,
	"activity_id" uuid,
	"session_id" uuid,
	"run_id" uuid,
	"credential_key_version" smallint,
	"compromised" boolean,
	"scope" text,
	"key_prefix" text,
	"ip_prefix" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "survey360_security_events_kind" CHECK ("survey360_security_events"."kind" IN ('login_success', 'logout', 'lock', 'unlock', 'credential_issued', 'credential_reissued',
        'credential_revoked', 'key_rotated', 'key_retired'))
);
--> statement-breakpoint
ALTER TABLE "survey360_links" ADD COLUMN "credential_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "survey360_links" ADD COLUMN "serial_lookup" text;--> statement-breakpoint
ALTER TABLE "survey360_links" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "survey360_links" ADD COLUMN "credential_key_version" smallint;--> statement-breakpoint
ALTER TABLE "survey360_links" ADD COLUMN "credential_key_versions" smallint[] DEFAULT '{}'::smallint[] NOT NULL;--> statement-breakpoint
ALTER TABLE "survey360_links" ADD COLUMN "credential_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "survey360_links" ADD COLUMN "credential_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "survey360_links" ADD COLUMN "credential_error" text;--> statement-breakpoint
-- 会话表的复合外键引用 (tenant_id, id)，唯一约束必须先建
ALTER TABLE "survey360_links" ADD CONSTRAINT "survey360_links_tenant_id" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "survey360_answer_sessions" ADD CONSTRAINT "survey360_answer_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_answer_sessions" ADD CONSTRAINT "survey360_answer_sessions_link_fk" FOREIGN KEY ("tenant_id","link_id") REFERENCES "public"."survey360_links"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_key_retire_runs" ADD CONSTRAINT "survey360_key_retire_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_login_throttle" ADD CONSTRAINT "survey360_login_throttle_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey360_security_events" ADD CONSTRAINT "survey360_security_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "survey360_answer_sessions_link" ON "survey360_answer_sessions" USING btree ("tenant_id","link_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "survey360_links_serial" ON "survey360_links" USING btree ("tenant_id","credential_key_version","serial_lookup") WHERE "survey360_links"."serial_lookup" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "survey360_links_credential_pending" ON "survey360_links" USING btree ("tenant_id","created_at") WHERE "survey360_links"."credential_state" = 'pending' AND NOT "survey360_links"."revoked";--> statement-breakpoint
CREATE INDEX "survey360_links_credential_key" ON "survey360_links" USING btree ("tenant_id","credential_key_version","id") WHERE "survey360_links"."credential_state" = 'issued';--> statement-breakpoint
CREATE INDEX "survey360_links_credential_versions" ON "survey360_links" USING gin ("credential_key_versions");--> statement-breakpoint
ALTER TABLE "survey360_links" ADD CONSTRAINT "survey360_links_credential_state" CHECK ("survey360_links"."credential_state" IN ('none', 'pending', 'issued', 'retired'));--> statement-breakpoint
ALTER TABLE "survey360_links" ADD CONSTRAINT "survey360_links_credential_digest" CHECK (("survey360_links"."credential_state" = 'issued') = ("survey360_links"."serial_lookup" IS NOT NULL AND "survey360_links"."password_hash" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "survey360_links" ADD CONSTRAINT "survey360_links_credential_version" CHECK ("survey360_links"."credential_state" IN ('none', 'pending') OR ("survey360_links"."credential_key_version" IS NOT NULL
        AND "survey360_links"."credential_key_version" = ANY ("survey360_links"."credential_key_versions")));--> statement-breakpoint
ALTER TABLE "survey360_links" ADD CONSTRAINT "survey360_links_credential_kind" CHECK ("survey360_links"."credential_state" = 'none' OR "survey360_links"."kind" = 'answer');
--> statement-breakpoint
-- F-076 PR-0 手写部分（drizzle 表达不了的）：租户隔离（AGENTS §2；guard-rls）、应用角色授权、安全事件只追加。
-- 会话与限频行是临时认证状态，需要 DELETE 做清理；退役进度只增改；安全事件只 INSERT / SELECT。
SELECT enable_tenant_isolation('survey360_answer_sessions');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_answer_sessions TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_login_throttle');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON survey360_login_throttle TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_key_retire_runs');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON survey360_key_retire_runs TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('survey360_security_events');
--> statement-breakpoint
GRANT SELECT, INSERT ON survey360_security_events TO app_user;
--> statement-breakpoint
-- 对任何角色（含表属主）拒绝 UPDATE / DELETE / TRUNCATE；保留期清理走运维通道（设计 §5.4）
CREATE TRIGGER survey360_security_events_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON survey360_security_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
