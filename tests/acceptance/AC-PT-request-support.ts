/**
 * BE-7 PT-4a 兼职申请验收夹具（docs/08_设计/R2-T05_兼职设计.md §13.2）：在审批中心夹具（approvalWorld）上建主职部门、兼职部门、
 * 审批人部门（四个节点的审批人都在这里，兼职部门和主职部门里除兼职员工外没有人，停用/作废用例不受干扰），
 * 以可信方式安装并发布“兼职”预置流程（与开通时同一路径）。申请经内部服务调用（PT-4a 没有公开路由），审批走真实审批中心接口。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { createUser, grantMembership, sql, withTenant, type Db, type Tx } from '@italent/db';
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
  createDateRequest,
  deleteRequest,
  revokeRequest,
  submitRequest,
  updateRequest,
  withdrawRequest,
  type AddRequestInput,
  type AddRequestPatch,
  type DateRequestInput,
} from '../../apps/api/src/modules/employment/part-time/request-service.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { approvalWorld, APV_TODAY, type InstanceView, type Person } from './AC-APV-support.js';
import { insertPartTimeRecord, type PartTimeSeed } from './AC-PT-support.js';
import { cmd, tenantApi, type RequestOptions } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const EMPLOYMENT = '/api/tenant/employment';
const REQUESTS = `${EMPLOYMENT}/part-time-requests`;
type Send = (method: string, path: string, options?: RequestOptions) => Promise<Response>;
/** 审批人看得到全部字段（盲审另测）。 */
export const ALL_VISIBLE: FieldAccess = { viewable: async () => undefined };

export interface WorldOptions {
  /** 主职部门负责人为空：第二节点无人，转异常管理员（首节点无人提交即报错，DEC-054，所以不能清 HRBP）。 */
  readonly noPrimaryHead?: boolean;
  /** 流程的异常管理员是一个外部账号（真 PG 锁序用例：入职按其邮箱首次绑定、全局停用接管）；缺省为夹具的默认异常管理员。 */
  readonly externalExceptionAdmin?: boolean | 'extend';
  /** 节点增加“不同意”出口（沿不同意连线办结，DEC-144）；预置流程只有同意出口。 */
  readonly disagree?: boolean;
  /** 把三类申请的四个节点都改成审批中可编辑结束日 / 备注（PB-82 / 83）；缺省保持预置（结束兼职 with_approve，其余不可编辑）。 */
  readonly editMode?: 'separate' | 'with_approve';
  /** 延长流程第 2 个节点改成会签（主职负责人 + 主职HRBP）：负责人为空时异常管理员占一席，替代人是 HRBP 时交接会合席（F-070）。 */
  readonly countersign?: boolean;
  /** 新增流程最后一个节点改成会签（兼职部门负责人 + 兼职部门 HRBP），配合 noSideHead：负责人为空时异常管理员占一席（PT-7 合席落地）。 */
  readonly lastCountersign?: boolean;
  /** 兼职部门负责人为空：末节点转异常管理员。 */
  readonly noSideHead?: boolean;
  /** 节点额外开放（表单字段 + 可编辑字段）的审批字段，用来分别覆盖“节点禁止编辑”与“适配器拒绝”两层。 */
  readonly extraEditable?: readonly string[];
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
  await w.setOrgRoles(primary, { head: options.noPrimaryHead ? null : pHead.employeeId, hrbp: pHrbp.employeeId });
  await w.setOrgRoles(side, { head: options.noSideHead ? null : sHead.employeeId, hrbp: sHrbp.employeeId });
  const worker = await w.person('兼职员工', primary);
  const tenantId = w.tenant.id;
  const external = options.externalExceptionAdmin
    ? await createUser(db, { email: `pt4a-${label}-${randomUUID()}@example.com`, displayName: '外部异常管理员' }, cmd())
    : null;
  if (external) await grantMembership(db, { tenantId, userId: external.id, expectedRevision: 0 }, cmd());

  await withTenant(db, tenantId, async (tx) => {
    const ctx = { tenantId, userId: w.hr.id, timezone: 'Asia/Shanghai', now: new Date(), commandId: randomUUID() };
    for (const installed of await installPresets(tx, { ...ctx, expectedRevision: 0 })) {
      if (!installed.approvalType.startsWith('part_time_')) continue;
      const preset = PRESET_PROCESSES.find((p) => p.presetKey === installed.presetKey)!;
      const definition = {
        ...preset.definition,
        // 外部异常管理员只给新增流程（缺省）或延长流程（'extend'）——真 PG 锁序用例的接管对象；延长 / 结束流程仍用夹具默认异常管理员
        exceptionAdminUserId:
          installed.approvalType ===
          (options.externalExceptionAdmin === 'extend' ? 'part_time_extend' : 'part_time_add')
            ? (external?.id ?? w.exceptionAdmin)
            : w.exceptionAdmin,
        nodes: preset.definition.nodes.map((preNode, index) => {
          const lastNode = index === preset.definition.nodes.length - 1;
          const node =
            options.lastCountersign && installed.approvalType === 'part_time_add' && lastNode
              ? {
                  ...preNode,
                  kind: 'countersign' as const,
                  key: 'side_joint',
                  name: '兼职部门联合会签',
                  approvers: ['record_department_head', 'record_department_hrbp'] as const,
                  transitionRule: { type: 'all' as const },
                }
              : options.countersign && installed.approvalType === 'part_time_extend' && index === 1
                ? {
                    ...preNode,
                    kind: 'countersign' as const,
                    key: 'joint',
                    name: '主职联合会签',
                    approvers: ['latest_record_department_head', 'latest_record_department_hrbp'] as const,
                    transitionRule: { type: 'all' as const },
                  }
                : preNode;
          return {
            ...node,
            ...(options.editMode
              ? {
                  editMode: options.editMode,
                  editableFields: ['endDate', 'requestRemark', ...(options.extraEditable ?? [])],
                  formFields: [...node.formFields, ...(options.extraEditable ?? [])],
                }
              : {}),
            ...(options.disagree ? { exits: ['approve', 'disagree'] as const } : {}),
          };
        }),
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
    run((tx) => updateRequest(tx, context(revision), id, patch));
  /** 可信造一条兼职记录（缺省：兼职部门、09-01～10-31、普通兼职）；不过校验，用来造边界场景。 */
  const seedRecord = (patch: Partial<PartTimeSeed> = {}) =>
    run((tx) =>
      insertPartTimeRecord(tx, {
        tenantId,
        employeeId: worker.employeeId,
        departmentId: side,
        startDate: '2026-09-01',
        endDate: '2026-10-31',
        ...patch,
      }),
    );
  /** 可信造数：给兼职记录追加一版快照载荷，把它的当前部门改成 departmentId（编辑兼职改部门的等价）。 */
  const moveSnapshot = (recordId: string, departmentId: string) =>
    run(async (tx) => {
      const [last] = rowsOf<{ id: string; version_no: number; effective_date: string; selected_staff_id: string }>(
        await tx.execute(sql`SELECT id, version_no, effective_date::text, selected_staff_id
          FROM employment_payload_versions WHERE tenant_id=${tenantId} AND business_id=${recordId}::uuid
          ORDER BY version_no DESC LIMIT 1`),
      );
      await tx.execute(sql`INSERT INTO employment_payload_versions(tenant_id, employee_id, business_id, version_no,
          previous_version_id, command_id, trigger_business_id, kind, mode, effective_date, form_id, selected_staff_id,
          is_record_snapshot, department_id)
        VALUES (${tenantId}, ${worker.employeeId}, ${recordId}, ${last!.version_no + 1}, ${last!.id}, ${randomUUID()},
          ${recordId}, 'part_time', 'direct', ${last!.effective_date}, 'part_time', ${last!.selected_staff_id}, true,
          ${departmentId})`);
    });
  /** 可信造数：给兼职记录追加一期（模拟别的入口——编辑 / 调动 / 批量结束——改过它的期限）。 */
  const appendTerm = (recordId: string, termNo: number, endDate: string | null, source: string) =>
    run((tx) =>
      tx.execute(sql`INSERT INTO employment_part_time_terms(tenant_id, employee_id, record_id, term_no, end_date,
          source, command_id)
        VALUES (${tenantId}, ${worker.employeeId}, ${recordId}, ${termNo}, ${endDate}, ${source},
          ${`pt-test-${randomUUID()}`})`),
    );
  /** 延长 / 结束申请（PT-4c）：经内部服务建草稿。 */
  const createDate = (input: DateRequestInput, ctx = context()) => run((tx) => createDateRequest(tx, ctx, input));
  const extend = (recordId: string, endDate: string, remark?: string) =>
    createDate({ requestType: 'extend', recordId, endDate, ...(remark !== undefined ? { remark } : {}) });
  const end = (recordId: string, endDate: string, remark?: string) =>
    createDate({ requestType: 'end', recordId, endDate, ...(remark !== undefined ? { remark } : {}) });
  const send = (id: string, revision: number, userId = w.hr.id) =>
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
          (SELECT count(*)::int FROM employment_records
            WHERE tenant_id=${tenantId} AND service_type<>'primary') AS parts,
          (SELECT count(*)::int FROM employment_part_time_terms WHERE tenant_id=${tenantId}) AS terms,
          (SELECT count(*)::int FROM audit_events WHERE tenant_id=${tenantId}) AS audits,
          (SELECT count(*)::int FROM employment_outbox WHERE tenant_id=${tenantId}) AS outbox,
          (SELECT count(*)::int FROM command_ledger WHERE tenant_id=${tenantId}) AS ledger`),
      );
      return row!;
    });
  const auditActions = (id: string) =>
    run(async (tx) =>
      rowsOf<{ action: string }>(
        await tx.execute(sql`SELECT action FROM audit_events
          WHERE tenant_id=${tenantId} AND object_id=${id} ORDER BY action`),
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

  /** 可信造数一条审批中的离职（R2-T03 门禁入口 B3-3 之前不落地，§4.3A F3）；生效日 = 最后工作日次日。 */
  async function pendingExit(lastWorkDate: string) {
    const id = randomUUID();
    const payload = randomUUID();
    const next = new Date(`${lastWorkDate}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const cycle = await run(async (tx) =>
      rowsOf<{ id: string }>(
        await tx.execute(sql`SELECT id FROM employment_cycles
          WHERE tenant_id=${tenantId} AND employee_id=${worker.employeeId}::uuid`),
      ),
    );
    await run(async (tx) => {
      await tx.execute(sql`INSERT INTO employment_business_objects(id, tenant_id, employee_id)
        VALUES (${id}, ${tenantId}, ${worker.employeeId})`);
      await tx.execute(sql`INSERT INTO employment_payload_versions(id, tenant_id, employee_id, business_id, version_no,
          kind, mode, effective_date, last_work_date, form_id, selected_staff_id)
        VALUES (${payload}, ${tenantId}, ${worker.employeeId}, ${id}, 1, 'leave', 'application',
          ${next.toISOString().slice(0, 10)}, ${lastWorkDate}, 'leave', ${cycle[0]!.id})`);
      for (const [index, state] of ['draft', 'in_review'].entries())
        await tx.execute(sql`INSERT INTO employment_state_events(tenant_id, employee_id, business_id,
            payload_version_id, state, event_no, command_id)
          VALUES (${tenantId}, ${worker.employeeId}, ${id}, ${payload}, ${state}, ${index + 1},
            ${`pt-exit-${id}-${index}`})`);
    });
    return id;
  }

  /** PT-4b 公开入口的请求体（新增申请）；fields 合并部门缺省值。 */
  const requestBody = (patch: Record<string, unknown> = {}) => ({
    requestType: 'add',
    employeeId: worker.employeeId,
    partTimeType: 'part_time',
    startDate: '2026-09-01',
    ...patch,
    fields: { departmentId: side, ...(patch.fields as object | undefined) },
  });
  /** 同一租户 / HR 用户换授权器的请求函数（受限操作人 / 可撤权授权器）；时钟与世界一致。 */
  function sendWith(authorize: Authorizer, user = w.hr.id): Send {
    const api = tenantApi(db, { authorize, clock: w.clock });
    return (method, path, options = {}) => api.request(method, path, { user, tenant: tenantId, ...options });
  }
  /** 申请入口（PT-4b）：缺省以 HR 全权身份请求，可传 sendWith(...) 换成受限授权器或其他用户。 */
  function http(send: Send = (method, path, options) => w.request(w.hr.id, method, path, options)) {
    return {
      create: (patch: Record<string, unknown> = {}, options: RequestOptions = {}) =>
        send('POST', REQUESTS, { body: requestBody(patch), ...options }),
      /** 延长 / 结束申请（PT-4c）：请求体 { requestType, recordId, endDate, requestRemark?, submit? }。 */
      createDate: (body: Record<string, unknown>, options: RequestOptions = {}) =>
        send('POST', REQUESTS, { body, ...options }),
      one: (id: string) => send('GET', `${REQUESTS}/${id}`),
      patch: (id: string, revision: number, body: Record<string, unknown>, options: RequestOptions = {}) =>
        send('PATCH', `${REQUESTS}/${id}`, { ifMatch: revision, body, ...options }),
      act: (id: string, action: 'submit' | 'withdraw' | 'revoke', revision: number, options: RequestOptions = {}) =>
        send('POST', `${REQUESTS}/${id}/${action}`, { ifMatch: revision, ...options }),
      remove: (id: string, revision: number, options: RequestOptions = {}) =>
        send('DELETE', `${REQUESTS}/${id}`, { ifMatch: revision, ...options }),
    };
  }
  /** 成功响应的 JSON（失败时把响应体带进断言信息）。 */
  async function ok<T = RequestBody>(response: Response, status = 200): Promise<T> {
    const text = await response.clone().text();
    if (response.status !== status) throw new Error(`预期 ${status}，实际 ${response.status}：${text}`);
    return (await response.json()) as T;
  }
  /** 失败响应：状态码 + 机读错误码 + details.reason。 */
  async function refusal(response: Response) {
    const parsed = (await response.json()) as {
      error: { code: string; message: string; details?: { reason?: string } };
    };
    return { status: response.status, code: parsed.error.code, reason: parsed.error.details?.reason };
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

  /** 节点顺序（§4.5）：新增 / 延长 = 主职HRBP → 主职负责人 → 兼职HRBP → 兼职负责人；结束相反。 */
  const order = {
    add: [pHrbp, pHead, sHrbp, sHead],
    extend: [pHrbp, pHead, sHrbp, sHead],
    end: [sHead, sHrbp, pHead, pHrbp],
  };
  /** 按给定顺序逐个同意，每次先断言当前待办恰是该审批人（PB-38）。 */
  async function approveInOrder(requestId: string, actors: readonly Person[], stopBefore = actors.length) {
    for (const [index, actor] of actors.slice(0, stopBefore).entries()) {
      const pending = w.pending(await instance(requestId)).map((task) => task.assigneeUserId);
      expect(pending, `第 ${index + 1} 个节点`).toEqual([actor.userId]);
      await decide(requestId, actor, 'approve');
    }
  }

  return {
    ...w,
    external,
    order,
    approveInOrder,
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
    seedRecord,
    moveSnapshot,
    appendTerm,
    createDate,
    extend,
    end,
    send,
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
    pendingExit,
    instance,
    decide,
    approveAll,
    requestBody,
    sendWith,
    http,
    ok,
    refusal,
  };
}

/** 申请接口响应体（读形状；字段是否出现取决于查看权）。 */
export interface RequestBody {
  id: string;
  employeeId: string;
  revision: number;
  kind: string;
  status: string;
  initiator: string;
  processCode: string | null;
  versionNo: number;
  serviceType: string;
  effectiveDate: string;
  endDate: string | null;
  /** 延长 / 结束申请：创建时目标兼职记录的当前结束日（原定结束日期，不随落地回写）。 */
  originalEndDate: string | null;
  requestRemark: string | null;
  /** 延长 / 结束申请：目标兼职记录；新增申请：审批通过并落地后的兼职记录。 */
  recordId: string | null;
  fields: Record<string, unknown>;
  customFields: Record<string, unknown>;
  warnings: { reason: string }[];
  primary?: { fields: Record<string, unknown> };
  employee?: { code: string; name: string };
}

export type RequestWorld = Awaited<ReturnType<typeof requestWorld>>;
