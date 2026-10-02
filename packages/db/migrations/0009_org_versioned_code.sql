-- DEC-072 / docs/02_业务建模/10 §8.3：编码是组织版本字段，不得覆盖对象头。
ALTER TABLE org_versions ADD COLUMN code text;
--> statement-breakpoint
DROP TRIGGER org_versions_append_only ON org_versions;
--> statement-breakpoint
UPDATE org_versions v SET code = o.code FROM org_objects o
WHERE o.tenant_id = v.tenant_id AND o.id = v.org_id;
--> statement-breakpoint
ALTER TABLE org_versions ALTER COLUMN code SET NOT NULL;
--> statement-breakpoint
ALTER TABLE org_versions ADD CONSTRAINT org_versions_code_nonempty CHECK (btrim(code) <> '');
--> statement-breakpoint
CREATE TRIGGER org_versions_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON org_versions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
ALTER TABLE org_objects DROP CONSTRAINT org_objects_tenant_code;
--> statement-breakpoint
ALTER TABLE org_objects DROP CONSTRAINT org_objects_code_nonempty;
--> statement-breakpoint
ALTER TABLE org_objects DROP COLUMN code;
--> statement-breakpoint
ALTER TABLE org_code_reservations ADD COLUMN expires_at timestamp with time zone;
--> statement-breakpoint
UPDATE org_code_reservations SET expires_at = reserved_at + interval '30 minutes';
--> statement-breakpoint
ALTER TABLE org_code_reservations ALTER COLUMN expires_at SET NOT NULL;
--> statement-breakpoint
DROP INDEX org_code_reservations_held_code;
--> statement-breakpoint
CREATE INDEX org_code_reservations_tenant_expiry
  ON org_code_reservations (tenant_id, state, expires_at, code);
