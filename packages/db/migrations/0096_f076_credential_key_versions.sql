CREATE TABLE "survey360_credential_key_versions" (
	"version" smallint PRIMARY KEY NOT NULL,
	"previous" smallint,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "survey360_credential_key_versions_positive" CHECK ("survey360_credential_key_versions"."version" > 0),
	CONSTRAINT "survey360_credential_key_versions_increasing" CHECK ("survey360_credential_key_versions"."previous" IS NULL OR "survey360_credential_key_versions"."previous" < "survey360_credential_key_versions"."version")
);
--> statement-breakpoint
ALTER TABLE "survey360_links" DROP CONSTRAINT "survey360_links_credential_digest";--> statement-breakpoint
CREATE UNIQUE INDEX "survey360_security_events_rotated" ON "survey360_security_events" USING btree ("tenant_id","credential_key_version") WHERE "survey360_security_events"."kind" = 'key_rotated';--> statement-breakpoint
CREATE UNIQUE INDEX "survey360_security_events_retired" ON "survey360_security_events" USING btree ("tenant_id","run_id") WHERE "survey360_security_events"."kind" = 'key_retired';--> statement-breakpoint
ALTER TABLE "survey360_links" ADD CONSTRAINT "survey360_links_credential_versions_nonnull" CHECK (array_position("survey360_links"."credential_key_versions", NULL::smallint) IS NULL);--> statement-breakpoint
ALTER TABLE "survey360_links" ADD CONSTRAINT "survey360_links_credential_digest" CHECK (("survey360_links"."credential_state" = 'issued' AND "survey360_links"."serial_lookup" IS NOT NULL AND "survey360_links"."password_hash" IS NOT NULL)
        OR ("survey360_links"."credential_state" <> 'issued' AND "survey360_links"."serial_lookup" IS NULL AND "survey360_links"."password_hash" IS NULL));--> statement-breakpoint
-- F-076 §2.4：凭据密钥版本的全局登记（平台表，无租户维度）。运维命令 rotate 走平台角色登记；发放写回在租户事务里
-- 读最高版本复核（只读版本号，不含密钥与租户数据），所以租户角色只授 SELECT。
GRANT SELECT, INSERT ON survey360_credential_key_versions TO app_platform;
--> statement-breakpoint
GRANT SELECT ON survey360_credential_key_versions TO app_user;
--> statement-breakpoint
-- 只追加：对任何角色（含表属主）拒绝 UPDATE / DELETE / TRUNCATE（版本只增不减）
CREATE TRIGGER survey360_credential_key_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON survey360_credential_key_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
