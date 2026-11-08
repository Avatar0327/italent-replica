/**
 * R2-T08 §7.6 执行期间暂停（OA-R9）：各写入口在组织设置锁之后的单一判定。
 * 暂停行由执行开始事务在同一把租户级锁下写入、收尾事务删除，拦截点先取锁再读，不存在“检查通过后暂停才出现”的窗口。
 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { primaryDepartmentSql } from '../org/employment-linkage.js';
import { lockOrganizationSettings } from '../org/locks.js';
import { rowsOf } from '../approval/context.js';

/** 组织调整执行上下文带 orgAdjustmentId：本单的暂停行不拦本单自己的写入（§7.6）。 */
export interface PauseContext {
  readonly tenantId: string;
  readonly orgAdjustmentId?: string | null;
}

export interface PauseTarget {
  readonly employeeId?: string | null;
  readonly departmentIds: readonly (string | null | undefined)[];
  readonly date: string;
}

export async function assertNotPausedByOrgAdjustment(tx: Tx, ctx: PauseContext, target: PauseTarget) {
  // 锁序（org/locks.ts）：调用方已取员工 / 业务锁，这里只可能是首次取或重入组织设置锁。
  await lockOrganizationSettings(tx, ctx.tenantId);
  const ids = [...new Set(target.departmentIds.filter((id): id is string => !!id))];
  const employee = target.employeeId
    ? sql`OR p.org_id IN (${primaryDepartmentSql(ctx.tenantId, target.employeeId, target.date)})`
    : sql``;
  const [hit] = rowsOf<{ adjustment_id: string }>(
    await tx.execute(sql`SELECT p.adjustment_id FROM org_adjustment_pauses p
      WHERE p.tenant_id=${ctx.tenantId} AND p.adjustment_id IS DISTINCT FROM ${ctx.orgAdjustmentId ?? null}::uuid
        AND (p.org_id=ANY(${`{${ids.join(',')}}`}::uuid[]) ${employee}) LIMIT 1`),
  );
  if (!hit) return;
  // 命中后才读单据编号：未命中路径只依赖暂停表（升级前夹具只为它登记垫片，见 testkit pre-upgrade-shims）。
  const [adjustment] = rowsOf<{ code: string }>(
    await tx.execute(sql`SELECT code FROM org_adjustments
      WHERE tenant_id=${ctx.tenantId} AND id=${hit.adjustment_id}::uuid`),
  );
  throw new OrgAdjustmentPausedError(hit.adjustment_id, adjustment?.code);
}

/**
 * 暂停 409。单据编号不进 `details`：写入口拿不到查看人的授权，是否披露由租户路由层的错误处理按调整单可见性补上
 * （`pause-disclosure.ts`，F-342 / F-355）；没经过那一层的出口（审批回调、台账、日志）因此默认只有通用原因。
 */
export class OrgAdjustmentPausedError extends AppError {
  constructor(
    readonly adjustmentId: string,
    readonly adjustmentCode: string | undefined,
    extra: Record<string, unknown> = {},
  ) {
    super('CONFLICT', '相关组织正在执行组织调整，请执行完成后再操作', { reason: 'ORG_ADJUSTMENT_EXECUTING', ...extra });
  }

  /** 批量入口给错误加行定位等附加信息时用：仍是同一个暂停错误，披露判定不丢。 */
  withDetails(extra: Record<string, unknown>): OrgAdjustmentPausedError {
    return new OrgAdjustmentPausedError(this.adjustmentId, this.adjustmentCode, {
      ...(this.details as Record<string, unknown>),
      ...extra,
    });
  }
}
