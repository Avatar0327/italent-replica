/**
 * F-478 S4 验收夹具：退休返聘分支。审批世界沿用 approvalWorld（真实 HTTP + 真实库 + 合成数据）；
 * 退休申请走退休专用入口（含「是否同时返聘」与返聘计划），办理走审批中心真实接口。
 * 所有租户数据读写放进 withTenant（DEC-568）。
 */
import { expect } from 'vitest';
import { approvalWorld, type ApprovalWorld, type InstanceView, type TaskView } from './AC-APV-support.js';
import { APV } from './AC-APV-F478-support.js';
import { detailOf, errorInfo, type DetailWithExits } from './AC-APV-F478-s2-support.js';
import { sql, withTenant, type Db } from '@italent/db';

export { APV, detailOf, errorInfo };

/** 退休审批的流程发起条件：按审批类型兜底。 */
export const RETIRE_CONDITIONS = { items: [] } as const;

export interface RetireScene {
  readonly w: ApprovalWorld;
  /** 原部门：负责人 / HRBP / 被退休员工的直线经理在这里。 */
  readonly home: { id: string; head: string; hrbp: string };
  /** 返聘计划的部门与返聘后直线经理。 */
  readonly back: { id: string; hrbp: string; manager: string };
  readonly manager: string;
  readonly subject: { userId: string; employeeId: string };
  /** 创建并提交退休申请；返回审批实例。 */
  retire(reEmployed: boolean, lastWorkDate?: string): Promise<InstanceView>;
  /** 办理一个待办：返回原始响应。 */
  decide(
    view: InstanceView,
    action: 'approve' | 'disagree',
    body?: Record<string, unknown>,
    actor?: string,
  ): Promise<Response>;
  /** 办理当前待办并重读详情。 */
  advance(view: InstanceView, body?: Record<string, unknown>): Promise<InstanceView>;
  businessStatus(businessId: string): Promise<string>;
  /** 退休申请的返聘事实：是否返聘与已生成的返聘业务 ID。 */
  extension(businessId: string): Promise<{ re_employed: boolean; rehire_business_id: string | null } | undefined>;
}

/** 搭建退休场景：原部门（负责人、HRBP）、返聘部门（HRBP）、被退休员工（带直线经理）。 */
export async function retireScene(db: Db, label: string): Promise<RetireScene> {
  const w = await approvalWorld(db, label);
  const homeId = await w.org('退休原部门');
  const backId = await w.org('返聘新部门');
  const head = await w.person('原部门负责人', homeId);
  const hrbp = await w.person('原部门HRBP', homeId);
  const backHrbp = await w.person('返聘部门HRBP', backId);
  const backManager = await w.person('返聘后直线经理', backId);
  const manager = await w.person('原直线经理', homeId);
  await w.setOrgRoles(homeId, { head: head.employeeId, hrbp: hrbp.employeeId });
  await w.setOrgRoles(backId, { hrbp: backHrbp.employeeId });
  const subject = await w.person('退休员工', homeId, { directManagerId: manager.employeeId });

  async function retire(reEmployed: boolean, lastWorkDate = '2026-10-31'): Promise<InstanceView> {
    const revision = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${subject.employeeId}`),
    );
    const body = {
      mode: 'application',
      lastWorkDate,
      ...(reEmployed
        ? {
            reEmployed: true,
            rehire: {
              fields: { employType: 'internal', departmentId: backId, directManagerId: backManager.employeeId },
              entry: { probation: false },
            },
          }
        : {}),
    };
    const created = await w.request(
      w.hr.id,
      'POST',
      `/api/tenant/employment/retirements/employees/${subject.employeeId}`,
      { ifMatch: revision.revision, body },
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const business = await w.json<{ id: string; revision: number }>(created, 201);
    return w.submit(business);
  }

  function decide(
    view: InstanceView,
    action: 'approve' | 'disagree',
    body: Record<string, unknown> = { comment: '办理' },
    actor?: string,
  ) {
    const task: TaskView = w.pending(view)[0]!;
    return w.taskAction(actor ?? task.assigneeUserId, task.id, action, view.revision, body);
  }

  async function advance(view: InstanceView, body: Record<string, unknown> = { comment: '办理' }) {
    const response = await decide(view, 'approve', body);
    expect(response.status, await response.clone().text()).toBe(200);
    return w.detail(view.id);
  }

  async function businessStatus(businessId: string): Promise<string> {
    return (await w.business(businessId)).status;
  }

  async function extension(businessId: string) {
    return withTenant(w.db, w.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT re_employed, rehire_business_id::text AS rehire_business_id
        FROM retirement_requests WHERE tenant_id=${w.tenant.id} AND business_id=${businessId}::uuid`);
      const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
      return rows[0] as { re_employed: boolean; rehire_business_id: string | null } | undefined;
    });
  }

  return {
    w,
    home: { id: homeId, head: head.userId, hrbp: hrbp.userId },
    back: { id: backId, hrbp: backHrbp.userId, manager: backManager.userId },
    manager: manager.userId,
    subject,
    retire,
    decide,
    advance,
    businessStatus,
    extension,
  };
}

export { activationsOf } from './AC-APV-F478-support.js';

export type { DetailWithExits };
