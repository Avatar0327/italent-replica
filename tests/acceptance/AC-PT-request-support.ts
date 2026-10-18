/**
 * BE-7 PT-4a 兼职申请验收夹具（docs/08_设计/R2-T05_兼职设计.md §13.2）：在审批中心夹具（approvalWorld）上建主职部门、兼职部门、
 * 审批人部门（四个节点的审批人都在这里，兼职部门和主职部门里除兼职员工外没有人，停用/作废用例不受干扰），
 * 以可信方式安装并发布“兼职”预置流程（与开通时同一路径）。申请经内部服务调用（PT-4a 没有公开路由），审批走真实审批中心接口。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db, type Tx } from '@italent/db';
import { PRESET_PROCESSES } from '@italent/domain';
import { expect } from 'vitest';
import type { FieldAccess } from '../../apps/api/src/modules/approval/context.js';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { installPresets, publishProcess, replaceDraft } from '../../apps/api/src/modules/approval/definitions.js';
import {
  loadPartTimeRequest,
  type PartTimeRequestRow,
} from '../../apps/api/src/modules/employment/part-time/request-store.js';
import {
  createAddRequest,
  deleteRequest,
  revokeRequest,
  submitRequest,
  updateAddRequest,
  withdrawRequest,
  type AddRequestInput,
  type AddRequestPatch,
} from '../../apps/api/src/modules/employment/part-time/request-service.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { approvalWorld, APV_TODAY, type InstanceView, type Person } from './AC-APV-support.js';
import { uniqueSuffix } from './support/unique.js';

const EMPLOYMENT = '/api/tenant/employment';
/** 审批人看得到全部字段（盲审另测）。 */
export const ALL_VISIBLE: FieldAccess = { viewable: async () => undefined };

export interface WorldOptions {
  /** 主职部门 HRBP 为空：首节点无人，转异常管理员（F-165③）。 */
  readonly noPrimaryHrbp?: boolean;
  /** 流程的异常管理员（缺省夹具的默认异常管理员）。 */
  readonly exceptionAdmin?: string;
  /** 把四个节点改成审批中可编辑结束日 / 备注（PB-82 / 83）。 */
  readonly editMode?: 'separate' | 'with_approve';
}

export async function requestWorld(db: Db, label: string, options: WorldOptions = {}) {
  const w = await approvalWorld(db, `pt4a-${label}`);
  const primary = await w.org(`主职部门${uniqueSuffix()}`);
  const side = await w.org(`兼职部门${uniqueSuffix()}`);
  const staff = await w.org(`审批人部门${uniqueSuffix()}`);
  const [pHrbp, pHead, sHrbp, sHead] = [
    await w.person('主职HRBP', staff),
    await w.person('主职负责人', staff),
    await w.person('兼职HRBP', staff),
    await w.person('兼职负责人', staff),
  ];
  await w.setOrgRoles(primary, { head: pHead.employeeId, hrbp: options.noPrimaryHrbp ? null : pHrbp.employeeId });
  await w.setOrgRoles(side, { head: sHead.employeeId, hrbp: sHrbp.employeeId });
  const worker = await w.person('兼职员工', primary);
  const tenantId = w.tenant.id;

  await withTenant(db, tenantId, async (tx) => {
    const ctx = { tenantId, userId: w.hr.id, timezone: 'Asia/Shanghai', now: new Date(), commandId: randomUUID() };
    for (const installed of await installPresets(tx, { ...ctx, expectedRevision: 0 })) {
      if (installed.approvalType !== 'part_time_add') continue;
      const preset = PRESET_PROCESSES.find((p) => p.presetKey === installed.presetKey)!;
      const definition = {
        ...preset.definition,
        exceptionAdminUserId: options.exceptionAdmin ?? w.exceptionAdmin,
        nodes: preset.definition.nodes.map((node) =>
          options.editMode
            ? { ...node, editMode: options.editMode, editableFields: ['endDate', 'requestRemark'] }
            : node,
        ),
      };
      const draft = await replaceDraft(tx, { ...ctx, expectedRevision: installed.revision }, installed.id, definition);
      await publishProcess(tx, { ...ctx, expectedRevision: draft.revision }, installed.id);
    }
  });

  /** 内部服务的任职上下文（可信端口，scope 为空 = 不设范围）；userId 缺省为 HR 发起人。 */
  const context = (expectedRevision = 0, userId = w.hr.id): EmploymentContext => ({
    tenantId,
    userId,
    timezone: w.tenant.timezone,
    now: new Date(`${APV_TODAY}T01:00:00.000Z`),
    commandId: randomUUID(),
    expectedRevision,
  });
  const run = <T>(work: (tx: Tx) => Promise<T>) => withTenant(db, tenantId, work);

  const input = (patch: Partial<AddRequestInput> = {}): AddRequestInput => ({
    employeeId: worker.employeeId,
    serviceType: 'part_time',
    startDate: '2026-09-01',
    endDate: null,
    departmentId: side,
    ...patch,
  });
  const create = (patch: Partial<AddRequestInput> = {}, ctx = context()) =>
    run((tx) => createAddRequest(tx, ctx, input(patch)));
  const update = (id: string, revision: number, patch: AddRequestPatch) =>
    run((tx) => updateAddRequest(tx, context(revision), id, patch));
  const submit = (id: string, revision: number, userId = w.hr.id) =>
    run((tx) => submitRequest(tx, context(revision, userId), id, ALL_VISIBLE));
  const withdraw = (id: string, revision: number) => run((tx) => withdrawRequest(tx, context(revision), id));
  const revoke = (id: string, revision: number) => run((tx) => revokeRequest(tx, context(revision), id));
  const remove = (id: string, revision: number) => run((tx) => deleteRequest(tx, context(revision), id));
  /** 预期被拒绝：返回 { code, reason, details }；成功则抛错。 */
  async function rejected(work: () => Promise<unknown>) {
    try {
      await work();
    } catch (error) {
      const e = error as { code?: string; details?: { reason?: string } & Record<string, unknown> };
      return { code: e.code, reason: e.details?.reason, details: e.details };
    }
    throw new Error('预期被拒绝，但成功了');
  }

  const load = (id: string): Promise<PartTimeRequestRow> =>
    run(async (tx) => (await loadPartTimeRequest(tx, tenantId, id))!);
  const states = (id: string) =>
    run(async (tx) =>
      rowsOf<{ state: string; reason: string | null; record_id: string | null }>(
        await tx.execute(sql`SELECT state, reason, record_id::text FROM part_time_request_events
          WHERE tenant_id=${tenantId} AND request_id=${id}::uuid ORDER BY event_no`),
      ),
    );
  /** 写入指纹：被拒后逐项相等 = 当次没有任何写入（申请三表、兼职记录、期限、审计、outbox）。 */
  const writes = () =>
    run(async (tx) => {
      const [row] = rowsOf<Record<string, number>>(
        await tx.execute(sql`SELECT
          (SELECT count(*)::int FROM part_time_requests WHERE tenant_id=${tenantId}) AS requests,
          (SELECT count(*)::int FROM part_time_request_versions WHERE tenant_id=${tenantId}) AS versions,
          (SELECT count(*)::int FROM part_time_request_events WHERE tenant_id=${tenantId}) AS events,
          (SELECT count(*)::int FROM employment_records WHERE tenant_id=${tenantId} AND service_type<>'primary') AS parts,
          (SELECT count(*)::int FROM employment_part_time_terms WHERE tenant_id=${tenantId}) AS terms,
          (SELECT count(*)::int FROM audit_events WHERE tenant_id=${tenantId}) AS audits,
          (SELECT count(*)::int FROM employment_outbox WHERE tenant_id=${tenantId}) AS outbox`),
      );
      return row!;
    });
  const auditActions = (id: string) =>
    run(async (tx) =>
      rowsOf<{ action: string }>(
        await tx.execute(sql`SELECT action FROM audit_events
          WHERE tenant_id=${tenantId} AND object_id=${id}::uuid ORDER BY occurred_at, id`),
      ).map((row) => row.action),
    );
  const partTimeRecords = () =>
    run(async (tx) =>
      rowsOf<{ id: string; start_date: string; service_type: string; department_id: string }>(
        await tx.execute(sql`SELECT id::text, start_date::text, service_type, department_id::text
          FROM employment_records WHERE tenant_id=${tenantId} AND service_type<>'primary'`),
      ),
    );
  const terms = (recordId: string) =>
    run(async (tx) =>
      rowsOf<{ term_no: number; end_date: string | null; source: string; source_id: string | null }>(
        await tx.execute(sql`SELECT term_no, end_date::text, source, source_id::text FROM employment_part_time_terms
          WHERE tenant_id=${tenantId} AND record_id=${recordId}::uuid ORDER BY term_no`),
      ),
    );
  const notices = (instanceId: string) =>
    run(async (tx) =>
      rowsOf<{ recipient: string; template: string | null; kind: string }>(
        await tx.execute(sql`SELECT recipient_user_id::text AS recipient, template_code AS template, kind
          FROM approval_notifications WHERE tenant_id=${tenantId} AND instance_id=${instanceId}::uuid`),
      ).filter((row) => row.kind === 'message'),
    );

  /** 经真实任职入口办理直接离职（最后工作日 lastWorkDate，生效日早于今天时当场落地，状态钩子随之触发）。 */
  async function leave(lastWorkDate: string) {
    const current = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `${EMPLOYMENT}/employees/${worker.employeeId}`),
    );
    return w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', `${EMPLOYMENT}/employees/${worker.employeeId}/businesses`, {
        ifMatch: current.revision,
        body: { kind: 'leave', mode: 'direct', lastWorkDate },
      }),
      201,
    );
  }

  const instance = (requestId: string): Promise<InstanceView> => w.instanceOf(requestId);
  /** 当前待办人做决定（approve / reject / disagree / edit），返回最新实例。 */
  async function decide(
    requestId: string,
    actor: Person | { userId: string },
    action: 'approve' | 'reject' | 'disagree' | 'edit',
    fields?: Record<string, unknown>,
    expectStatus = 200,
  ) {
    const view = await instance(requestId);
    const task = w.pending(view).find((t) => t.assigneeUserId === actor.userId);
    expect(task, '该审批人没有待办').toBeDefined();
    const response = await w.taskAction(actor.userId, task!.id, action, view.revision, {
      comment: '合成意见',
      ...(fields ? { fields } : {}),
    });
    expect(response.status, await response.clone().text()).toBe(expectStatus);
    return response;
  }
  /** 四个节点依次同意。 */
  async function approveAll(requestId: string) {
    for (const actor of [pHrbp, pHead, sHrbp, sHead]) await decide(requestId, actor, 'approve');
  }

  return {
    ...w,
    primary,
    side,
    staff,
    worker,
    approvers: { pHrbp, pHead, sHrbp, sHead },
    context,
    run,
    input,
    create,
    update,
    submit,
    withdraw,
    revoke,
    remove,
    rejected,
    load,
    states,
    writes,
    auditActions,
    partTimeRecords,
    terms,
    notices,
    leave,
    instance,
    decide,
    approveAll,
  };
}

export type RequestWorld = Awaited<ReturnType<typeof requestWorld>>;
