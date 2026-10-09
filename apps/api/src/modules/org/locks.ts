import { eq, orgSettings, type Tx } from '@italent/db';

/**
 * F-008 / DEC-196 全局锁序（不存在的资源跳过）：
 * 参与员工闭包（UUID 升序）→ 已有业务头 → 组织设置 → 编制设置 → 审批实例。
 * 任职与审批入口先固定员工 / 业务集合，不能持资源锁后再扩充员工集合；新建业务 / 实例没有已有行可争。
 * 审批适配器在实例前预锁资源；状态迁移、落地和联动可重入已持有的锁，不能反向首次取锁。
 * 成员行排在组织锁之后：入职绑定账号（成员行 FOR UPDATE）与交接登记替代人（外键对成员行 KEY SHARE）都须先取齐前面的锁（F-065）。
 * 普通组织写入不锁员工，先取此锁再锁组织对象；编制公共入口也先取此锁（包括首次初始化），再取编制锁。
 * 保留租户粒度以保护未来行政子树和负责人联动；后者也取组织设置排他锁，局部锁 / 共享锁升级会另造锁环。
 */
export async function lockOrganizationSettings(tx: Tx, tenantId: string): Promise<void> {
  // 空租户也须有稳定锁行；仅初始化设置默认值，不创建组织根或修改设置 revision。
  await tx.insert(orgSettings).values({ tenantId }).onConflictDoNothing();
  await tx
    .select({ tenantId: orgSettings.tenantId })
    .from(orgSettings)
    .where(eq(orgSettings.tenantId, tenantId))
    .for('update');
}
