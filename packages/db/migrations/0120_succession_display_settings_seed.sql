-- DEC-443：管理员租户级显示设置，两层配置；租户覆盖沿用既有设置入口，修改不发统计事件。
INSERT INTO system_settings(key,value,description,overridable,version,updated_at) VALUES
  ('succession.hide_virtual_org','false'::jsonb,'继任：组织地图隐藏虚拟组织',true,1,now()),
  ('succession.show_incumbents','true'::jsonb,'继任：地图展示当前任职人员',true,1,now());
