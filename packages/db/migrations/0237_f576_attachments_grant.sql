-- F-576：0024 建 personnel_attachments 后从未给 app_user 授权，普通角色下附件登记（INSERT）与校验（SELECT）
-- 一律“permission denied”→ 503；超级用户连接绕过授权，掩盖了缺口。
-- 只补应用代码实际用到的最小集合（apps/api/src/modules/personnel/attachments.ts）：
--   SELECT —— validateAttachments 校验附件已登记且属于该员工；
--   INSERT —— registerAttachment 登记元数据（status 初值 registered）。
-- 不授 UPDATE / DELETE：当前没有代码路径改状态或删行（清理走附件台账 attachment_files）；后续需要再单独授。
-- RLS（0024 启用并 FORCE、0025 统一为 current_tenant_id()）不变，租户隔离仍由策略保证。
GRANT SELECT, INSERT ON personnel_attachments TO app_user;
