/**
 * 校验信封与校验类错误的字段裁剪（R2-T08 §6.3，F-339 ②）：信封不是对象字段，但问题里带的组织 ID 会泄露看不到的字段值。
 * - 明细问题（带 section）与顶层 `orgId` 随 `orgItems.targetOrgId` 查看权；
 * - 头问题（`ORG_INACTIVE`）的 `orgIds` 随 `approvalSubjectOrgId` 与 `adjustmentRange` 查看权（两者都可见才给）。
 * 整单校验（路由 7）、提交 / 重提（路由 10）的 400 / 409、审批人编辑的错误共用；`viewable` 为 undefined 表示不受限。
 */
import type { Tx } from '@italent/db';
import { ORG_ADJUSTMENT_OBJECT_CODE } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { ApprovalContext } from '../approval/context.js';

type Viewable = ReadonlySet<string> | undefined;
type Issue = Readonly<Record<string, unknown>>;

const sees = (viewable: Viewable, ...codes: string[]) => !viewable || codes.every((code) => viewable.has(code));
const without = (issue: Issue, key: string) => Object.fromEntries(Object.entries(issue).filter(([k]) => k !== key));

/** 逐条裁剪问题；看得见时原样返回。 */
export function trimIssues<T extends object>(issues: readonly T[], viewable: Viewable): T[] {
  const itemOrg = sees(viewable, 'orgItems.targetOrgId');
  const headOrgs = sees(viewable, 'approvalSubjectOrgId', 'adjustmentRange');
  return issues.map((issue) => {
    if ('section' in issue) return (itemOrg ? issue : without(issue as Issue, 'orgId')) as T;
    return (headOrgs ? issue : without(issue as Issue, 'orgIds')) as T;
  });
}

/** 校验类错误的 details：`items` 逐条裁剪；顶层 `orgIds` / `orgId` 与头 / 明细问题同口径。其它错误原样返回。 */
export function trimError(error: unknown, viewable: Viewable): unknown {
  if (!(error instanceof AppError) || !viewable || !error.details || typeof error.details !== 'object') return error;
  let details = error.details as Issue;
  if (Array.isArray(details.items)) details = { ...details, items: trimIssues(details.items as Issue[], viewable) };
  if (!sees(viewable, 'orgItems.targetOrgId')) details = without(details, 'orgId');
  if (!sees(viewable, 'approvalSubjectOrgId', 'adjustmentRange')) details = without(details, 'orgIds');
  return new AppError(error.code, error.message, details);
}

/**
 * 审批引擎回调（审批人编辑 / 同意兜底、发起人重提）里的错误信封按当前操作人的字段查看权裁剪（F-339 ②、F-427）；
 * 未注入字段访问按看不到处理（context.ts 同口径，fail-closed）。
 */
export async function trimmedForViewer(tx: Tx, ctx: ApprovalContext, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    const viewable = ctx.fields
      ? await ctx.fields.viewable(tx, ctx.userId, ORG_ADJUSTMENT_OBJECT_CODE)
      : new Set<string>();
    throw trimError(error, viewable);
  }
}
