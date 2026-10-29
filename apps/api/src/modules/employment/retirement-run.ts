/**
 * R2 BE-5c2 “立即执行”（R2-T04 §9.2）：POST retirement-rules/run?purpose=。在请求事务内办理，不占当天批次登记；
 * 一次最多处理一页，回执带 next（retirement_rule_run_cursors.id，随机句柄，只出库这一项）；续跑请求带 cursor：
 * 按 (tenant_id, id) 查行，且 user_id = 当前操作人、purpose 相同、business_date = 当前租户业务日，任一不符 → 400
 * RETIREMENT_RUN_CURSOR_INVALID（跨租户因 RLS 查不到同样得此码，不泄露存在性）。
 * 对应开关关闭 → 400 RETIREMENT_AUTO_DISABLED（设计未写，取“先开启”的保守做法）。按规则适用组织扫描，不叠加操作人的
 * 数据范围（系统批次提前执行），回执由路由按操作人当前范围裁剪。整页先按全局顺序一次锁住（lockTransferParticipants
 * 闭包规划，不逐人追加锁），与每日批次重叠时后取到锁的一方按“同值不写”复核。
 */
import { randomUUID } from 'node:crypto';
import { isUuid, sql, type Tx } from '@italent/db';
import { tenantLocalDate, type RetirementRulePurpose } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import {
  applyRetirementRules,
  collectRetirementOutcome,
  readRetirementSwitch,
  retirementCandidates,
  systemContext,
  type RetirementFailed,
  type RetirementUpdated,
} from './retirement-compute.js';
import { RETIREMENT_BATCH_LIMITS } from './retirement-scheduler.js';
import { loadRetirementRulesForRun, parseRulePurpose } from './retirement-rules.js';
import { rowsOf } from './record-store.js';
import { lockTransferParticipants } from './transfer-locks.js';
import type { EmploymentContext } from './types.js';

export interface RetirementRunReceipt {
  readonly businessDate: string;
  readonly purpose: RetirementRulePurpose;
  updated: RetirementUpdated[];
  failed: RetirementFailed[];
  /** 续跑句柄；没有更多候选时为 null。 */
  next: string | null;
}

/** ?purpose= 必填（写操作不取缺省）。 */
export function parseRunPurpose(raw: string | undefined): RetirementRulePurpose {
  if (!raw)
    throw new AppError('VALIDATION_FAILED', '立即执行须指定 purpose', { reason: 'RETIREMENT_RUN_PURPOSE_REQUIRED' });
  return parseRulePurpose(raw);
}

/** body 严格 { cursor? }：cursor 为上一次回执的 next（随机句柄）。 */
export function parseRetirementRunBody(raw: unknown): { readonly cursor: string | null } {
  const parsed = z.strictObject({ cursor: z.string().refine(isUuid, '续跑游标须为 UUID').optional() }).safeParse(raw);
  if (!parsed.success)
    throw new AppError('VALIDATION_FAILED', '立即执行的请求体须为 {} 或 { cursor }', parsed.error.issues);
  return { cursor: parsed.data.cursor?.toLowerCase() ?? null };
}

export async function runRetirementRulesNow(
  tx: Tx,
  ctx: EmploymentContext,
  purpose: RetirementRulePurpose,
  cursorHandle: string | null,
): Promise<RetirementRunReceipt> {
  if (!(await readRetirementSwitch(tx, ctx.tenantId, purpose)))
    throw new AppError('VALIDATION_FAILED', '自动计算未开启，请先开启对应开关', { reason: 'RETIREMENT_AUTO_DISABLED' });
  const businessDate = tenantLocalDate(ctx.now, ctx.timezone);
  const position = cursorHandle ? await cursorPosition(tx, ctx, purpose, businessDate, cursorHandle) : null;
  const system = systemContext(ctx);
  const receipt: RetirementRunReceipt = { businessDate, purpose, updated: [], failed: [], next: null };
  const size = RETIREMENT_BATCH_LIMITS.page;
  const page = await retirementCandidates(tx, ctx.tenantId, businessDate, position, size);
  if (!page.length) return receipt;
  const rules = await loadRetirementRulesForRun(tx, ctx.tenantId, purpose, businessDate);
  await lockTransferParticipants(tx, system, page[0]!, page.slice(1));
  for (const employeeId of page)
    collectRetirementOutcome(receipt, await applyRetirementRules(tx, system, employeeId, purpose, rules, ctx.userId));
  if (page.length === size) receipt.next = await issueCursor(tx, ctx, purpose, businessDate, page.at(-1)!);
  return receipt;
}

async function issueCursor(
  tx: Tx,
  ctx: EmploymentContext,
  purpose: RetirementRulePurpose,
  businessDate: string,
  position: string,
) {
  const id = randomUUID();
  await tx.execute(sql`INSERT INTO retirement_rule_run_cursors(id, tenant_id, user_id, purpose, business_date,
      position_employee_id, command_id, created_at)
    VALUES (${id}::uuid, ${ctx.tenantId}, ${ctx.userId}::uuid, ${purpose}, ${businessDate}::date, ${position}::uuid,
      ${ctx.commandId}, ${ctx.now.toISOString()}::timestamptz)`);
  return id;
}

async function cursorPosition(
  tx: Tx,
  ctx: EmploymentContext,
  purpose: RetirementRulePurpose,
  businessDate: string,
  handle: string,
) {
  const [row] = rowsOf<{ position: string }>(
    await tx.execute(sql`SELECT position_employee_id::text AS position FROM retirement_rule_run_cursors
      WHERE tenant_id=${ctx.tenantId} AND id=${handle}::uuid AND user_id=${ctx.userId}::uuid
        AND purpose=${purpose} AND business_date=${businessDate}::date`),
  );
  if (!row)
    throw new AppError('VALIDATION_FAILED', '续跑游标无效或已过期，请重新执行', {
      reason: 'RETIREMENT_RUN_CURSOR_INVALID',
    });
  return row.position;
}
