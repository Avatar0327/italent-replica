-- R3-T02 C1-1：任职资格子集的租户隔离（硬规则 7，同 0021 的人员子集）与 SW73 / SW74 两个系统预置开关。
-- 版本表只追加（forbid_audit_mutation）；当前子集由同事务的版本快照保护。
SELECT enable_tenant_isolation('personnel_qualification');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "personnel_qualification" TO app_user;
--> statement-breakpoint
SELECT enable_tenant_isolation('personnel_qualification_versions');
--> statement-breakpoint
GRANT SELECT, INSERT ON "personnel_qualification_versions" TO app_user;
--> statement-breakpoint
CREATE TRIGGER "personnel_qualification_versions_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE
  ON "personnel_qualification_versions" FOR EACH STATEMENT EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint
-- SW73 / SW74：全局行（不进 DEC-361 种子补装登记表）；租户覆盖走现有两层配置。键、默认值与说明与
-- packages/domain/src/qualification/settings.ts 一致（AC-QL-subset 逐键核对）。默认值照原站租户：SW73 关、SW74 开。
INSERT INTO system_settings(key,value,description,overridable,version,updated_at) VALUES
  ('qualification.sync_enabled','false'::jsonb,'任职资格：员工岗职位信息变动同步生成任职资格子集（SW73）',true,1,now()),
  ('qualification.auto_sync_editable','true'::jsonb,'任职资格：自动同步的子集数据允许手动修改或删除（SW74）',true,1,now())
ON CONFLICT (key) DO NOTHING;
