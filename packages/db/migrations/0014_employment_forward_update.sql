-- R1-T06：仅追加 payload 版本；旧记录保持原生效快照，新完整快照携带触发命令。
-- employment_payload_versions 沿用 0013 的 ENABLE/FORCE RLS、只追加触发器及权限。
ALTER TABLE "employment_payload_versions" ADD COLUMN "command_id" text;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD COLUMN "trigger_business_id" uuid;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD COLUMN "is_record_snapshot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_trigger_business_fk" FOREIGN KEY ("tenant_id","employee_id","trigger_business_id") REFERENCES "public"."employment_business_objects"("tenant_id","employee_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employment_payload_versions_cycle_date" ON "employment_payload_versions" USING btree ("tenant_id","employee_id","selected_staff_id","effective_date","business_id","version_no");--> statement-breakpoint
CREATE INDEX "employment_payload_versions_snapshot_position" ON "employment_payload_versions" USING btree ("tenant_id","position_id","business_id","version_no") WHERE "employment_payload_versions"."is_record_snapshot";--> statement-breakpoint
CREATE INDEX "employment_payload_versions_latest_snapshot" ON "employment_payload_versions" USING btree ("tenant_id","business_id","version_no" DESC NULLS LAST) WHERE "employment_payload_versions"."is_record_snapshot";--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_command_pair" CHECK (("employment_payload_versions"."command_id" IS NULL) = ("employment_payload_versions"."trigger_business_id" IS NULL));--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_snapshot_command" CHECK (NOT "employment_payload_versions"."is_record_snapshot" OR "employment_payload_versions"."command_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "employment_payload_versions" ADD CONSTRAINT "employment_payload_versions_command_nonempty" CHECK ("employment_payload_versions"."command_id" IS NULL OR btrim("employment_payload_versions"."command_id") <> '');
