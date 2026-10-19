/**
 * 离职生效写黑名单（R2 BE-8b1，DM-R2 / DM-R3 / AC-DM-06；DEC-266②、DEC-630；R2-T03 设计 §5.1 步骤 8 的 effective 端口订阅方）。
 * 订阅 exitPostEffectHooks.onEffective，与离职生效同一事务、同一保存点；三种生效来源（approval / direct / free_direct）都经
 * activateExit，因此都覆盖（来源只决定交接 DM-R14，不影响加黑）。
 * - 手动勾选（exit_requests.add_to_blacklist）优先：source = manual，原因 / 有效截止日期 / 说明取离职表单；不再叠加自动匹配。
 * - 否则总开关开启时按规则匹配：exitCount = 该员工已生效的离职次数（含本次），orgChain = 生效前（最后工作日）所在部门及行政维度全部上级；
 *   命中取优先级数字最小者，source = auto_rule；期限“离职当月”= 生效日所在自然月月底，“永久”= 空。
 * - 名单写入只走 addBlacklistEntry（BE-8a 单一入口，加黑日期 = 离职生效日），名单行记下写入它的离职请求 ID（撤销离职据此回收）。
 * - 本人已在有效名单（409 BLACKLIST_DUPLICATE）：跳过并在审计留痕，不回滚离职；其他错误照常抛出，整笔生效回滚。
 */
import { sql, type Tx } from '@italent/db';
import {
  exitMonthExpiryDate,
  matchBlacklistRule,
  type BlacklistReason,
  type BlacklistRuleFacts,
  type BlacklistSource,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { adminAncestors } from '../approval/resolver.js';
import { addBlacklistEntry, revokeExitListing } from './blacklist.js';
import { loadBlacklistRules, readAutoBlacklistEnabled } from './blacklist-rules.js';
import { auditEmployment } from './context.js';
import { exitPostEffectHooks, type ExitCancelledEvent, type ExitEffectiveEvent } from './exit-confirmation.js';
import { loadExitRequest } from './exit-gate.js';
import { findCurrentRecord } from './read-model.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

interface Listing {
  readonly source: BlacklistSource;
  readonly reason: string;
  readonly expiryDate: string | null;
  readonly note: string | null;
  readonly ruleId: string | null;
}

/** 已生效的离职次数（含本次：生效状态事件已在本事务写入）；撤销后的离职状态不再是 effective，不计。 */
async function effectiveExitCount(tx: Tx, tenantId: string, employeeId: string): Promise<number> {
  const [row] = rowsOf<{ n: number }>(
    await tx.execute(sql`SELECT count(*)::int AS n FROM exit_requests x
      JOIN LATERAL (SELECT s.state FROM employment_state_events s
        WHERE s.tenant_id = x.tenant_id AND s.business_id = x.business_id ORDER BY s.event_no DESC LIMIT 1) s ON true
      WHERE x.tenant_id = ${tenantId} AND x.employee_id = ${employeeId}::uuid AND s.state = 'effective'`),
  );
  return Number(row?.n ?? 0);
}

/** 生效前所在部门及其全部上级（行政维度，自下而上）；没有部门返回空，规则的适用组织都不命中（fail-closed）。 */
async function orgChainBeforeExit(tx: Tx, ctx: EmploymentContext, event: ExitEffectiveEvent): Promise<string[]> {
  const record = await findCurrentRecord(tx, ctx.tenantId, event.employeeId, event.lastWorkDate);
  const departmentId = record?.fields.departmentId;
  return departmentId ? adminAncestors(tx, ctx.tenantId, event.lastWorkDate, departmentId) : [];
}

function listingOfRule(rule: BlacklistRuleFacts, effectiveDate: string): Listing {
  return {
    source: 'auto_rule',
    reason: rule.reason,
    expiryDate: rule.term === 'exit_month' ? exitMonthExpiryDate(effectiveDate) : null,
    note: rule.note,
    ruleId: rule.id,
  };
}

async function autoListing(tx: Tx, ctx: EmploymentContext, event: ExitEffectiveEvent): Promise<Listing | null> {
  if (!(await readAutoBlacklistEnabled(tx, ctx.tenantId))) return null;
  const rules = await loadBlacklistRules(tx, ctx.tenantId);
  if (!rules.length) return null;
  const rule = matchBlacklistRule(rules, {
    exitCount: await effectiveExitCount(tx, ctx.tenantId, event.employeeId),
    orgChain: await orgChainBeforeExit(tx, ctx, event),
  });
  return rule ? listingOfRule(rule, event.effectiveDate) : null;
}

/** 本次离职要写入名单的内容；手动勾选优先，没有则看总开关与规则。 */
async function listingFor(tx: Tx, ctx: EmploymentContext, event: ExitEffectiveEvent): Promise<Listing | null> {
  const exit = await loadExitRequest(tx, ctx.tenantId, event.businessId);
  if (exit?.addToBlacklist) {
    return {
      source: 'manual',
      // 创建 / 编辑已保证勾选时原因必填；缺失说明数据被绕过，宁可整笔回滚也不静默漏加黑
      reason: exit.blacklistReason ?? failMissingReason(event.businessId),
      expiryDate: exit.blacklistExpiryDate,
      note: exit.blacklistNote,
      ruleId: null,
    };
  }
  return autoListing(tx, ctx, event);
}

function failMissingReason(businessId: string): never {
  throw new AppError('VALIDATION_FAILED', '加入黑名单须填写加黑原因', {
    reason: 'EXIT_BLACKLIST_REASON_REQUIRED',
    businessId,
  });
}

async function activeEntryId(tx: Tx, tenantId: string, employeeId: string): Promise<string | null> {
  const [row] = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT id FROM employment_blacklist
      WHERE tenant_id = ${tenantId} AND employee_id = ${employeeId}::uuid AND status = 'active' LIMIT 1`),
  );
  return row?.id ?? null;
}

const isDuplicate = (error: unknown) =>
  error instanceof AppError && (error.details as { reason?: unknown } | undefined)?.reason === 'BLACKLIST_DUPLICATE';

/** 订阅方本体（导出供测试直调）：返回写入的名单行 ID，没有加黑或被跳过返回 null。 */
export async function writeExitBlacklist(
  tx: Tx,
  ctx: EmploymentContext,
  event: ExitEffectiveEvent,
): Promise<string | null> {
  const listing = await listingFor(tx, ctx, event);
  if (!listing) return null;
  try {
    const entry = await addBlacklistEntry(
      tx,
      // 名单页新增要求 If-Match = 0；这里不是页面请求，传 0 表示“新建”
      { ...ctx, expectedRevision: 0 },
      {
        employeeId: event.employeeId,
        reason: listing.reason as BlacklistReason,
        expiryDate: listing.expiryDate,
        note: listing.note,
      },
      { source: listing.source, blacklistDate: event.effectiveDate, exitRequestId: event.businessId },
    );
    return entry.id;
  } catch (error) {
    if (!isDuplicate(error)) throw error;
    // 重复由名单锁内的查重发现（未触发数据库错误），事务仍可继续；锁一直持有到事务结束，下面的读取与查重同一视图
    await auditEmployment(
      tx,
      ctx,
      'exit.blacklist.skipped',
      'exit-request',
      event.businessId,
      null,
      {
        reason: 'BLACKLIST_DUPLICATE',
        source: listing.source,
        ruleId: listing.ruleId,
        blacklistId: await activeEntryId(tx, ctx.tenantId, event.employeeId),
      },
      undefined,
      undefined,
      { employeeId: event.employeeId },
    );
    return null;
  }
}

/**
 * 撤销离职回收名单（DEC-631；订阅 onCancelled，与撤销同事务）：只移出这笔离职写入的有效名单行（exit_request_id 匹配）。
 * 该行早已被手动移出 / 已过期：不动，审计 exit.blacklist.revoke_skipped 留痕；这笔离职没写过行，但本人另有有效名单行
 * （黑名单页手动新增、导入、别的离职写的）：同样不动并留痕；撤销照常完成。
 */
export async function revokeExitBlacklist(tx: Tx, ctx: EmploymentContext, event: ExitCancelledEvent): Promise<void> {
  const result = await revokeExitListing(tx, ctx, event.businessId);
  const trace = (action: string, after: Record<string, unknown>) =>
    auditEmployment(tx, ctx, action, 'exit-request', event.businessId, null, after, undefined, undefined, {
      employeeId: event.employeeId,
    });
  if (result.outcome === 'removed') return trace('exit.blacklist.revoked', { blacklistId: result.entry.id });
  if (result.outcome !== 'none') {
    const reason = result.outcome === 'expired' ? 'BLACKLIST_EXPIRED' : 'BLACKLIST_ALREADY_REMOVED';
    return trace('exit.blacklist.revoke_skipped', { reason, blacklistId: result.entry.id });
  }
  const other = await activeEntryId(tx, ctx.tenantId, event.employeeId);
  if (other) await trace('exit.blacklist.revoke_skipped', { reason: 'NOT_WRITTEN_BY_EXIT', blacklistId: other });
}

exitPostEffectHooks.onEffective((tx, ctx, event) => writeExitBlacklist(tx, ctx, event).then(() => undefined));
exitPostEffectHooks.onCancelled((tx, ctx, event) => revokeExitBlacklist(tx, ctx, event));
