-- F-478 S6：退休返聘累计司龄开关（系统默认关闭，租户可覆盖）；与离职重聘开关互相独立。
-- 只新增系统默认行，不改表结构；DEC-402 不回填已落地的返聘业务。
INSERT INTO system_settings(key,value,description,overridable,version,updated_at) VALUES
  ('employment.retire_rehire_accumulate_seniority','false'::jsonb,'【退休返聘】累计司龄',true,1,now());
