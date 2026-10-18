-- R2 BE-14b3：OF-R9「取消入职后把 Offer 改为已拒绝」与 OF-R4「审批通过允许再次发起审批」两个联动开关（docs/02_业务建模/34）。
-- 两层配置（系统预置 + 租户覆盖），取值校验在 domain offer/rules.ts 登记；两项出厂都开（OF-R9 原站默认开，OF-R4 取不破坏数据的一侧）。
INSERT INTO system_settings(key,value,description,overridable,version,updated_at) VALUES
  ('offer.linkage','{"entryCancelRejects":true,"reapprovalAllowed":true}'::jsonb,'Offer：联动开关（entryCancelRejects：取消入职后把已发 / 已接受的 Offer 改为已拒绝，OF-R9；reapprovalAllowed：审批通过后修改必审字段允许再次发起审批，开则原 Offer 回待发重审，关则失效原 Offer 并复制新 Offer，OF-R4）',true,1,now());
