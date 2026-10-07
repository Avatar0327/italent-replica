/**
 * F-024 R1 端到端验收夹具（DEC-221③）：在 R1-T07 审批夹具之上，把主线各角色都换成**真实授权器**下的真实身份：
 * - 员工本人：只有账号绑定，无任何授权行（R1-T13 自动自助身份）；
 * - 审批人（调出负责人 / 调入 HRBP / 调入负责人）与异常管理员：只授予“任职记录字段可见”的身份，不带数据范围（DEC-057）；
 * - 范围内 HR / 范围外 HR：持完整任职记录身份（含调动管理按钮），数据范围分别为 {调出, 调入} 与 {范围外部门}；
 * - 范围内 / 范围外审计员：日志审计管理员 + 任职字段可见身份 + 对应数据范围（R1-T16，DEC-197）。
 * 组织、人员入职、流程发布等**前置数据**仍经 R1-T07 夹具（可信装配）建立；被验收的每一步都走真实权限。
 * 定时生效经平台入口 runEmploymentActivations 运行，时钟由测试注入（DEC-056）。
 */
import { randomUUID } from 'node:crypto';
import { runEmploymentActivations, type EmploymentActivationRun } from '@italent/api';
import { sql, withTenant, type Db } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { expect } from 'vitest';
import {
  approvalWorld,
  grantVisibleFields,
  type InstanceView,
  type NodeInput,
  permissionAdmin,
  type Person,
} from './AC-APV-support.js';
import { auditApi, type DataChangeLog } from './AC-AUD-support.js';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  type PermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { cmd, tenantApi, type RequestOptions } from './support/tenant-api.js';

export const E2E_TODAY = '2026-10-01';
/** 本租户调动流程的前三个节点（`14` §2）：调出负责人 → 调入 HRBP → 调入负责人。 */
export const E2E_NODES: readonly NodeInput[] = [
  { key: 'out_head', name: '调出部门负责人审批', approver: 'latest_record_department_head' },
  { key: 'in_hrbp', name: '调入部门HRBP审核', approver: 'record_department_hrbp' },
  { key: 'in_head', name: '调入部门负责人审批', approver: 'record_department_head' },
];

export interface Actor {
  readonly user: string;
  readonly tenant: string;
}

export interface EmploymentRecordView {
  readonly id: string;
  readonly kind: string;
  readonly effectiveDate: string;
  readonly stopDate: string;
  readonly previousRecordId: string | null;
  readonly isCurrent: boolean;
  readonly isLatest: boolean;
  readonly isInserted?: boolean;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface BusinessView {
  readonly id: string;
  readonly employeeId: string;
  readonly status: string;
  readonly revision: number;
  readonly effectiveDate: string;
  readonly record: EmploymentRecordView | null;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly activation: { status: string; failureCount: number; failureReason: string | null } | null;
}

const INITIATOR_BUTTONS = ['Transfer.Hr', 'Transfer.Manager', 'Transfer.Self'];
const DIRECT_BUTTONS = ['EmploymentRecord.LineOp.Transfer', 'Employment.Tranfer'];

/** 全部任职记录字段编码（审批人 / 审计员的可见字段，不含数据范围）。 */
export const EMPLOYMENT_FIELDS = MODULE_OBJECTS.employmentRecord.fields.map((field) => field.code);

async function setScope(admin: PermissionWorld, userId: string, orgIds: readonly string[]) {
  const response = await admin.api.request('PUT', `/api/tenant/permission/scopes/${userId}/TenantBase`, {
    ...admin.asAdmin,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: orgIds.map((orgId) => ({ orgId, includeDescendants: true })) },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** 人事管理员：任职记录全部字段可见可编辑、调动管理与直接调动按钮、删除权；人员档案可见；数据范围 = 指定组织含下级。 */
export async function hrActor(admin: PermissionWorld, label: string, orgIds: readonly string[]): Promise<Actor> {
  const user = await addMember(admin, label);
  const profile = await createProfile(admin, `e2e-hr-${randomUUID().slice(0, 8)}`);
  const record = MODULE_OBJECTS.employmentRecord;
  const buttons = record.buttons
    .filter((button) => ![...INITIATOR_BUTTONS, ...DIRECT_BUTTONS].includes(button.code))
    .map((button) => ({ buttonCode: button.code, level: button.level }));
  buttons.push({ buttonCode: 'Transfer.Hr', level: 'detail' });
  buttons.push({ buttonCode: 'EmploymentRecord.LineOp.Transfer', level: 'list_row' });
  for (const [definition, extra, write] of [
    [record, buttons, true],
    [MODULE_OBJECTS.employee, [], true],
    // 组织只读：看组织列表（AC-TEN-01），不改组织。
    [MODULE_OBJECTS.organization, [], false],
  ] as const) {
    const response = await setObjectPermission(
      admin,
      profile,
      {
        dataOperations: { create: write, update: write, delete: write },
        fields: definition.fields.map((field) => ({ fieldCode: field.code, view: true, edit: write && !field.system })),
        buttons: [...extra],
      },
      definition.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  await makeGrantable(admin, [profile.id]);
  expect((await grant(admin, user.id, profile.id)).status).toBe(201);
  await setScope(admin, user.id, orgIds);
  return { user: user.id, tenant: admin.tenant.id };
}

/** 日志审计员：审计管理员角色 + 任职记录字段可见身份 + 数据范围（DEC-197 按查看人当前范围裁剪）。 */
export async function auditViewer(admin: PermissionWorld, label: string, orgIds: readonly string[]): Promise<Actor> {
  const viewer = await memberWithAdminRole(admin, 'audit_admin', label);
  await grantVisibleFields(admin, viewer.user.id, EMPLOYMENT_FIELDS);
  await setScope(admin, viewer.user.id, orgIds);
  return viewer.as;
}

export async function e2eWorld(db: Db, label: string) {
  const w = await approvalWorld(db, label);
  const admin = await permissionAdmin(w);
  const api = tenantApi(db, { authorize: undefined, clock: w.clock });
  const audit = auditApi(db, w.clock, { authorize: undefined });

  const from = await w.org('调出部门');
  const to = await w.org('调入部门');
  const elsewhere = await w.org('范围外部门');
  const outHead = await w.person('调出部门负责人', from);
  const inHead = await w.person('调入部门负责人', to);
  const inHrbp = await w.person('调入部门HRBP', to);
  await w.setOrgRoles(from, { head: outHead.employeeId });
  await w.setOrgRoles(to, { head: inHead.employeeId, hrbp: inHrbp.employeeId });
  const process = await w.publishedProcess({ nodes: E2E_NODES });
  // 审批人只授字段可见（DEC-057 不授范围）；异常管理员同样授予，否则盲审（DEC-058）会把任务拦在其手上。
  for (const userId of [outHead.userId, inHead.userId, inHrbp.userId, w.exceptionAdmin])
    await grantVisibleFields(admin, userId, EMPLOYMENT_FIELDS);
  const hr = await hrActor(admin, '范围内人事', [from, to]);
  const outsider = await hrActor(admin, '范围外人事', [elsewhere]);
  const auditor = await auditViewer(admin, '范围内审计员', [from, to]);
  const outsideAuditor = await auditViewer(admin, '范围外审计员', [elsewhere]);

  const as = (person: Person | string): Actor => ({
    user: typeof person === 'string' ? person : person.userId,
    tenant: w.tenant.id,
  });
  const request = (actor: Actor, method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, path, { ...options, ...actor });
  const json = async <T>(response: Response, status = 200): Promise<T> => {
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as T;
  };

  async function employeeRevision(actor: Actor, employeeId: string): Promise<number> {
    const employee = await json<{ revision: number }>(
      await request(actor, 'GET', `/api/tenant/employment/employees/${employeeId}`),
    );
    return employee.revision;
  }

  async function business(actor: Actor, id: string): Promise<BusinessView> {
    return json(await request(actor, 'GET', `/api/tenant/employment/businesses/${id}`));
  }

  async function records(actor: Actor, employeeId: string, asOf?: string): Promise<EmploymentRecordView[]> {
    const query = asOf ? `?asOf=${asOf}` : '';
    const page = await json<{ items: EmploymentRecordView[] }>(
      await request(actor, 'GET', `/api/tenant/employment/employees/${employeeId}/records${query}`),
    );
    return page.items;
  }

  async function instance(actor: Actor, id: string): Promise<InstanceView> {
    return json(await request(actor, 'GET', `/api/tenant/approval/instances/${id}`));
  }

  /** 发起人视角查本业务单的实例（审批中心“我发起的”列表，不需要身份权限）。 */
  async function instanceOf(initiator: Actor, businessId: string): Promise<InstanceView> {
    const list = await json<{ items: { id: string }[] }>(
      await request(initiator, 'GET', `/api/tenant/approval/instances?role=initiated&businessId=${businessId}`),
    );
    expect(list.items).toHaveLength(1);
    return instance(initiator, list.items[0]!.id);
  }

  function pending(view: InstanceView) {
    return view.tasks.filter((task) => task.status === 'pending');
  }

  /** 以当前待办的审批人身份处理本节点（真实授权器：盲审、自审、字段权限全部生效）。 */
  async function act(
    view: InstanceView,
    action: 'approve' | 'reject',
    body: Record<string, unknown> = {},
  ): Promise<InstanceView> {
    const tasks = pending(view);
    expect(tasks, `实例 ${view.id} 应恰有一个待办`).toHaveLength(1);
    const task = tasks[0]!;
    return json(
      await request(as(task.assigneeUserId), 'POST', `/api/tenant/approval/tasks/${task.id}/${action}`, {
        ifMatch: view.revision,
        body,
      }),
    );
  }

  /** 逐节点同意直到实例结束；返回每步的审批人与节点，供断言流转路径。 */
  async function approveAll(
    view: InstanceView,
  ): Promise<{ steps: { nodeKey: string; by: string }[]; view: InstanceView }> {
    const steps: { nodeKey: string; by: string }[] = [];
    let current = view;
    while (current.status === 'running') {
      const task = pending(current)[0]!;
      steps.push({ nodeKey: task.nodeKey, by: task.assigneeUserId });
      current = await act(current, 'approve');
    }
    return { steps, view: current };
  }

  /** 定时生效：平台入口，按服务器 UTC 时钟运行；只跑本租户。 */
  async function runScheduler(at: string): Promise<EmploymentActivationRun> {
    const result = await runEmploymentActivations(db, cmd(), { tenantId: w.tenant.id }, { clock: () => new Date(at) });
    expect(result.runs).toHaveLength(1);
    return result.runs[0]!;
  }

  async function dataChanges(viewer: Actor, query: Record<string, string>): Promise<DataChangeLog[]> {
    return (await audit.dataChanges(viewer, query)).items;
  }

  /** 审计事件的原始写入（只读观测，不经权限）：用于核对事件时间与系统操作人。 */
  async function rawAudit(objectId: string) {
    return withTenant(db, w.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT action, actor_user_id AS "actorUserId", occurred_at AS "occurredAt",
          after FROM audit_events WHERE tenant_id=${w.tenant.id} AND object_id=${objectId} ORDER BY occurred_at, id`);
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
        action: string;
        actorUserId: string | null;
        occurredAt: Date | string;
        after: Record<string, unknown> | null;
      }[];
    });
  }

  /** HR 调动管理入口（R1-T09 `/transfers/employees/:id`）：缺省为跨部门调动申请并提交。 */
  async function hrTransfer(actor: Actor, employeeId: string, body: Record<string, unknown>) {
    return request(actor, 'POST', `/api/tenant/employment/transfers/employees/${employeeId}`, {
      ifMatch: await employeeRevision(actor, employeeId),
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode: 'application',
        submit: true,
        fields: { departmentId: to },
        ...body,
      },
    });
  }

  /** 通用任职业务入口（直接业务 / 补录）。 */
  async function directBusiness(actor: Actor, employeeId: string, body: Record<string, unknown>) {
    return json<BusinessView>(
      await request(actor, 'POST', `/api/tenant/employment/employees/${employeeId}/businesses`, {
        ifMatch: await employeeRevision(actor, employeeId),
        body: { mode: 'direct', ...body },
      }),
      201,
    );
  }

  /** 给某成员授予任职记录字段可见身份（不带范围，DEC-057）：新加入流程的审批人用。 */
  const grantVisible = (userId: string) => grantVisibleFields(admin, userId, EMPLOYMENT_FIELDS);

  return {
    ...w,
    admin,
    api,
    grantVisible,
    audit,
    from,
    to,
    elsewhere,
    outHead,
    inHead,
    inHrbp,
    process,
    hr,
    outsider,
    auditor,
    outsideAuditor,
    as,
    request,
    json,
    employeeRevision,
    business,
    records,
    instance,
    instanceOf,
    pending,
    act,
    approveAll,
    runScheduler,
    dataChanges,
    rawAudit,
    hrTransfer,
    directBusiness,
  };
}

export type E2EWorld = Awaited<ReturnType<typeof e2eWorld>>;

/** 版本链快照：按生效日与操作先后排列的 (id, 生效日, 结束日, 部门, 前一条, 是否当前)。 */
export function chain(records: readonly EmploymentRecordView[]) {
  return records.map((record) => ({
    id: record.id,
    effectiveDate: record.effectiveDate,
    stopDate: record.stopDate,
    departmentId: record.fields.departmentId,
    previousRecordId: record.previousRecordId,
    isCurrent: record.isCurrent,
  }));
}
