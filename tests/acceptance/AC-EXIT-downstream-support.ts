/**
 * R2-T03 B3-2 验收夹具：离职生效下游（步骤 1 作废在途申请 / 步骤 4 合同端口 / 步骤 6 职责转交），
 * 只经内部编排器入口（activateExit、confirmExit）验证；§18.1 五个关口保持关闭。
 * 在 exitActivationWorld 之上加：各状态的调动申请、审批拒绝、合同主数据与合同命令、下属 / 转交计划与读取。
 */
import { randomUUID } from 'node:crypto';
import { permissionUserPersonLinks, sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { findCurrentRecord } from '../../apps/api/src/modules/employment/read-model.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { confirmExit } from '../../apps/api/src/modules/employment/exit-confirmation.js';
import { appendLinkageVersion } from '../../apps/api/src/modules/transfer/linkage/store.js';
import type { LinkageOptions } from '../../apps/api/src/modules/transfer/linkage/input.js';
import { dayAt, exitActivationWorld } from './AC-EXIT-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

export type ApplicationState = 'draft' | 'in_review' | 'rejected' | 'approved';

export async function downstreamWorld(db: Db, label: string, today = '2026-10-06') {
  const x = await exitActivationWorld(db, label, today);
  const tenantId = x.session.tenant.id;
  const user = x.session.user.id;
  const api = tenantApi(db, { clock: () => dayAt(today) });
  const rows = <T>(statement: ReturnType<typeof sql>) => x.sqlRows<T>(statement);

  /** 指定状态的调动申请（草稿无审批实例；审批中 / 已驳回 / 已批准有实例）。 */
  async function transferIn(state: ApplicationState, effectiveDate: string, employeeId = x.employee.id) {
    const fields = { departmentId: x.to.id };
    if (state === 'draft') {
      const employee = await x.session.getEmployee(employeeId);
      return x.session.business(
        employeeId,
        { kind: 'transfer', mode: 'application', effectiveDate, fields },
        employee.revision,
      );
    }
    const submitted = await x.apply(employeeId, effectiveDate, fields);
    if (state === 'approved') return x.approve(submitted, dayAt(today).toISOString());
    if (state === 'rejected') await rejectInReview(submitted.id);
    return submitted;
  }

  /** 审批人（夹具异常管理员）在审批中心驳回，业务回到 rejected、实例 returned。 */
  const rejectInReview = (businessId: string) => decideInReview(businessId, 'reject');

  /** 经审批中心真实接口办结审批：同意后实例 approved（已完成，不再有活动实例）。 */
  const approveInReview = (businessId: string) => decideInReview(businessId, 'approve');

  async function decideInReview(businessId: string, action: 'approve' | 'reject') {
    const [task] = await rows<{ id: string; userId: string; revision: number }>(sql`
      SELECT t.id, t.assignee_user_id AS "userId", i.revision FROM approval_tasks t
      JOIN approval_instances i ON i.tenant_id=t.tenant_id AND i.id=t.instance_id
      WHERE t.tenant_id=${tenantId} AND i.business_id=${businessId}::uuid AND t.status='pending'`);
    const response = await api.request('POST', `/api/tenant/approval/tasks/${task!.id}/${action}`, {
      tenant: tenantId,
      user: task!.userId,
      ifMatch: task!.revision,
      body: {},
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  const instanceOf = async (businessId: string) =>
    (
      await rows<{ id: string; status: string; initiator: string; revision: number }>(sql`
        SELECT id, status, initiator_user_id AS initiator, revision FROM approval_instances
        WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid ORDER BY created_at DESC LIMIT 1`)
    )[0];
  const pendingTasks = (instanceId: string) =>
    rows<{ id: string; userId: string }>(sql`SELECT id, assignee_user_id AS "userId" FROM approval_tasks
      WHERE tenant_id=${tenantId} AND instance_id=${instanceId}::uuid AND status='pending'`);
  const notices = (instanceId: string) =>
    rows<{ recipient: string; template: string; kind: string }>(sql`
      SELECT recipient_user_id AS recipient, template_code AS template, kind FROM approval_notifications
      WHERE tenant_id=${tenantId} AND instance_id=${instanceId}::uuid AND kind='message' ORDER BY recipient_user_id`);
  const outboxCount = async (businessId: string, eventType: string) =>
    Number(
      (
        await rows<{ n: number }>(sql`SELECT count(*) AS n FROM employment_outbox WHERE tenant_id=${tenantId}
          AND business_id=${businessId}::uuid AND event_type=${eventType}`)
      )[0]!.n,
    );
  /** 员工的登录账号（申请人账号）：已有绑定直接返回，否则新建一个并绑定。 */
  async function applicantAccount(employeeId: string) {
    const [existing] = await rows<{ userId: string }>(sql`SELECT user_id AS "userId" FROM permission_user_person_links
      WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid`);
    if (existing) return existing.userId;
    const account = await x.otherUser();
    await withTenant(db, tenantId, (tx) =>
      tx.insert(permissionUserPersonLinks).values({ tenantId, userId: account.id, employeeId }),
    );
    return account.id;
  }

  /** 批量造 count 条该员工名下的合成草稿申请（复制首个载荷版本的必填列；一条语句，避免逐条往返）。 */
  const bulkDrafts = (count: number, employeeId = x.employee.id) =>
    rows(sql`
      WITH ids AS (
        SELECT gen_random_uuid() AS bid, gen_random_uuid() AS vid FROM generate_series(1, ${count}::int)
      ), base AS (
        SELECT tenant_id, employee_id, form_id, employ_type FROM employment_payload_versions
        WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid ORDER BY created_at, version_no LIMIT 1
      ), objects AS (
        INSERT INTO employment_business_objects(id,tenant_id,employee_id)
        SELECT bid, ${tenantId}, ${employeeId}::uuid FROM ids RETURNING id
      ), versions AS (
        INSERT INTO employment_payload_versions(id,tenant_id,employee_id,business_id,version_no,command_id,kind,mode,
          effective_date,form_id,employ_type,created_at)
        SELECT vid, base.tenant_id, base.employee_id, bid, 1, NULL, 'regularization', 'application',
          '2026-12-01'::date, base.form_id, base.employ_type, '2026-10-01T01:00:00Z'::timestamptz FROM ids, base
        RETURNING id
      )
      INSERT INTO employment_state_events(tenant_id,employee_id,business_id,payload_version_id,state,event_no,command_id)
      SELECT ${tenantId}, ${employeeId}::uuid, bid, vid, 'draft', 1, 'bulk-draft' FROM ids`);
  const stateCounts = () =>
    rows<{ state: string; n: number }>(sql`
      SELECT s.state, count(*) AS n FROM employment_business_objects b
      JOIN LATERAL (SELECT state FROM employment_state_events e WHERE e.tenant_id=b.tenant_id AND e.business_id=b.id
        ORDER BY event_no DESC LIMIT 1) s ON true
      WHERE b.tenant_id=${tenantId} AND b.employee_id=${x.employee.id}::uuid GROUP BY s.state ORDER BY s.state`);

  // ---- 职责转交 ----
  /** 在调出部门入职的下属，直线经理 = managerId。 */
  async function subordinateOf(managerId: string, name: string) {
    const employee = await x.session.employee(name);
    await x.session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId: x.from.id, directManagerId: managerId },
      },
      employee.revision,
    );
    return employee;
  }
  async function peer(name: string) {
    const employee = await x.session.employee(name);
    await x.session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: x.from.id } },
      employee.revision,
    );
    return employee;
  }
  /** 员工在 at 日的现行直线经理（读任职读模型，记录编辑不一定改 employment_records 原行）。 */
  const managerOf = (employeeId: string, at = today) =>
    withTenant(
      db,
      tenantId,
      async (tx) => (await findCurrentRecord(tx, tenantId, employeeId, at))?.fields.directManagerId ?? null,
    );
  /** 离职的职责转交计划（B3-3 前请求体不能带转交区块，造数直接写联动版本）。 */
  const planDuties = (leaveId: string, subordinates: { employeeId: string; receiverId: string }[]) =>
    withTenant(db, tenantId, (tx) =>
      appendLinkageVersion(
        tx,
        {
          tenantId,
          userId: user,
          timezone: x.session.tenant.timezone,
          now: dayAt(today),
          commandId: randomUUID(),
          expectedRevision: 0,
        },
        { businessId: leaveId, employeeId: x.employee.id },
        {
          contract: null,
          adjustSalary: false,
          onTrial: null,
          handover: null,
          partTimes: [],
          dutyTransfer: {
            subordinates: subordinates.map((s) => ({ ...s, relation: 'direct' as const })),
            orgRoles: [],
          },
        } satisfies LinkageOptions,
      ),
    );
  /** 租户配置项 exit.duty_transfer_timing（§2.2）；须在创建离职前设置，离职单创建时固化。 */
  async function useTiming(value: 'business_effective' | 'approval_passed') {
    const response = await api.request('PUT', '/api/tenant/settings/exit.duty_transfer_timing', {
      tenant: tenantId,
      user,
      ifMatch: 0,
      body: { value },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  /** 内部 confirmed 入口（B3-3 前公开入口不带转交区块，approval_passed 时机只能经它验证）。 */
  const confirm = (leaveId: string, at: string, mode: 'application' | 'direct' = 'direct') =>
    withTenant(db, tenantId, (tx) =>
      confirmExit(
        tx,
        {
          tenantId,
          userId: user,
          timezone: x.session.tenant.timezone,
          now: dayAt(at),
          commandId: randomUUID(),
          expectedRevision: 0,
        },
        { id: leaveId, employeeId: x.employee.id, effectiveDate: '2026-10-06', mode },
      ),
    );
  const items = (leaveId: string) =>
    rows<{
      status: string;
      subordinate: string;
      receiver: string;
      effective: string;
      failure: string | null;
      rule: string | null;
    }>(sql`
      SELECT status, subordinate_id::text AS subordinate, receiver_id::text AS receiver,
        effective_date::text AS effective, failure_code AS failure, failure_rule AS rule
      FROM transfer_linkage_items WHERE tenant_id=${tenantId} AND business_id=${leaveId}::uuid ORDER BY line_no`);

  // ---- 合同 ----
  const contracts = (method: string, path: string, init: Parameters<typeof api.request>[2] = {}) =>
    api.request(method, `/api/tenant/contracts${path}`, { user, tenant: tenantId, ...init });
  async function master(kind: 'types' | 'companies', name: string) {
    const response = await contracts('POST', `/master-data/${kind}`, {
      ifMatch: 0,
      body: { code: randomUUID(), name },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  }
  const company = await master('companies', '合成法人公司');
  async function contractType(name: string) {
    return (await master('types', name)).id;
  }
  const contractFields = (typeId: string, extra: Record<string, unknown> = {}) => ({
    typeId,
    companyId: company.id,
    effectiveDate: '2026-01-01',
    endDate: '2027-12-31',
    termType: 'fixed',
    termMonths: 24,
    signingDate: '2025-12-20',
    ...extra,
  });
  async function createContract(typeId: string, extra: Record<string, unknown> = {}, mode = 'direct') {
    const response = await contracts('POST', '/commands', {
      ifMatch: 0,
      body: { operation: 'create', mode, employeeId: x.employee.id, fields: contractFields(typeId, extra) },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; revision: number; status: string; number: string };
  }
  const contractRows = () =>
    rows<{ id: string; status: string; deleted: boolean; actual: string | null; reason: string | null }>(sql`
      SELECT id, status, deleted, actual_termination_date::text AS actual, termination_reason AS reason
      FROM contract_records WHERE tenant_id=${tenantId} AND employee_id=${x.employee.id}::uuid ORDER BY id`);
  const requestRows = () =>
    rows<{ id: string; status: string }>(sql`SELECT id, status FROM contract_requests
      WHERE tenant_id=${tenantId} AND employee_id=${x.employee.id}::uuid ORDER BY id`);

  return {
    ...x,
    today,
    api,
    transferIn,
    rejectInReview,
    approveInReview,
    instanceOf,
    pendingTasks,
    notices,
    outboxCount,
    applicantAccount,
    subordinateOf,
    peer,
    managerOf,
    planDuties,
    useTiming,
    confirm,
    items,
    contracts,
    contractType,
    createContract,
    contractRows,
    requestRows,
    bulkDrafts,
    stateCounts,
    ids: (list: readonly { id: string }[]) => list.map((row) => row.id),
    rowsOf,
  };
}

export type DownstreamWorld = Awaited<ReturnType<typeof downstreamWorld>>;
