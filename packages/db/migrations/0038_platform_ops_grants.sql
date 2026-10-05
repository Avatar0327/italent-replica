-- 手写迁移：平台运营身份表的权限（R1-T17，REQ-PLT-001）。无 tenant_id、不受 RLS 约束（guard-rls 豁免清单登记理由），
-- 只授予平台角色；app_user 无任何权限，租户路径读不到也改不了平台运营身份。撤销只改状态，不授 DELETE。
GRANT SELECT, INSERT, UPDATE ON platform_operators TO app_platform;
