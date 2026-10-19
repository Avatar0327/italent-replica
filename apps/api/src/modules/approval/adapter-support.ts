/**
 * 审批适配器共用的业务侧辅助（从 adapters.ts 抽出，让各模块的适配器不必反向导入 adapters.ts 而成环）：
 * 员工档案带出值、员工头信息、会签合席判定。
 */
import { sql, type Tx } from '@italent/db';
import { ageOn, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { rowsOf, type ApprovalContext, type Row } from './context.js';
import { OPEN_STATUSES } from './store.js';

/**
 * DEC-122：调动审批详情带出员工档案的性别与年龄（年龄按租户业务日期由出生日期计算，与员工档案一致）。
 * 只读带出，不进入变化字段与盲审；可见性按员工信息对象的字段查看权另行裁剪（routes.detailViewable）。
 */
export async function profileValues(tx: Tx, ctx: ApprovalContext, employeeId: string): Promise<Row> {
  const [profile] = rowsOf<{ gender: string | null; birthday: string | null }>(
    await tx.execute(sql`SELECT gender,birthday::text FROM personnel_employee_versions
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid ORDER BY revision DESC LIMIT 1`),
  );
  return {
    gender: profile?.gender ?? null,
    age: ageOn(profile?.birthday ?? null, tenantLocalDate(ctx.now, ctx.timezone)),
  };
}

export async function employeeHeader(tx: Tx, tenantId: string, employeeId: string) {
  const [row] = rowsOf<{ code: string; name: string }>(
    await tx.execute(sql`SELECT code,name FROM employment_employees
      WHERE tenant_id=${tenantId} AND id=${employeeId}::uuid`),
  );
  if (!row) throw new AppError('NOT_FOUND', '人员不存在');
  return row;
}

/** 占着会签席位的任务状态：与 countersign.ts 的 HELD 相同（在办 + 已投票），那里不导出。 */
const HELD_STATUSES = [...OPEN_STATUSES, 'approved', 'disagreed'].map((status) => sql`${status}`);

/**
 * F-070：手动交接的这批任职业务里，是否有待转任务可能触发会签合席（合席结算才可能推进业务、落地时取组织锁）。
 * 合席要求替代人（或回避后的直线经理）已在本激活占着一席，所以本激活里除待转任务外没有别的占席任务就不可能合席。
 * 这是合席条件的超集（只会多取、不会漏取）；此时已持员工锁，任职业务实例的任务集合不会再被别的命令改写。
 * 实例没有异动员工（取不到员工锁）时无法保证，保守按可能合席处理。
 */
export async function mayMergeSeat(tx: Tx, ctx: ApprovalContext, businessIds: readonly string[], from: string) {
  const [row] = rowsOf<{ found: boolean }>(
    await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM approval_instances i
      JOIN approval_tasks t ON t.tenant_id=i.tenant_id AND t.instance_id=i.id
      WHERE i.tenant_id=${ctx.tenantId} AND i.status='running'
        AND i.business_id = ANY(${`{${businessIds.join(',')}}`}::uuid[])
        AND t.status='pending' AND t.is_exception_admin AND t.assignee_user_id=${from}::uuid
        AND (i.subject_employee_id IS NULL OR EXISTS (SELECT 1 FROM approval_tasks s
          WHERE s.tenant_id=t.tenant_id AND s.instance_id=t.instance_id AND s.id<>t.id
            AND s.activation_id IS NOT DISTINCT FROM t.activation_id
            AND s.status IN (${sql.join(HELD_STATUSES, sql`,`)})))) AS found`),
  );
  return Boolean(row?.found);
}

/**
 * 本次动作是否可能让任职业务进入结算 / 生效链，从而要在审批实例锁之前取齐组织 / 编制资源锁（F-070，DEC-431① 唯一判断）。
 * 普通办理（同意、驳回、撤回……，reassignFrom 未传）总有可能推进业务；改派（手动交接、成员撤销 / 停用接管，reassignFrom =
 * 原持有人）只有会签合席结算才可能推进业务，仅改派时不取。lock 与 lockMany 共用这一个函数，不按调用方打标记。
 */
export async function mayAdvanceBusiness(
  tx: Tx,
  ctx: ApprovalContext,
  businessIds: readonly string[],
  reassignFrom?: string,
) {
  return !reassignFrom || (await mayMergeSeat(tx, ctx, businessIds, reassignFrom));
}
