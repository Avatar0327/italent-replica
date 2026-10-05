/**
 * R1-T07 审批中心验收夹具：合成租户、组织、人员与账号绑定；流程经公开接口建立并发布。
 * 组织负责人 / HRBP 的人员引用写入仍由 R1-T03 暂缓（Q-M0-11），此处与 AC-PRM 相同，用可信夹具追加组织版本。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createUser,
  type Db,
  eq,
  grantMembership,
  orgHierarchyLinks,
  orgVersions,
  permissionUserPersonLinks,
  sql,
  tenants,
  users,
  withPlatform,
  withTenant,
} from '@italent/db';
import { bootstrapTenantAdmin } from '@italent/api';
import { APPROVAL_TYPES, MODULE_OBJECTS, type ApprovalTypeCode, type ObjectDefinition } from '@italent/domain';
import { expect } from 'vitest';
import { createProcess, publishProcess } from '../../apps/api/src/modules/approval/definitions.js';
import { withLoginEmail } from './AC-EMP-support.js';
import { createProfile, grant, makeGrantable, setObjectPermission, type PermissionWorld } from './AC-PRM-support.js';
import { cmd, seedTenantWithMember, tenantApi, type RequestOptions } from './support/tenant-api.js';

export const APV_TODAY = '2026-10-01';
const BASE = '/api/tenant/approval';

export type ApproverExpressionInput =
  | 'owner'
  | 'latest_record_department_head'
  | 'record_department_head'
  | 'record_department_hrbp'
  | 'record_first_level_org_head';

export interface ExitRuleInput {
  readonly kind: 'count' | 'percent';
  readonly value: number;
}

export interface TransitionRuleInput {
  readonly type: 'any' | 'all' | 'custom';
  readonly rules?: { readonly approve?: ExitRuleInput; readonly disagree?: ExitRuleInput };
}

export interface NodeInput {
  readonly key: string;
  readonly name?: string;
  /** F-003：节点类型，缺省为单人审批。 */
  readonly kind?: 'single' | 'countersign';
  /** 单人审批节点的审批人。 */
  readonly approver?: ApproverExpressionInput;
  /** F-003：会签节点的审批人（多人同时审批、无先后）。 */
  readonly approvers?: readonly ApproverExpressionInput[];
  /**
   * F-003 / DEC-144：会签流转规则——任一人同意即可（缺省）/ 需所有人同意 / 自定义审批方式（按出口动作设整数或百分比）。
   */
  readonly transitionRule?: TransitionRuleInput;
  /** F-003：节点出口动作（同意 / 不同意），缺省只有同意；驳回是节点动作，不在其中（DEC-144）。 */
  readonly exits?: readonly ('approve' | 'disagree')[];
  readonly noAssignee?: 'exception_admin' | 'skip' | 'approve';
  readonly sameAssigneeSkip?: boolean;
  readonly historySameAssigneeSkip?: boolean;
  /** DEC-106：自动处理结果「同意」（默认）/「跳过」。 */
  readonly sameAssigneeResult?: 'approve' | 'skip';
  readonly historySameAssigneeResult?: 'approve' | 'skip';
  readonly formFields?: readonly string[];
  readonly editableFields?: readonly string[];
  readonly editMode?: 'none' | 'separate' | 'with_approve';
  readonly actions?: {
    readonly transfer?: boolean;
    readonly addSign?: boolean;
    readonly copySend?: boolean;
    readonly retrieve?: boolean;
    readonly urge?: 'inherit' | 'enabled' | 'disabled';
    /** 驳回（驳回到发起人）开关，缺省开启（F-003 第二轮，`14` §12.2）。 */
    readonly reject?: boolean;
  };
  readonly rejectCommentRequired?: boolean;
  /** DEC-104：审批记录查看权限——勾选后本节点审批人看不到审批记录与沟通。 */
  readonly hideRecords?: boolean;
  readonly rejectResubmit?: 'restart' | 'rejecting_node';
  readonly messageRules?: readonly {
    trigger: string;
    channels: readonly string[];
    template: string;
    recipient: string;
  }[];
}

export interface ConditionItem {
  readonly no: number;
  readonly field: string;
  readonly operator: string;
  readonly value?: unknown;
}

export interface ProcessInput {
  readonly code?: string;
  readonly name?: string;
  readonly approvalType?: string;
  readonly priority?: number;
  readonly isFallback?: boolean;
  readonly exceptionAdminUserId?: string | null;
  /** DEC-104：开始节点的审批记录查看权限——勾选后发起人看不到审批记录与沟通。 */
  readonly hideRecordsFromInitiator?: boolean;
  readonly conditions?: { readonly items: readonly ConditionItem[]; readonly expression?: string };
  readonly nodes: readonly NodeInput[];
}

export interface VersionView {
  readonly id: string;
  readonly versionNo: number;
  readonly status: 'draft' | 'published';
  readonly name: string;
  readonly priority: number;
  readonly isFallback: boolean;
  readonly exceptionAdminUserId: string | null;
  readonly conditions: { items: ConditionItem[]; expression: string };
  readonly nodes: (NodeInput & { name: string })[];
}

export interface ProcessView {
  readonly id: string;
  readonly code: string;
  readonly approvalType: string;
  readonly objectCode: string;
  readonly status: 'active' | 'discarded';
  readonly revision: number;
  readonly presetKey: string | null;
  readonly currentVersion: VersionView | null;
  readonly latestVersion: VersionView;
}

export interface TaskView {
  readonly id: string;
  readonly nodeKey: string;
  readonly nodeName: string;
  readonly assigneeUserId: string;
  readonly status: string;
  readonly origin: string;
  readonly isExceptionAdmin: boolean;
  readonly adminSelfTransfer: boolean;
  readonly comment: string | null;
  readonly round?: number;
  readonly parentTaskId?: string | null;
  readonly candidateUserId?: string | null;
  /** F-003：节点本次激活（会签结算范围）。 */
  readonly activationId?: string | null;
}

export interface LogView {
  readonly taskId?: string | null;
  readonly event: string;
  readonly nodeKey: string | null;
  readonly actorUserId: string | null;
  readonly adminSelfTransfer: boolean;
  readonly detail: Record<string, unknown>;
}

export interface InstanceView {
  readonly id: string;
  /** disapproved：沿「不同意」连线流转到结束（DEC-144），流程结束、业务不生效（F-003 第二轮）。 */
  readonly status: 'running' | 'returned' | 'approved' | 'disapproved' | 'withdrawn' | 'cancelled';
  readonly approvalType: string;
  readonly processId: string;
  readonly versionNo: number;
  readonly businessId: string;
  readonly revision: number;
  readonly currentNodeKey: string | null;
  readonly initiatorUserId: string;
  readonly subjectEmployeeId: string | null;
  readonly tasks: TaskView[];
  readonly logs: LogView[];
  readonly form: { nodeKey: string | null; values: Record<string, unknown>; originals?: Record<string, unknown> };
  readonly actions: string[];
  readonly title: string;
  readonly commentNotice?: string;
  readonly processCode?: string | null;
  /** DEC-104：查看人所在节点（或开始节点）勾选了审批记录查看权限，审批记录与沟通已隐藏。 */
  readonly recordsHidden?: boolean;
}

export interface Person {
  readonly userId: string;
  readonly employeeId: string;
  readonly name: string;
}

/**
 * 可信夹具的固定编号（F-008 / R6-1 第七轮 P3）：大小写用例要求编号一定含字母，随机 UUID 做不到，改用固定编号。
 * 只用于需要固定编号的用例；同一测试文件共用一个库，固定编号在文件内不得重复。
 */
export interface FixedIds {
  readonly tenantId?: string;
  readonly exceptionAdminId?: string;
}

/** 以固定编号开通租户（直接写平台表，不走 createTenant：它不接受指定编号），其余同 seedTenantWithMember。 */
async function seedFixedTenant(db: Db, label: string, tenantId: string) {
  const suffix = randomBytes(3).toString('hex');
  const [tenant] = await withPlatform(db, (tx) =>
    tx
      .insert(tenants)
      .values({ id: tenantId, code: `${label}-${suffix}`, name: `租户${label}` })
      .returning(),
  );
  const user = await createUser(db, { email: `${label}-${suffix}@example.com`, displayName: `${label} 管理员` }, cmd());
  await grantMembership(db, { tenantId, userId: user.id, expectedRevision: 0 }, cmd());
  return { tenant: tenant!, user };
}

/** 以固定编号建全局账号（直接写平台用户表，createUser 不接受指定编号）。 */
async function insertFixedUser(db: Db, id: string, account: { email: string; displayName: string }) {
  await withPlatform(db, (tx) => tx.insert(users).values({ id, ...account }));
  return id;
}

export async function approvalWorld(db: Db, label: string, fixed: FixedIds = {}) {
  const { tenant, user: hr } = fixed.tenantId
    ? await seedFixedTenant(db, label, fixed.tenantId)
    : await seedTenantWithMember(db, label);
  let now = new Date(`${APV_TODAY}T01:00:00.000Z`);
  const clock = () => now;
  const api = tenantApi(db, { clock });
  const as = (user: string) => ({ user, tenant: tenant.id });
  const request = (user: string, method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, path, { ...options, ...as(user) });
  const json = async <T>(response: Response, status = 200): Promise<T> => {
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as T;
  };

  /** @param fixedId 可信夹具：以固定编号建账号 */
  async function member(name: string, fixedId?: string): Promise<string> {
    const suffix = randomBytes(3).toString('hex');
    const account = { email: `${label}-${suffix}@example.com`, displayName: name };
    const userId = fixedId ? await insertFixedUser(db, fixedId, account) : (await createUser(db, account, cmd())).id;
    await grantMembership(db, { tenantId: tenant.id, userId, expectedRevision: 0 }, cmd());
    return userId;
  }
  // 默认异常管理员是独立成员：发起人 HR 兼任时按 DEC-091 回避，没有直线经理即拒绝提交。
  const exceptionAdmin = await member('默认异常管理员', fixed.exceptionAdminId);

  async function org(name: string, parentId: string = tenant.id): Promise<string> {
    const created = await json<{ id: string }>(
      await request(hr.id, 'POST', '/api/tenant/org/organizations', {
        ifMatch: 0,
        body: { name, startDate: '2020-01-01', parents: { admin: { parentId } } },
      }),
      201,
    );
    return created.id;
  }

  /** 可信夹具：追加一条组织版本，写入负责人 / HRBP（人员 ID）。 */
  async function setOrgRoles(orgId: string, roles: { head?: string | null; hrbp?: string | null }) {
    await withTenant(db, tenant.id, async (tx) => {
      const [old] = await tx
        .select()
        .from(orgVersions)
        .where(eq(orgVersions.orgId, orgId))
        .orderBy(sql`version_no DESC`)
        .limit(1);
      const versionId = randomUUID();
      await tx.insert(orgVersions).values({
        ...old!,
        id: versionId,
        versionNo: old!.versionNo + 1,
        previousVersionId: old!.id,
        ...(roles.head !== undefined ? { personInChargeId: roles.head } : {}),
        ...(roles.hrbp !== undefined ? { hrbpId: roles.hrbp } : {}),
      });
      const links = await tx.select().from(orgHierarchyLinks).where(eq(orgHierarchyLinks.versionId, old!.id));
      if (links.length) await tx.insert(orgHierarchyLinks).values(links.map((link) => ({ ...link, versionId })));
    });
  }

  async function employee(name: string): Promise<{ id: string; revision: number }> {
    return json(
      await request(hr.id, 'POST', '/api/tenant/employment/employees', {
        ifMatch: 0,
        body: { name, code: `APV_${randomUUID().replaceAll('-', '')}` },
      }),
      201,
    );
  }

  async function hire(employeeId: string, fields: Record<string, unknown>) {
    const body = { kind: 'hire', mode: 'direct', effectiveDate: '2020-01-01', fields };
    return json<{ id: string; employeeRevision: number }>(
      await request(hr.id, 'POST', `/api/tenant/employment/employees/${employeeId}/businesses`, {
        ifMatch: 1,
        body: (await isBound(employeeId)) ? body : withLoginEmail(employeeId, body),
      }),
      201,
    );
  }

  /** 人员是否已绑定账号（已绑定的入职无需登录邮箱；未绑定的按 DEC-140 补合成邮箱）。 */
  async function isBound(employeeId: string): Promise<boolean> {
    const rows = await withTenant(db, tenant.id, (tx) =>
      tx.select().from(permissionUserPersonLinks).where(eq(permissionUserPersonLinks.employeeId, employeeId)),
    );
    return rows.length > 0;
  }

  /** 建员工 + 入职 + 账号绑定；返回账号与人员。 */
  async function person(name: string, departmentId: string, fields: Record<string, unknown> = {}): Promise<Person> {
    const userId = await member(name);
    const created = await employee(name);
    // 可信夹具：先绑定账号再入职（已绑定的人员入职无需再填登录邮箱，DEC-140），成员关系 revision 不变
    await withTenant(db, tenant.id, (tx) =>
      tx.insert(permissionUserPersonLinks).values({ tenantId: tenant.id, userId, employeeId: created.id }),
    );
    await hire(created.id, { departmentId, ...fields });
    return { userId, employeeId: created.id, name };
  }

  async function revisionOf(employeeId: string): Promise<number> {
    const value = await json<{ revision: number }>(
      await request(hr.id, 'GET', `/api/tenant/employment/employees/${employeeId}`),
    );
    return value.revision;
  }

  async function application(
    employeeId: string,
    fields: Record<string, unknown>,
    options: { kind?: string; effectiveDate?: string; actor?: string } = {},
  ) {
    return json<{ id: string; revision: number; status: string }>(
      await request(options.actor ?? hr.id, 'POST', `/api/tenant/employment/employees/${employeeId}/businesses`, {
        ifMatch: await revisionOf(employeeId),
        body: {
          kind: options.kind ?? 'transfer',
          mode: 'application',
          effectiveDate: options.effectiveDate ?? APV_TODAY,
          fields,
        },
      }),
      201,
    );
  }

  function submitRaw(business: { id: string; revision: number }, actor = hr.id) {
    return request(actor, 'POST', `/api/tenant/employment/businesses/${business.id}/submit`, {
      ifMatch: business.revision,
      body: {},
    });
  }

  async function submit(business: { id: string; revision: number }, actor = hr.id) {
    const submitted = await json<{ id: string; status: string; revision: number }>(await submitRaw(business, actor));
    expect(submitted.status).toBe('in_review');
    return instanceOf(business.id, actor);
  }

  async function instanceOf(businessId: string, actor = hr.id): Promise<InstanceView> {
    const list = await json<{ items: { id: string; businessId: string }[] }>(
      await request(actor, 'GET', `${BASE}/instances?role=initiated&businessId=${businessId}`),
    );
    expect(list.items).toHaveLength(1);
    return detail(list.items[0]!.id, actor);
  }

  /** 同一业务单的全部实例。 */
  async function instanceOfAll(businessId: string, actor = hr.id): Promise<InstanceView[]> {
    const list = await json<{ items: { id: string }[] }>(
      await request(actor, 'GET', `${BASE}/instances?role=initiated&businessId=${businessId}`),
    );
    return Promise.all(list.items.map((item) => detail(item.id, actor)));
  }

  async function detail(instanceId: string, actor = hr.id): Promise<InstanceView> {
    return json(await request(actor, 'GET', `${BASE}/instances/${instanceId}`));
  }

  async function createProcess(input: ProcessInput, actor = hr.id): Promise<ProcessView> {
    return json(
      await request(actor, 'POST', `${BASE}/processes`, {
        ifMatch: 0,
        body: {
          code: input.code ?? `P_${randomUUID().slice(0, 8)}`,
          name: input.name ?? '合成调动流程',
          approvalType: input.approvalType ?? 'transfer',
          priority: input.priority ?? 0,
          isFallback: input.isFallback ?? false,
          exceptionAdminUserId: input.exceptionAdminUserId === undefined ? exceptionAdmin : input.exceptionAdminUserId,
          ...(input.hideRecordsFromInitiator === undefined
            ? {}
            : { hideRecordsFromInitiator: input.hideRecordsFromInitiator }),
          conditions: input.conditions ?? {
            items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'TransferProcessNew' }],
          },
          nodes: input.nodes,
        },
      }),
      201,
    );
  }

  async function publish(process: ProcessView, actor = hr.id): Promise<ProcessView> {
    return json(await request(actor, 'POST', `${BASE}/processes/${process.id}/publish`, { ifMatch: process.revision }));
  }

  async function publishedProcess(input: ProcessInput): Promise<ProcessView> {
    return publish(await createProcess(input));
  }

  function taskAction(
    actor: string,
    task: string,
    action: 'approve' | 'reject' | 'disagree' | 'transfer' | 'add-sign' | 'edit',
    revision: number,
    body: Record<string, unknown> = {},
  ) {
    return request(actor, 'POST', `${BASE}/tasks/${task}/${action}`, { ifMatch: revision, body });
  }

  function instanceAction(
    actor: string,
    instance: string,
    action: 'urge' | 'withdraw' | 'resubmit' | 'admin-transfer' | 'admin-intervene',
    revision: number,
    body: Record<string, unknown> = {},
  ) {
    return request(actor, 'POST', `${BASE}/instances/${instance}/${action}`, { ifMatch: revision, body });
  }

  async function todos(actor: string) {
    return json<{ items: { taskId: string; instanceId: string; nodeKey: string; isExceptionAdmin: boolean }[] }>(
      await request(actor, 'GET', `${BASE}/todos`),
    );
  }

  /** 当前待办（按节点）。 */
  function pending(view: InstanceView): TaskView[] {
    return view.tasks.filter((task) => task.status === 'pending');
  }

  async function business(id: string) {
    return json<{ id: string; status: string; revision: number; record: unknown; fields: Record<string, unknown> }>(
      await request(hr.id, 'GET', `/api/tenant/employment/businesses/${id}`),
    );
  }

  return {
    db,
    tenant,
    hr,
    exceptionAdmin,
    api,
    clock,
    setNow(iso: string) {
      now = new Date(iso);
    },
    as,
    request,
    json,
    member,
    org,
    setOrgRoles,
    employee,
    hire,
    person,
    application,
    submitRaw,
    submit,
    instanceOf,
    instanceOfAll,
    detail,
    createProcess,
    publish,
    publishedProcess,
    taskAction,
    instanceAction,
    todos,
    pending,
    business,
  };
}

export type ApprovalWorld = Awaited<ReturnType<typeof approvalWorld>>;

/** 本租户调动流程节点结构（`14` §2）：调出负责人 → 调入 HRBP → 调入负责人 → 一级组织负责人。 */
export const TRANSFER_NODES: readonly NodeInput[] = [
  { key: 'out_head', name: '调出部门负责人审批', approver: 'latest_record_department_head' },
  { key: 'in_hrbp', name: '调入部门HRBP审核', approver: 'record_department_hrbp' },
  { key: 'in_head', name: '调入部门负责人审批', approver: 'record_department_head' },
  { key: 'first_level', name: '单人审批', approver: 'record_first_level_org_head' },
];

/**
 * 调动场景：调出部门 X（负责人 outHead）→ 调入部门 Y（负责人 inHead，HRBP inHrbp），均为一级组织；
 * 员工 E 在 X 任职，直线经理为 manager。
 */
export async function transferScene(w: ApprovalWorld) {
  const from = await w.org('调出部门');
  const to = await w.org('调入部门');
  const outHead = await w.person('调出负责人', from);
  const inHead = await w.person('调入负责人', to);
  const inHrbp = await w.person('调入HRBP', to);
  const manager = await w.person('直线经理', from);
  const subject = await w.person('调动员工', from, { directManagerId: manager.employeeId });
  await w.setOrgRoles(from, { head: outHead.employeeId });
  await w.setOrgRoles(to, { head: inHead.employeeId, hrbp: inHrbp.employeeId });
  return { from, to, outHead, inHead, inHrbp, manager, subject };
}

/** 把审批世界的 HR 开通为租户管理员，供真实授权器场景配置身份与字段权限。 */
export async function permissionAdmin(w: ApprovalWorld): Promise<PermissionWorld> {
  const adminRecord = await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.hr.id }, cmd());
  return {
    db: w.db,
    tenant: w.tenant,
    admin: w.hr,
    adminRecord,
    api: tenantApi(w.db, { authorize: undefined, clock: w.clock }),
    asAdmin: w.as(w.hr.id),
  };
}

/** 给用户授予指定可见 / 可编辑字段（可编辑须同时可见）及编辑数据操作的身份（PR #35 第二轮清单 2）。 */
export async function grantFieldAccess(
  world: PermissionWorld,
  userId: string,
  access: { readonly view: readonly string[]; readonly edit?: readonly string[] },
  definition: ObjectDefinition = MODULE_OBJECTS.employmentRecord,
) {
  const edit = access.edit ?? [];
  const profile = await createProfile(world, `apv${randomUUID().slice(0, 8)}`);
  const response = await setObjectPermission(
    world,
    profile,
    {
      dataOperations: { create: false, update: edit.length > 0, delete: false },
      fields: definition.fields.map((f) => ({
        fieldCode: f.code,
        view: access.view.includes(f.code) || edit.includes(f.code),
        edit: edit.includes(f.code),
      })),
      buttons: [],
    },
    definition.code,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  await makeGrantable(world, [profile.id]);
  const granted = await grant(world, userId, profile.id);
  expect(granted.status, await granted.clone().text()).toBe(201);
  return profile;
}

/** 给用户授予一个只含指定可见字段的身份（无数据范围：DEC-057 审批不授予范围）。 */
export async function grantVisibleFields(
  world: PermissionWorld,
  userId: string,
  visible: readonly string[],
  definition: ObjectDefinition = MODULE_OBJECTS.employmentRecord,
) {
  const profile = await createProfile(world, `apv${randomUUID().slice(0, 8)}`);
  const response = await setObjectPermission(
    world,
    profile,
    {
      dataOperations: { create: false, update: false, delete: false },
      fields: definition.fields.map((f) => ({ fieldCode: f.code, view: visible.includes(f.code), edit: false })),
      buttons: [],
    },
    definition.code,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  await makeGrantable(world, [profile.id]);
  const granted = await grant(world, userId, profile.id);
  expect(granted.status, await granted.clone().text()).toBe(201);
  return profile;
}

/**
 * 其他模块的验收夹具：R1-T07 起提交任职申请 / 自助变更申请必须匹配到已发布流程（DEC-017）。
 * 为每个审批类型安装一条已发布的兜底流程（DEC-018 显式兜底），首节点为“流程所有者”——发起人自审跳过后
 * 落到异常管理员（DEC-068），保证提交成功且不改变被测模块自身的语义。
 */
export async function installApprovalFallbacks(db: Db, tenantId: string, userId: string): Promise<void> {
  const ctx = { tenantId, userId, timezone: 'Asia/Shanghai', now: new Date(), expectedRevision: 0 };
  // 异常管理员用独立成员：被测模块的操作人兼任时按 DEC-091 回避，没有直线经理会拒绝提交。
  const suffix = randomBytes(3).toString('hex');
  const admin = await createUser(db, { email: `fallback-${suffix}@example.com`, displayName: '夹具异常管理员' }, cmd());
  await grantMembership(db, { tenantId, userId: admin.id, expectedRevision: 0 }, cmd());
  await withTenant(db, tenantId, async (tx) => {
    for (const approvalType of Object.keys(APPROVAL_TYPES) as ApprovalTypeCode[]) {
      const created = await createProcess(
        tx,
        { ...ctx, commandId: randomUUID() },
        { code: `FIXTURE_${approvalType}`, approvalType },
        {
          name: `夹具兜底流程-${approvalType}`,
          groupName: null,
          description: null,
          priority: 0,
          isFallback: true,
          exceptionAdminUserId: admin.id,
          urgeEnabled: true,
          hideRecordsFromInitiator: false,
          conditions: { items: [], expression: '' },
          nodes: [
            {
              key: 'owner',
              name: '夹具节点',
              approver: 'owner',
              noAssignee: 'exception_admin',
              sameAssigneeSkip: false,
              historySameAssigneeSkip: false,
              sameAssigneeResult: 'approve',
              historySameAssigneeResult: 'approve',
              formFields: [],
              editableFields: [],
              editMode: 'none',
              actions: { transfer: false, addSign: false, copySend: false, retrieve: false, urge: 'inherit' },
              rejectCommentRequired: false,
              hideRecords: false,
              rejectResubmit: 'restart',
              messageRules: [],
            },
          ],
        },
      );
      await publishProcess(tx, { ...ctx, commandId: randomUUID(), expectedRevision: created.revision }, created.id);
    }
  });
}
