/**
 * 业务对象写路由必须调用的服务端字段权限校验（REQ-PRM-001 字段权限；Codex 审计 PR #8）。
 * 字段集合取服务端解析后的载荷键，不信任前台声明；判定在授权器内完成：
 * 对象的 新增 / 编辑 数据操作开启，且每个字段都是已登记的非系统字段并至少一个有效身份可编辑（DEC-042 并集）。
 * 任一字段不可写 → 403（整单拒绝，不做“静默丢弃字段”）。
 */
import { type Authorizer, requirePermission } from '../../authorization.js';

export interface ObjectWrite {
  readonly objectCode: string;
  readonly operation: 'create' | 'update';
  /** 已通过结构校验的载荷：键即字段编码。 */
  readonly payload: Readonly<Record<string, unknown>>;
}

export async function requireObjectWrite(
  authorizer: Authorizer,
  ctx: { readonly tenantId: string; readonly userId: string },
  write: ObjectWrite,
): Promise<void> {
  await requirePermission(authorizer, {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    action: `object.${write.operation}`,
    resource: write.objectCode,
    fields: Object.keys(write.payload),
  });
}
