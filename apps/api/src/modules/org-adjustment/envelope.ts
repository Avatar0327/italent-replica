/**
 * 校验信封与校验类错误的字段裁剪（R2-T08 §6.3，F-339 ②）：信封不是对象字段，但问题里带的组织 ID 会泄露看不到的字段值。
 * - 明细问题（带 section）与顶层 `orgId` 随 `orgItems.targetOrgId` 查看权；
 * - 头问题（`ORG_INACTIVE`）的 `orgIds` 随 `approvalSubjectOrgId` 与 `adjustmentRange` 查看权（两者都可见才给）。
 * - 编码重复（`ORG_CODE_DUPLICATE`）带出的被占用编码随 `orgItems.code` 查看权（F-343 ②）。
 * 整单校验（路由 7）、提交 / 重提（路由 10）的 400 / 409、审批人编辑、明细与头写入的错误共用；
 * `viewable` 为 undefined 表示不受限。
 */
import type { Tx } from '@italent/db';
import { ORG_ADJUSTMENT_OBJECT_CODE } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { ApprovalContext } from '../approval/context.js';
import { ORG_INACTIVE } from './range.js';

type Viewable = ReadonlySet<string> | undefined;
type Issue = Readonly<Record<string, unknown>>;

const sees = (viewable: Viewable, ...codes: string[]) => !viewable || codes.every((code) => viewable.has(code));
const without = (issue: Issue, key: string) => Object.fromEntries(Object.entries(issue).filter(([k]) => k !== key));

/**
 * 越界 / 停用等错误里的组织 ID 来自哪个对象字段（第 6 轮 P2-1）：问题或错误 details 可带 `field`（内部标记，输出前一律去掉），
 * 组织 ID 随该字段的查看权；缺省 = 目标组织。命中新上级时按 `orgItems.parentOrgId` 判，不拿目标组织的权限代判。
 */
export const TARGET_ORG_FIELD = 'orgItems.targetOrgId';
export const PARENT_ORG_FIELD = 'orgItems.parentOrgId';
export const TRANSFER_DEPARTMENT_FIELD = 'transferItems.departmentId';
const FIELD_KEY = 'field';
/**
 * 停用的新上级（ORG_INACTIVE）命中的是新上级字段，审批节点只按 `orgItems.parentOrgId` 判（第 7 轮 P2①，与读接口同口径）。
 * 只有发起人重提出口（F-427，`initiator`）保留既有口径：随目标组织查看权，且新上级自己的字段也须可见，两个都看得到才带出。
 */
const sourceFields = (issue: Issue, initiator = false): string[] => {
  const fields = typeof issue[FIELD_KEY] === 'string' ? issue[FIELD_KEY].split(',') : [TARGET_ORG_FIELD];
  const widened = initiator && issue.reason === ORG_INACTIVE && fields.includes(PARENT_ORG_FIELD);
  return widened ? [...fields, TARGET_ORG_FIELD] : fields;
};

export const ORG_CODE_DUPLICATE = 'ORG_CODE_DUPLICATE';
/** 编码重复的文案；看不到 `orgItems.code` 时不带编码（保存的 409 与整单校验问题共用）。 */
export const codeUsedMessage = (code?: string) =>
  code ? `组织编码【${code}】在生效日已被使用` : '组织编码在生效日已被使用';

/** 编码重复的问题 / 错误：看不到 `orgItems.code` 时去掉 `code` 并换成不带编码的文案。 */
function hideUsedCode(issue: Issue, viewable: Viewable): Issue {
  const holder = issue.details && typeof issue.details === 'object' ? (issue.details as Issue) : issue;
  if (holder.reason !== ORG_CODE_DUPLICATE || sees(viewable, 'orgItems.code')) return issue;
  const message = codeUsedMessage();
  return holder === issue
    ? { ...without(issue, 'code'), message }
    : { ...issue, message, details: without(holder, 'code') };
}

/** 逐条裁剪问题；看得见时原样返回。 */
export function trimIssues<T extends object>(issues: readonly T[], viewable: Viewable, initiator = false): T[] {
  const headOrgs = sees(viewable, 'approvalSubjectOrgId', 'adjustmentRange');
  return issues.map((issue) => {
    if ('section' in issue) {
      const row = issue as Issue;
      const shown = sees(viewable, ...sourceFields(row, initiator)) ? row : without(row, 'orgId');
      return hideUsedCode(without(shown, FIELD_KEY), viewable) as T;
    }
    return (headOrgs ? issue : without(issue as Issue, 'orgIds')) as T;
  });
}

export const HIDDEN_ROW_INVALID = 'ORG_ADJUSTMENT_HIDDEN_ROW_INVALID';

/**
 * 整单校验信封里隐藏行（组织范围外）的问题折叠成一条固定形状的汇总：不带 itemId / orgId / 原因 / 业务文案，
 * 也不带条数，调用方无法由汇总反推无权明细的数量（F-339 ②）。汇总放在末尾；没有隐藏行问题时原样返回。
 */
export function foldHiddenRowIssues<T extends object>(issues: readonly T[], hiddenItemIds: ReadonlySet<string>) {
  const isHidden = (issue: T) => hiddenItemIds.has((issue as Issue).itemId as string);
  const hidden = issues.filter(isHidden);
  if (hidden.length === 0) return [...issues];
  const summary = {
    section: 'org',
    reason: HIDDEN_ROW_INVALID,
    message: '有无权查看的明细行未通过校验',
  };
  return [...issues.filter((issue) => !isHidden(issue)), summary];
}

/** 错误 details 里的 `items` 同样折叠隐藏行（缩小调整范围的 400 等，F-343 ⑤）；没有 `items` 或没有隐藏行问题原样返回。 */
export function foldHiddenError(error: unknown, hiddenItemIds: ReadonlySet<string>): unknown {
  if (!(error instanceof AppError) || !error.details || typeof error.details !== 'object') return error;
  const details = error.details as Issue;
  if (!Array.isArray(details.items)) return error;
  const items = foldHiddenRowIssues(details.items as Issue[], hiddenItemIds);
  return new AppError(error.code, error.message, { ...details, items });
}

/** 校验类错误的 details：`items` 逐条裁剪；顶层 `orgIds` / `orgId` 与头 / 明细问题同口径。其它错误原样返回。 */
export function trimError(error: unknown, viewable: Viewable, initiator = false): unknown {
  if (!(error instanceof AppError) || !error.details || typeof error.details !== 'object') return error;
  const hidden = hideUsedCode({ message: error.message, details: error.details }, viewable);
  const message = hidden.message as string;
  let details = hidden.details as Issue;
  if (Array.isArray(details.items))
    details = { ...details, items: trimIssues(details.items as Issue[], viewable, initiator) };
  // 顶层组织 ID 随命中的字段（缺省目标组织）；带 field 的 `orgIds` 同样按该字段判，不带 field 的是头问题。
  const fields = sourceFields(details, initiator);
  if (!sees(viewable, ...fields)) details = without(details, 'orgId');
  const headIds = FIELD_KEY in details ? fields : ['approvalSubjectOrgId', 'adjustmentRange'];
  if (!sees(viewable, ...headIds)) details = without(details, 'orgIds');
  return new AppError(error.code, message, without(details, FIELD_KEY));
}

/**
 * 审批引擎回调（审批人编辑 / 同意兜底、发起人重提）里的错误信封按当前操作人的披露裁剪（F-339 ②、F-427）：
 * 有审批人授权能力且带单据 ID 时，行折叠与字段裁剪都用读接口同一份节点披露（hidden-rows.ts `envelopeViewForViewer`）；
 * 否则按对象级字段查看权，未注入字段访问按看不到处理（context.ts 同口径，fail-closed）。
 * `initiator` = 发起人重提出口（F-427）：停用的新上级沿用“随目标组织查看权”的既有口径；审批人出口不传，按新上级字段判。
 */
export async function trimmedForViewer(
  tx: Tx,
  ctx: ApprovalContext,
  work: () => Promise<void>,
  adjustmentId?: string,
  initiator = false,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (adjustmentId && ctx.exitEditAuthorize) {
      const deps = { authorize: ctx.exitEditAuthorize, clock: () => ctx.now };
      const { envelopeViewForViewer } = await import('./hidden-rows.js');
      // 审批人出口按审批中心的节点字段 ∩ 对象字段权披露，不让 HR 查看权抢先；发起人出口保持 F-427 口径（DEC-1010）
      const view = await envelopeViewForViewer(tx, deps, ctx, adjustmentId, !initiator);
      throw trimError(foldHiddenError(error, view.hidden), view.fields, initiator);
    }
    const viewable = ctx.fields
      ? await ctx.fields.viewable(tx, ctx.userId, ORG_ADJUSTMENT_OBJECT_CODE)
      : new Set<string>();
    throw trimError(error, viewable, initiator);
  }
}
