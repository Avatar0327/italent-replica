/**
 * 适用范围不能与进行中的活动重复（DEC-372②，照原站 Q-M0-154；设计 §3.2；拆分方案 B5）：保存活动（新建，或改适用组织范围 /
 * 申请类别）时，若本租户已有**进行中**（status = published）的其他活动，与本活动组织范围有交集且申请类别有交集，则拦截，
 * 409 ACTIVITY_SCOPE_DUPLICATE，提示“适用范围与已有活动【{活动名称}】重复，请修改”（组织范围按组织 ID 列表求交集，不含下级 🟡）。
 * - 检查与写入同一事务，先按“租户 + 申请类别”取事务级咨询锁（类别 ID 排序取锁，避免死锁）再判断；C2-1a 发布时复用 `lockActivityScope`
 *   与 `findScopeConflicts`，防止两个草稿先后发布绕过；
 * - 冲突活动不在操作人 TEvaluation 范围内，或活动“名称”字段对操作人不可见时，提示不带名称，不泄露范围外 / 被裁剪的活动信息 🟡。
 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { type ModuleScope, rowsOf, scopePredicate } from './access.js';

/** 取“租户 + 申请类别”的事务级咨询锁（可能等待；类别 ID 排序后依次取，调用方各入口一致）。 */
export async function lockActivityScope(tx: Tx, tenantId: string, categoryIds: readonly string[]): Promise<void> {
  for (const categoryId of [...new Set(categoryIds)].sort()) {
    await advisoryLock(tx, 'ev-activity-scope:', asUuid(tenantId), ':', asUuid(categoryId));
  }
}

export interface ScopeConflict {
  readonly id: string;
  readonly name: string;
  /** 冲突活动在操作人范围内（且名称字段可见时才能带名称）。 */
  readonly visible: boolean;
}

/** 与给定范围冲突的进行中活动（排除自身），可见的排前面。 */
export async function findScopeConflicts(
  tx: Tx,
  args: {
    readonly tenantId: string;
    readonly scope: ModuleScope;
    readonly selfId?: string;
    readonly orgRange: readonly string[];
    readonly categoryIds: readonly string[];
  },
): Promise<ScopeConflict[]> {
  const list = (ids: readonly string[]) => `{${[...new Set(ids)].join(',')}}`;
  return rowsOf<ScopeConflict>(
    await tx.execute(sql`SELECT a.id, a.name, (${scopePredicate(args.scope, 'evaluationActivity', 'a')}) AS visible
      FROM ev_activities a
      WHERE a.tenant_id = ${args.tenantId}::uuid AND a.status = 'published'
        AND (${args.selfId ?? null}::uuid IS NULL OR a.id <> ${args.selfId ?? null}::uuid)
        AND a.org_range && ${list(args.orgRange)}::uuid[] AND a.category_ids && ${list(args.categoryIds)}::uuid[]
      ORDER BY visible DESC, a.name, a.id`),
  );
}

/**
 * 保存前的拦截：范围任一为空不会与任何活动冲突（空 = 不匹配任何人，fail-closed），不取锁；否则取锁后检查。
 * `nameVisible` 为操作人对活动“名称”字段的查看权。
 */
export async function assertScopeUnique(
  tx: Tx,
  args: Parameters<typeof findScopeConflicts>[1] & { readonly nameVisible: boolean },
): Promise<void> {
  if (!args.orgRange.length || !args.categoryIds.length) return;
  await lockActivityScope(tx, args.tenantId, args.categoryIds);
  const [first] = await findScopeConflicts(tx, args);
  if (!first) return;
  const named = first.visible && args.nameVisible;
  throw new AppError(
    'CONFLICT',
    named ? `适用范围与已有活动【${first.name}】重复，请修改` : '适用范围与已有活动重复，请修改',
    { reason: 'ACTIVITY_SCOPE_DUPLICATE' },
  );
}
