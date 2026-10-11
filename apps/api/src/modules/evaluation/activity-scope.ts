/**
 * 适用范围不能与进行中的活动重复（DEC-372②，照原站 Q-M0-154；Q-M0-174 第 4 点；设计 §3.2；拆分方案 B5）：保存活动（新建，或改适用组织
 * 范围 / 申请类别）时，若本租户已有**进行中**（status = published）的其他活动，与本活动的组织范围有交集且申请类别有交集，则拦截，
 * 409 ACTIVITY_SCOPE_DUPLICATE，提示“适用范围与已有活动【{活动名称}】重复，请修改”。
 * - **组织范围把下级算进去**：每个组织勾了“包含下级”的，按行政维度、租户时区当天的组织版本展开成组织集合（DEC-146 同口径，停用组织
 *   也展开），两个活动展开后有公共组织即有交集；有界保护按去重后的组织数计数，重叠的根不重复消耗上限；去掉“包含下级”后可能不再冲突；
 * - 检查与写入同一事务，先按“租户 + 申请类别”取事务级咨询锁（类别 ID 排序取锁，避免死锁）再判断；C2-1a 发布时复用 `lockActivityScope`
 *   与 `findScopeConflict`，防止两个草稿先后发布绕过；
 * - 冲突活动不在操作人 TEvaluation 数据范围内，或活动“名称”字段对操作人不可见时，提示不带名称，不泄露范围外 / 被裁剪的活动信息 🟡。
 */
import { sql, type Tx } from '@italent/db';
import { type OrgRangeEntry, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { expandScopeOrgSet } from '../permission/scope-hierarchy.js';
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

interface ScopeArgs {
  readonly tenantId: string;
  readonly timezone: string;
  readonly now: Date;
  readonly scope: ModuleScope;
  readonly selfId?: string;
  readonly orgRange: readonly OrgRangeEntry[];
  readonly categoryIds: readonly string[];
}

const uuidList = (ids: readonly string[]) => `{${[...new Set(ids)].join(',')}}`;

/** 组织范围展开成组织 ID 集合（勾了“包含下级”的连同下级，行政维度，租户时区当天）。 */
async function expand(tx: Tx, args: ScopeArgs, entries: readonly OrgRangeEntry[]): Promise<Set<string>> {
  const asOf = tenantLocalDate(args.now, args.timezone);
  const roots = entries.map((entry) => ({
    orgId: entry.orgId,
    dimension: 'admin',
    includeDescendants: entry.includeDescendants,
  }));
  return expandScopeOrgSet(tx, args.tenantId, asOf, roots);
}

/** 与给定范围冲突的进行中活动（排除自身）：可见的排前面，第一个交集命中即返回；没有冲突返回 undefined。 */
export async function findScopeConflict(tx: Tx, args: ScopeArgs): Promise<ScopeConflict | undefined> {
  if (!args.orgRange.length || !args.categoryIds.length) return undefined;
  const candidates = rowsOf<ScopeConflict>(
    await tx.execute(sql`SELECT a.id, a.name, (${scopePredicate(args.scope, 'evaluationActivity', 'a')}) AS visible
      FROM ev_activities a
      WHERE a.tenant_id = ${args.tenantId}::uuid AND a.status = 'published'
        AND (${args.selfId ?? null}::uuid IS NULL OR a.id <> ${args.selfId ?? null}::uuid)
        AND a.category_ids && ${uuidList(args.categoryIds)}::uuid[]
      ORDER BY visible DESC, a.name, a.id`),
  );
  if (!candidates.length) return undefined;
  const mine = await expand(tx, args, args.orgRange);
  for (const candidate of candidates) {
    const entries = rowsOf<{ org_id: string; include_descendants: boolean }>(
      await tx.execute(sql`SELECT org_id, include_descendants FROM ev_activity_orgs
        WHERE tenant_id = ${args.tenantId}::uuid AND activity_id = ${candidate.id}::uuid`),
    ).map((row) => ({ orgId: row.org_id, includeDescendants: row.include_descendants }));
    const theirs = await expand(tx, args, entries);
    if ([...theirs].some((orgId) => mine.has(orgId))) return candidate;
  }
  return undefined;
}

/**
 * 保存前的拦截：范围任一为空不会与任何活动冲突（空 = 不匹配任何人，fail-closed），不取锁；否则取锁后检查。
 * `nameVisible` 为操作人对活动“名称”字段的查看权。
 */
export async function assertScopeUnique(tx: Tx, args: ScopeArgs & { readonly nameVisible: boolean }): Promise<void> {
  if (!args.orgRange.length || !args.categoryIds.length) return;
  await lockActivityScope(tx, args.tenantId, args.categoryIds);
  const first = await findScopeConflict(tx, args);
  if (!first) return;
  const named = first.visible && args.nameVisible;
  throw new AppError(
    'CONFLICT',
    named ? `适用范围与已有活动【${first.name}】重复，请修改` : '适用范围与已有活动重复，请修改',
    { reason: 'ACTIVITY_SCOPE_DUPLICATE' },
  );
}
