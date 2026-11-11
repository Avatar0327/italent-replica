/**
 * 离职生效时终止任职 / 合同 / 兼职 / 考核以外的在途流程（DEC-725，规格 30 SwitchTypes=41 个人信息组）：
 * 员工子集变更（个人信息变更与各子集变更）与意向退休日期申请。勾选才终止，不勾一律保留；退休暂不接配置（F-351），不处理。
 * 订阅 exitPostEffectHooks.onEffective，与离职生效同一事务、同一保存点：失败即整单回滚。
 * 候选集合取自 exit-flow-candidates.ts（预览、§8 确认令牌、生效执行三处共用）。
 * 候选含已撤回的员工子集变更申请（DEC-740）：只把实例置已终止（重提即被拒），业务单已是“已撤回”。
 * 每条在途实例：按业务侧锁序锁业务单（员工已由离职持有 → 业务单）→ 系统撤销实例（日志操作人“系统”、理由 EXIT_VOID_REASON，
 * 与在途考核同一做法）→ 业务单置“已撤回” → 台账 application_voided → 审计 → 给发起人与申请人发站内消息（沿用离职作废通道）。
 * 撤销离职不恢复被终止的流程（与在途考核、任职申请一致）。
 */
import { exitEffects, sql, type Tx } from '@italent/db';
import {
  FLOW_TERMINATED_BY_EXIT_TEMPLATE,
  PERSONNEL_REQUEST_OBJECT,
  type FlowTerminatedPayload,
} from '@italent/domain';
import { revokeBySystem } from '../approval/actions.js';
import { ADAPTERS } from '../approval/adapters.js';
import { schedulerAwareContext } from '../approval/context.js';
import { notifyMessage } from '../approval/notifications.js';
import { userOfPerson } from '../approval/resolver.js';
import { auditEmployment } from './context.js';
import { exitPostEffectHooks, type ExitEffectiveEvent } from './exit-post-effect-hooks.js';
import { registerDownstreamVisibility } from './exit-downstream-visibility.js';
import { terminableOtherFlows, visibleFlows, type OtherFlow, type OtherFlowType } from './exit-flow-candidates.js';
import { EXIT_VOID_REASON } from './exit-void-assessments.js';
import { rowsOf } from './record-store.js';
import { INTENTION_AUDIT_TYPE } from './retirement-intention-store.js';
import type { EmploymentContext } from './types.js';

export const FLOW_TERMINATED_TEMPLATE = FLOW_TERMINATED_BY_EXIT_TEMPLATE;

/** 意向申请的部门快照（审计 scope.orgId，与意向申请自身审计同一归属，审计查询按它判 DEC-177）。 */
async function intentionDepartment(tx: Tx, tenantId: string, id: string) {
  const [row] = rowsOf<{ departmentId: string | null }>(
    await tx.execute(sql`SELECT department_id::text AS "departmentId" FROM retirement_intentions
      WHERE tenant_id=${tenantId} AND id=${id}::uuid`),
  );
  return row?.departmentId ?? null;
}

/** 专项审计按业务对象登记（与该业务自身审计同一 objectType / 归属），有权限的 HR 能经审计查询读到。 */
async function auditTerminated(
  tx: Tx,
  ctx: EmploymentContext,
  row: OtherFlow,
  event: Pick<ExitEffectiveEvent, 'businessId' | 'employeeId' | 'lastWorkDate'>,
  detail: object,
) {
  const intention = row.businessType === 'retirement_intention';
  const scope = intention
    ? { employeeId: event.employeeId, orgId: await intentionDepartment(tx, ctx.tenantId, row.businessId) }
    : { employeeId: event.employeeId };
  await auditEmployment(
    tx,
    ctx,
    'employment.exit.flow_terminated_by_exit',
    intention ? INTENTION_AUDIT_TYPE : PERSONNEL_REQUEST_OBJECT,
    row.businessId,
    null,
    { exitBusinessId: event.businessId, lastWorkDate: event.lastWorkDate, ...detail },
    undefined,
    undefined,
    scope,
  );
}

/** 消息模板变量（F-420）：员工取任职员工名，流程名称取审批实例标题（终止不改标题）。 */
async function employeeNameOf(tx: Tx, tenantId: string, employeeId: string) {
  const [row] = rowsOf<{ name: string }>(
    await tx.execute(sql`SELECT name FROM employment_employees
      WHERE tenant_id=${tenantId} AND id=${employeeId}::uuid`),
  );
  return row?.name ?? '';
}

async function flowNameOf(tx: Tx, tenantId: string, instanceId: string) {
  const [row] = rowsOf<{ title: string }>(
    await tx.execute(sql`SELECT title FROM approval_instances
      WHERE tenant_id=${tenantId} AND id=${instanceId}::uuid`),
  );
  return row?.title ?? '';
}

export async function terminateOtherFlows(
  tx: Tx,
  ctx: EmploymentContext,
  event: Pick<ExitEffectiveEvent, 'businessId' | 'employeeId' | 'lastWorkDate' | 'effectiveDate' | 'kind'>,
) {
  const approvalCtx = schedulerAwareContext(ctx);
  const terminated: OtherFlow[] = [];
  // 与预览、§8 确认令牌同一个候选入口（exit-flow-candidates.ts）：已按配置勾选过滤
  for (const row of await terminableOtherFlows(tx, ctx, event.employeeId, event.kind)) {
    const { flowType } = row;
    const adapter = ADAPTERS[row.businessType];
    await adapter.lock(tx, approvalCtx, row.businessId);
    const alreadyWithdrawn = row.instanceStatus === 'withdrawn';
    await revokeBySystem(tx, approvalCtx, row.instanceId, EXIT_VOID_REASON, { includeWithdrawn: alreadyWithdrawn });
    // 已撤回的申请业务单本就是“已撤回”（DEC-740）：只终止实例，使其不能再重提，不重复回调业务侧
    if (!alreadyWithdrawn) await adapter.withdrawn(tx, approvalCtx, row.businessId);
    const detail = { approvalType: row.businessType, flowType, instanceId: row.instanceId };
    await tx.insert(exitEffects).values({
      tenantId: ctx.tenantId,
      businessId: event.businessId,
      employeeId: event.employeeId,
      phase: 'effective',
      kind: 'application_voided',
      targetType: 'approval-flow',
      targetId: row.businessId,
      detail,
      commandId: ctx.commandId,
      createdAt: ctx.now,
    });
    await auditTerminated(tx, ctx, row, event, detail);
    const applicant = await userOfPerson(tx, ctx.tenantId, event.employeeId);
    const payload: FlowTerminatedPayload = {
      flowName: await flowNameOf(tx, ctx.tenantId, row.instanceId),
      employeeName: await employeeNameOf(tx, ctx.tenantId, event.employeeId),
      effectiveDate: event.effectiveDate,
    };
    for (const recipientUserId of new Set([row.initiatorUserId, applicant].filter((id): id is string => !!id)))
      await notifyMessage(
        tx,
        approvalCtx,
        { id: row.instanceId },
        { recipientUserId, templateCode: FLOW_TERMINATED_TEMPLATE, payload },
      );
    terminated.push(row);
  }
  return terminated;
}

exitPostEffectHooks.onEffective((tx, ctx, event) => terminateOtherFlows(tx, ctx, event).then(() => undefined));

// 离职下游清单（exit-downstream）的 approval-flow 目标按申请单查看权判定，与预览披露同一口径；不登记会落到未知类型失败即关
registerDownstreamVisibility('approval-flow', async (tx, ctx, target) => {
  const businessType = target.detail?.approvalType as OtherFlowType | undefined;
  if (businessType !== 'personnel_change' && businessType !== 'retirement_intention') return false;
  const [visible] = await visibleFlows(tx, ctx, [{ businessType, businessId: target.id }]);
  return visible ?? false;
});
