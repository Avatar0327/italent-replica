/**
 * R2 BE-8b2 验收夹具：离职交接执行（B64，DM-R11 / DM-R13 / DM-R14，DEC-632）。
 * 在 blacklistExitWorld 之上加：交接事项设置、员工 / 工作交接人 / 部门 HRBP / 人事管理员四类账号、四节点预置流程的发布、
 * 审批通过 / 办理 / 自动保存的公开入口，以及交接申请与事项的只读核对。一律经公开接口造数，读业务表只用于核对内部列。
 */
import { randomUUID } from 'node:crypto';
import { eq, orgHierarchyLinks, orgVersions, sql, withTenant, type Db } from '@italent/db';
import { PRESET_PROCESSES } from '@italent/domain';
import { expect } from 'vitest';
import { createProcess, publishProcess } from '../../apps/api/src/modules/approval/definitions.js';
import { blacklistExitWorld, FUTURE_LAST_WORK_DATE, TODAY } from './AC-EXIT-blacklist-support.js';

export { FUTURE_EFFECTIVE_DATE, FUTURE_LAST_WORK_DATE, TODAY } from './AC-EXIT-blacklist-support.js';

const EMPLOYMENT = '/api/tenant/employment';
const APPROVAL = '/api/tenant/approval';
export const HANDOVER_TRIGGER_KEY = 'exit.handover_trigger';

export const SETTING_ITEMS = [
  { category: '行政', sequenceNo: 1, todoType: 'work_handover', title: '工作文档交接' },
  { category: 'IT', sequenceNo: 2, todoType: 'other', title: '归还办公电脑' },
  { category: '财务', sequenceNo: 3, todoType: 'other', title: '清理借款' },
] as const;

export interface HandoverItemView {
  readonly id: string;
  readonly category: string;
  readonly sequenceNo: number;
  readonly todoType: string;
  readonly title: string;
  readonly done: boolean;
  readonly handoverPerson: string | null;
  readonly responsibleNodeKey: string;
  readonly editable: boolean;
  readonly revision: number;
}

export interface HandoverDetail {
  readonly id: string;
  readonly status: string;
  readonly items: readonly HandoverItemView[];
  readonly mine: { readonly nodeKey: string; readonly total: number; readonly done: number; readonly allDone: boolean } | null;
}

export async function handoverWorld(db: Db, label: string) {
  const x = await blacklistExitWorld(db, label);
  const tenantId = x.tenantId;
  const tenantAs = (userId: string) => ({ tenant: tenantId, user: userId });

  /** 员工（合成）+ 登录账号（申请人账号）。 */
  async function person(name: string, employeeId?: string) {
    const employee = employeeId ? { id: employeeId } : await x.colleague(name);
    return { employeeId: employee.id, userId: await x.applicantAccount(employee.id) };
  }

  const leaverUserId = await x.applicantAccount(x.employee.id);
  const workOwner = await person('工作交接人');
  const hrbp = await person('部门HRBP');
  await setHrbp(db, tenantId, x.from.id, hrbp.employeeId);
  const hrAdmin = await x.otherUser();
  await grantHrAdminProfile(db, tenantId, hrAdmin.id);
  const processAdmin = await x.otherUser();
  const exceptionAdmin = await x.otherUser();

  async function addSettingItems(items: readonly Record<string, unknown>[] = SETTING_ITEMS) {
    for (const item of items) {
      const response = await x.session.request('POST', '/exit-handover-items', { ifMatch: 0, body: item });
      expect(response.status, await response.clone().text()).toBe(201);
    }
  }

  /** 发布四节点交接流程（取预置定义，代码在测试里排在夹具兜底之前）。 */
  async function publishHandoverProcess() {
    const preset = PRESET_PROCESSES.find((candidate) => String(candidate.approvalType) === 'exit_handover');
    expect(preset, '缺少 exit_handover 预置流程').toBeTruthy();
    const ctx = { tenantId, userId: processAdmin.id, timezone: 'Asia/Shanghai', now: new Date(), expectedRevision: 0 };
    await withTenant(db, tenantId, async (tx) => {
      const created = await createProcess(
        tx,
        { ...ctx, commandId: randomUUID() },
        { code: 'AAA_EXIT_HANDOVER', approvalType: 'exit_handover' as never },
        { ...preset!.definition, exceptionAdminUserId: exceptionAdmin.id },
      );
      await publishProcess(tx, { ...ctx, commandId: randomUUID(), expectedRevision: created.revision }, created.id);
    });
  }

  /** 改租户的交接发起规则（两层配置，租户覆盖）。 */
  async function setTrigger(patch: { enabled?: boolean; includePastLastWorkDate?: boolean }) {
    const path = `/api/tenant/settings/${HANDOVER_TRIGGER_KEY}`;
    const current = await x.api.request('GET', path, tenantAs(x.session.user.id));
    const loaded = (await current.json()) as { revision: number; value: Record<string, unknown> };
    const response = await x.api.request('PUT', path, {
      ...tenantAs(x.session.user.id),
      ifMatch: loaded.revision,
      body: { value: { ...loaded.value, ...patch } },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  /** 离职申请：创建 → 提交 → 在 at 审批通过（可信端口，confirmed 阶段触发交接订阅方）。 */
  async function approvedApplication(
    employeeId: string,
    options: { lastWorkDate?: string; exit?: object; at?: string } = {},
  ) {
    const draft = await x.createdExit(employeeId, options.lastWorkDate ?? FUTURE_LAST_WORK_DATE, 'application', {
      exitTypeCode: 'voluntary',
      ...options.exit,
    });
    const sent = await x.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    const approved = await x.approve(draft, options.at ?? `${TODAY}T02:00:00Z`);
    return { draft, approved };
  }

  const requestRows = (exitId: string) =>
    x.sqlRows<{
      id: string;
      state: string;
      endReason: string | null;
      employeeId: string;
      initiatorUserId: string;
      instanceId: string | null;
    }>(sql`SELECT id, state, end_reason AS "endReason", employee_id AS "employeeId",
        initiator_user_id AS "initiatorUserId", approval_instance_id AS "instanceId"
      FROM exit_handover_requests WHERE tenant_id=${tenantId} AND exit_request_id=${exitId}::uuid ORDER BY created_at`);
  const itemRows = (requestId: string) =>
    x.sqlRows<{ title: string; todoType: string; done: boolean; handoverPerson: string | null }>(sql`
      SELECT title, todo_type AS "todoType", done, handover_person AS "handoverPerson"
      FROM exit_handover_request_items WHERE tenant_id=${tenantId} AND request_id=${requestId}::uuid
      ORDER BY sequence_no, id`);

  /** 当前待办（审批中心）：节点、办理人、任务与实例 revision。 */
  async function pendingNode(instanceId: string) {
    const [task] = await x.sqlRows<{ taskId: string; userId: string; nodeKey: string; revision: number }>(sql`
      SELECT t.id AS "taskId", t.assignee_user_id AS "userId", t.node_key AS "nodeKey", i.revision
      FROM approval_tasks t JOIN approval_instances i ON i.tenant_id=t.tenant_id AND i.id=t.instance_id
      WHERE t.tenant_id=${tenantId} AND t.instance_id=${instanceId}::uuid AND t.status='pending'`);
    return task;
  }
  const instanceStatus = async (instanceId: string) =>
    (
      await x.sqlRows<{ status: string }>(
        sql`SELECT status FROM approval_instances WHERE tenant_id=${tenantId} AND id=${instanceId}::uuid`,
      )
    )[0]?.status;

  /** 审批中心办理当前待办（同意 / 不同意），返回 HTTP 响应。 */
  async function decide(instanceId: string, action: 'approve' | 'disagree' | 'reject' | 'jump' = 'approve') {
    const task = (await pendingNode(instanceId))!;
    return x.api.request('POST', `${APPROVAL}/tasks/${task.taskId}/${action}`, {
      ...tenantAs(task.userId),
      ifMatch: task.revision,
      body: {},
    });
  }
  async function approveAll(instanceId: string) {
    for (let step = 0; step < 4; step++) {
      const response = await decide(instanceId);
      expect(response.status, await response.clone().text()).toBe(200);
    }
  }

  async function detailAs(userId: string, requestId: string) {
    const response = await x.api.request('GET', `${EMPLOYMENT}/exit-handover-requests/${requestId}`, tenantAs(userId));
    return { status: response.status, body: (await response.json()) as HandoverDetail };
  }
  /** HR 视角：离职详情上的交接状态。 */
  async function statusOf(exitId: string) {
    const response = await x.session.request('GET', `/exits/${exitId}/handover`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { status: string; request: { id: string; items: HandoverItemView[] } | null };
  }
  /** 勾选 / 取消勾选一项（自动保存）。 */
  async function tick(userId: string, requestId: string, item: { id: string; revision: number }, done: boolean) {
    return x.api.request('PUT', `${EMPLOYMENT}/exit-handover-requests/${requestId}/items/${item.id}`, {
      ...tenantAs(userId),
      ifMatch: item.revision,
      body: { done },
    });
  }

  /** 一次走到“已发起”：开事项、发流程、申请审批通过；返回请求与实例。 */
  async function launched(employeeId = x.employee.id, exit: object = { handoverEmployeeId: workOwner.employeeId }) {
    const { approved } = await approvedApplication(employeeId, { exit });
    const [request] = await requestRows(approved.id);
    return { exitId: approved.id, request: request!, instanceId: request!.instanceId! };
  }

  return {
    ...x,
    tenantAs,
    leaverUserId,
    workOwner,
    hrbp,
    hrAdmin,
    exceptionAdmin,
    person,
    addSettingItems,
    publishHandoverProcess,
    setTrigger,
    approvedApplication,
    requestRows,
    itemRows,
    pendingNode,
    instanceStatus,
    decide,
    approveAll,
    detailAs,
    statusOf,
    tick,
    launched,
  };
}

export type HandoverWorld = Awaited<ReturnType<typeof handoverWorld>>;

/** 可信夹具：追加组织版本写 HRBP（人员 ID），同 AC-APV-support.setOrgRoles。 */
async function setHrbp(db: Db, tenantId: string, orgId: string, hrbpEmployeeId: string) {
  await withTenant(db, tenantId, async (tx) => {
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
      hrbpId: hrbpEmployeeId,
    });
    const links = await tx.select().from(orgHierarchyLinks).where(eq(orgHierarchyLinks.versionId, old!.id));
    if (links.length) await tx.insert(orgHierarchyLinks).values(links.map((link) => ({ ...link, versionId })));
  });
}

/** 人事管理员角色 = 标准身份 standard_hr_admin 的有效授权（DEC-043 身份）；夹具直接落身份与授权行。 */
async function grantHrAdminProfile(db: Db, tenantId: string, userId: string) {
  await withTenant(db, tenantId, async (tx) => {
    const profileId = randomUUID();
    await tx.execute(sql`INSERT INTO permission_profiles(id, tenant_id, code, name, source)
      VALUES (${profileId}::uuid, ${tenantId}, 'standard_hr_admin', '人事管理员（组织员工）', 'standard')
      ON CONFLICT (tenant_id, code) DO NOTHING`);
    await tx.execute(sql`INSERT INTO permission_grants(tenant_id, user_id, profile_id, source, status)
      SELECT ${tenantId}, ${userId}::uuid, id, 'manual', 'active' FROM permission_profiles
      WHERE tenant_id=${tenantId} AND code='standard_hr_admin'`);
  });
}
