-- R2 BE-14a2：OF-R3「发送前须审批通过」按 Offer 类型设置（docs/02_业务建模/34 §2.2 OF-R3），出厂都关（本租户各类型都未要求，34 §7）。
-- 走两层配置（系统预置 + 租户覆盖），取值校验在 apps/api/src/modules/offer/transitions.ts 登记。
INSERT INTO system_settings(key,value,description,overridable,version,updated_at) VALUES
  ('offer.send_requires_approval','{"social":false,"campus":false,"intern":false}'::jsonb,'Offer：发送前须审批通过（按类型：social 社招 / campus 校招 / intern 实习）',true,1,now());
