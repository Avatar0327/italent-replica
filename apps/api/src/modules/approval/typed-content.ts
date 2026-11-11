/**
 * 审批中心详情的类型化业务内容（F-476 P8 返工 P2-3）。通用 snapshot.values 只装表单字段；业务内容不在表单里的类型
 * （IDP 的目标 / 任务 / 综述 / 回顾）已办读冻结份时由对应模块还原，随详情返回 businessContent。
 * 在办 / 发起人读现值的业务内容走各自的业务入口（计划详情等），这里不输出。
 */
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { idpFrozenContent } from '../idp/approval-content.js';
import type { DetailData } from './disclosure.js';

export async function typedContentOf(
  deps: TenantRouteDeps,
  tenant: TenantContext,
  data: DetailData,
): Promise<{ businessContent: { type: string; content: unknown } } | null> {
  const { instance, content } = data;
  if (content.mode !== 'frozen' || instance.businessType !== 'idp') return null;
  const body = await idpFrozenContent(deps, tenant, content.frozen.content.ext, instance.businessId);
  return { businessContent: { type: 'idp', content: body } };
}
