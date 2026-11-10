/**
 * 单 Offer 详情的已办读取（F-476 P6，设计 §5.3、§6）：GET /offers/:id 是审批中心之外的第二条读取路径。
 * 候选办理份来自该 Offer 的**全部**审批实例（不是 latestInstanceOf / 当前指针，也不受展示窗口截断），驳回、
 * 不同意后重开或新建实例都不让旧份丢失（P8 评审 P2-2、P6 评审 P2-1）。读法与审批中心同源：同一个取份函数、
 * 同一个 readDetail，表单值用 formValuesView（审批中心 detailView 的 form.values 也走它），两条路径读不出不同的值。
 * DEC-801：发起人 / 有待办 → 现值；其余按本人最近一次办理的份。
 * 已办读者读到的是办理时的整份，不再按当前数据范围裁行（DEC-834④）；字段按「节点表单 ∩ 办理时上限 ∩ 当前字段权限」。
 * 返回 null 表示读现值，由调用方走原有详情路径；缺份直接抛 503（DEC-807），不退回现值。
 * 只返回 Offer 表单值、名称标签与 contentView：行操作、revision 等操作性协议数据属于现值，冻结读不给。
 */
import { withTenant } from '@italent/db';
import { OFFER_OBJECT } from '@italent/domain';
import { approvalError, canonicalId } from '../approval/context.js';
import { formValuesView, readDetail } from '../approval/disclosure.js';
import { contentViewOf, selectBusinessContent } from '../approval/handling-content.js';
import type { TenantRouteDeps } from '../../routes.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import type { OfferContext } from './context.js';

export async function frozenOfferDetail(
  deps: TenantRouteDeps,
  ctx: OfferContext,
  offerId: string,
): Promise<Record<string, unknown> | null> {
  const userId = canonicalId(ctx.userId);
  const found = await withTenant(deps.db, ctx.tenantId, async (tx) => {
    const selection = await selectBusinessContent(tx, ctx, 'offer', offerId, userId);
    if (selection.mode !== 'frozen') return null;
    // 选中的办理份所在实例：readDetail 在该实例上对本人的选择与上面是同一份（本人在任一实例有待办 / 是发起人时已返回现值）
    const data = await readDetail(
      tx,
      ctx,
      selection.frozen.instanceId,
      { userId, transferScope: null, interveneScope: null },
      false,
    );
    return data;
  });
  if (!found) return null;
  // 两次选择必同源；万一对不上，按缺份失败闭合，不拿现值顶替（DEC-807）
  if (found.content.mode !== 'frozen')
    throw approvalError('SERVICE_UNAVAILABLE', 'APPROVAL_HANDLING_CONTENT_MISSING', '办理记录暂不可读取，请稍后重试');
  const viewable = await getModuleViewableFields(deps, ctx, OFFER_OBJECT);
  // 只取表单值：不推算审批中心的操作按钮（冻结读不回 actions / revision）
  const values = formValuesView(found, userId, viewable);
  return { id: offerId, ...values, contentView: contentViewOf(found.instance.id, found.content) };
}
