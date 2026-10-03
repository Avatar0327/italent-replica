-- DEC-085: deny by default; tenant administrators explicitly opt fields in via the audited settings API.
INSERT INTO system_settings(key,value,description,overridable,version,updated_at)
VALUES ('personnel.self_service_fields','{}'::jsonb,'员工可自助修改的人员子集字段清单',true,1,now())
ON CONFLICT (key) DO NOTHING;
