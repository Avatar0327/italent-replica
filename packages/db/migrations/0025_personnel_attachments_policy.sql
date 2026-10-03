-- 0024 手写的附件表策略直接把 app.tenant_id 转为 uuid：未设租户（空串）时查询报错，而不是像其他租户表
-- 那样经 current_tenant_id() 得到 NULL、读不到写不进。统一为迁移 0003 的标准隔离表达式（guard-rls 守卫）。
ALTER POLICY personnel_attachments_tenant_isolation ON personnel_attachments
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
