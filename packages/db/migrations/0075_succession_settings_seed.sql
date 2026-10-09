-- R3-T05 契约 PR：继任租户开关的系统值（设计 §1.5；键、默认值与说明与 packages/domain/src/succession/settings.ts 一致，
-- 由 AC-SC-contract 逐键核对）。租户覆盖走现有两层配置；继任侧系统主体系统值为空串 = 未配置，同步与计算不执行
-- （不用 JSON null：租户备份恢复按记录集写回 system_settings，null 会变成 SQL NULL 违反非空约束）。
INSERT INTO system_settings(key,value,description,overridable,version,updated_at) VALUES
  ('succession.self_successors_visible','true'::jsonb,'继任：本人作为负责人 / 现任时可见自己的继任者',true,1,now()),
  ('succession.sync_strategy','"append"'::jsonb,'继任：盘点同步策略（append / overwrite / overwrite_in_scope）',true,1,now()),
  ('succession.part_time_in_risk_calc','false'::jsonb,'继任：兼岗人员参与职位风险计算',true,1,now()),
  ('succession.map_default_depth','3'::jsonb,'继任：组织继任地图默认层数（2～4）',true,1,now()),
  ('succession.org_stats_interval_hours','4'::jsonb,'继任：组织关联信息统计间隔（小时，1～24）',true,1,now()),
  ('succession.system_principal_user_id','""'::jsonb,'继任：继任侧系统主体（用户 ID，未配置时同步与计算不执行）',true,1,now())
ON CONFLICT (key) DO NOTHING;
