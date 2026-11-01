/**
 * 离职生效时将被终止的“任职 / 合同 / 兼职 / 考核以外”的在途流程（DEC-725，规格 30 SwitchTypes=41 个人信息组）的唯一读取入口：
 * 员工子集变更（个人信息变更与各子集变更）与意向退休日期申请，按离职终止配置勾选过滤。
 * 预览（EXIT_FLOWS_TO_TERMINATE）、§8 确认令牌（pendingTransferAckSet）与生效执行（terminateOtherFlows）三处都从这里取，
 * 预览列出的、409 要求确认的、生效时终止的是同一个集合。退休暂不接配置（F-351），返回空。
 * 披露按申请单查看权裁剪：意向申请按任职对象查看权 + DEC-177（员工 / 申请时部门 / 发起人），员工子集申请按人事申请对象
 * 查看权 + 其数据范围（员工当前任职 / 创建人）；不可见的只计 hiddenCount，令牌仍覆盖它。
 */
import { sql, type Tx } from '@italent/db';
import { PERSONNEL_REQUEST_OBJECT, personnelSubsetFlow, type ExitTerminationFlow } from '@italent/domain';
import { resolveModuleScopeInTransaction } from '../permission/module-access.js';
import { EMPLOYMENT_OBJECT } from './context.js';
import { exitTerminationOf } from './exit-termination-policy.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';
import { visibleEmploymentRecords } from './visibility.js';

export type OtherFlowType = 'personnel_change' | 'retirement_intention';

export interface OtherFlow {
  readonly instanceId: string;
  readonly businessType: OtherFlowType;
  readonly businessId: string;
  readonly initiatorUserId: string;
  readonly flowType: ExitTerminationFlow;
}

export interface FlowRef {
  readonly businessType: OtherFlowType;
  readonly businessId: string;
}

/** 员工名下这两类业务的活动实例（运行中 / 已退回）中按配置会被终止的，按实例 ID 升序。 */
export async function terminableOtherFlows(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  exitKind: string,
): Promise<OtherFlow[]> {
  const policy = await exitTerminationOf(tx, ctx.tenantId, exitKind);
  if (!policy) return [];
  const rows = rowsOf<Omit<OtherFlow, 'flowType'> & { subset: string | null }>(
    await tx.execute(sql`SELECT i.id::text AS "instanceId", i.business_type AS "businessType",
        i.business_id::text AS "businessId", i.initiator_user_id::text AS "initiatorUserId", c.subset
      FROM approval_instances i
      LEFT JOIN personnel_change_requests c
        ON i.business_type = 'personnel_change' AND c.tenant_id = i.tenant_id AND c.id = i.business_id
      WHERE i.tenant_id=${ctx.tenantId} AND i.subject_employee_id=${employeeId}::uuid
        AND i.business_type IN ('personnel_change','retirement_intention')
        AND i.status IN ('running','returned')
      ORDER BY i.id`),
  );
  return rows
    .map(({ subset, ...row }) => ({
      ...row,
      flowType:
        row.businessType === 'retirement_intention'
          ? ('retirement_intention' as const)
          : personnelSubsetFlow(subset ?? ''),
    }))
    .filter((row) => policy[row.flowType]);
}

/** 申请单的可见坐标从当前租户业务表解析（不信任台账 / 调用方传入的坐标）。 */
async function flowCoordinates(tx: Tx, tenantId: string, refs: readonly FlowRef[]) {
  const ids = (type: OtherFlowType) =>
    `{${refs.filter((ref) => ref.businessType === type).map((ref) => ref.businessId)}}`;
  const rows = rowsOf<{ id: string; employeeId: string; departmentId: string | null; creatorId: string | null }>(
    await tx.execute(sql`SELECT q.id::text AS id, q.employee_id::text AS "employeeId",
        q.department_id::text AS "departmentId", q.initiator_user_id::text AS "creatorId"
      FROM retirement_intentions q WHERE q.tenant_id=${tenantId} AND q.id=ANY(${ids('retirement_intention')}::uuid[])
      UNION ALL
      SELECT r.id::text, r.employee_id::text, NULL, r.created_by::text
      FROM personnel_change_requests r WHERE r.tenant_id=${tenantId} AND r.id=ANY(${ids('personnel_change')}::uuid[])`),
  );
  return new Map(rows.map((row) => [row.id, row]));
}

const FLOW_OBJECT: Record<OtherFlowType, string> = {
  retirement_intention: EMPLOYMENT_OBJECT,
  personnel_change: PERSONNEL_REQUEST_OBJECT,
};

/** 逐项判定查看人能否看到这张申请单（与 refs 同序）。没有授权器（可信端口 / 定时任务）时按 ctx.scope 判定。 */
export async function visibleFlows(tx: Tx, ctx: EmploymentContext, refs: readonly FlowRef[]): Promise<boolean[]> {
  if (!refs.length) return [];
  const coordinates = await flowCoordinates(tx, ctx.tenantId, refs);
  const result = refs.map(() => false);
  for (const type of Object.keys(FLOW_OBJECT) as OtherFlowType[]) {
    const indexes = refs.flatMap((ref, index) => (ref.businessType === type ? [index] : []));
    const present = indexes.filter((index) => coordinates.has(refs[index]!.businessId));
    if (!present.length) continue;
    let scope = ctx.scope;
    if (ctx.authorize) {
      const resource = FLOW_OBJECT[type];
      if (!(await ctx.authorize({ ...ctx, action: 'object.view', resource }))) continue;
      const deps = { authorize: ctx.authorize, clock: () => ctx.now };
      scope =
        type === 'retirement_intention' ? ctx.scope : await resolveModuleScopeInTransaction(deps, ctx, tx, resource);
    }
    const visible = await visibleEmploymentRecords(
      tx,
      ctx.tenantId,
      scope,
      present.map((index) => coordinates.get(refs[index]!.businessId)!),
    );
    present.forEach((index, at) => (result[index] = visible[at] ?? false));
  }
  return result;
}

/** 披露：可见的给出业务单 ID、审批类型与流程码，不可见的只计件数（预览 warning 与 409 details 同一形态）。 */
export async function discloseFlows(tx: Tx, ctx: EmploymentContext, flows: readonly OtherFlow[]) {
  const visible = await visibleFlows(tx, ctx, flows);
  const shown = flows.filter((_, index) => visible[index]);
  return {
    items: shown.map((row) => ({ businessId: row.businessId, approvalType: row.businessType, flowType: row.flowType })),
    hiddenCount: flows.length - shown.length,
  };
}
