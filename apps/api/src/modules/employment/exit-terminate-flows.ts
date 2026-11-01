/**
 * 离职生效时终止任职 / 合同 / 兼职 / 考核以外的在途流程（DEC-725，规格 30 SwitchTypes=41 个人信息组）：
 * 员工子集变更（个人信息变更与各子集变更）与意向退休日期申请。勾选才终止，不勾一律保留；退休暂不接配置（F-351），不处理。
 * 订阅 exitPostEffectHooks.onEffective，与离职生效同一事务、同一保存点：失败即整单回滚。
 * 每条在途实例：按业务侧锁序锁业务单（员工已由离职持有 → 业务单）→ 系统撤销实例（日志操作人“系统”、理由 EXIT_VOID_REASON，
 * 与在途考核同一做法）→ 业务单置“已撤回” → 台账 application_voided → 审计 → 给发起人与申请人发站内消息（沿用离职作废通道）。
 * 撤销离职不恢复被终止的流程（与在途考核、任职申请一致）。
 */
import { exitEffects, sql, type Tx } from '@italent/db';
import { personnelSubsetFlow, type ExitTerminationFlow } from '@italent/domain';
import { revokeBySystem } from '../approval/actions.js';
import { ADAPTERS } from '../approval/adapters.js';
import { schedulerAwareContext } from '../approval/context.js';
import { notifyMessage } from '../approval/notifications.js';
import { userOfPerson } from '../approval/resolver.js';
import { auditEmployment } from './context.js';
import { exitPostEffectHooks, type ExitEffectiveEvent } from './exit-confirmation.js';
import { exitTerminationOf } from './exit-termination-policy.js';
import { EXIT_VOID_REASON } from './exit-void-assessments.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

export const FLOW_TERMINATED_TEMPLATE = 'flow_terminated_by_exit';

interface OpenFlow {
  readonly instanceId: string;
  readonly businessType: 'personnel_change' | 'retirement_intention';
  readonly businessId: string;
  readonly initiatorUserId: string;
  readonly subset: string | null;
}

const flowOf = (row: OpenFlow): ExitTerminationFlow =>
  row.businessType === 'retirement_intention' ? 'retirement_intention' : personnelSubsetFlow(row.subset ?? '');

/** 员工名下这两类业务的活动实例（运行中 / 已退回），按实例 ID 升序。 */
async function openFlows(tx: Tx, tenantId: string, employeeId: string): Promise<OpenFlow[]> {
  return rowsOf<OpenFlow>(
    await tx.execute(sql`SELECT i.id::text AS "instanceId", i.business_type AS "businessType",
        i.business_id::text AS "businessId", i.initiator_user_id::text AS "initiatorUserId", c.subset
      FROM approval_instances i
      LEFT JOIN personnel_change_requests c
        ON i.business_type = 'personnel_change' AND c.tenant_id = i.tenant_id AND c.id = i.business_id
      WHERE i.tenant_id=${tenantId} AND i.subject_employee_id=${employeeId}::uuid
        AND i.business_type IN ('personnel_change','retirement_intention')
        AND i.status IN ('running','returned')
      ORDER BY i.id`),
  );
}

export async function terminateOtherFlows(
  tx: Tx,
  ctx: EmploymentContext,
  event: Pick<ExitEffectiveEvent, 'businessId' | 'employeeId' | 'lastWorkDate' | 'kind'>,
) {
  const policy = await exitTerminationOf(tx, ctx.tenantId, event.kind);
  if (!policy) return [];
  const approvalCtx = schedulerAwareContext(ctx);
  const terminated: OpenFlow[] = [];
  for (const row of await openFlows(tx, ctx.tenantId, event.employeeId)) {
    const flowType = flowOf(row);
    if (!policy[flowType]) continue;
    const adapter = ADAPTERS[row.businessType];
    await adapter.lock(tx, approvalCtx, row.businessId);
    await revokeBySystem(tx, approvalCtx, row.instanceId, EXIT_VOID_REASON);
    await adapter.withdrawn(tx, approvalCtx, row.businessId);
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
    await auditEmployment(
      tx,
      ctx,
      'employment.exit.flow_terminated_by_exit',
      row.businessType,
      row.businessId,
      null,
      { exitBusinessId: event.businessId, lastWorkDate: event.lastWorkDate, ...detail },
      undefined,
      undefined,
      { employeeId: event.employeeId },
    );
    const applicant = await userOfPerson(tx, ctx.tenantId, event.employeeId);
    for (const recipientUserId of new Set([row.initiatorUserId, applicant].filter((id): id is string => !!id)))
      await notifyMessage(
        tx,
        approvalCtx,
        { id: row.instanceId },
        { recipientUserId, templateCode: FLOW_TERMINATED_TEMPLATE },
      );
    terminated.push(row);
  }
  return terminated;
}

exitPostEffectHooks.onEffective((tx, ctx, event) => terminateOtherFlows(tx, ctx, event).then(() => undefined));
