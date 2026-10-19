/**
 * R2-T04 BE-5d2 验收夹具：意向退休日期申请（docs/08_设计/R2-T04_退休设计.md §11，AC-RT-20 / 20b / 20c）。
 * 在审批中心夹具（approvalWorld）上建部门 A / B、直接上级与意向员工，以可信方式安装并发布意向申请的预置流程
 * （与开通时 provisioning 同一路径）；申请走真实接口，审批走真实审批中心接口。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { PRESET_PROCESSES } from '@italent/domain';
import { expect } from 'vitest';
import { installPresets, publishProcess, replaceDraft } from '../../apps/api/src/modules/approval/definitions.js';
import { appendEmployee } from '../../apps/api/src/modules/personnel/employee-write.js';
import { approvalWorld, type InstanceView, type Person } from './AC-APV-support.js';

export const EMPLOYMENT = '/api/tenant/employment';
export const INTENTIONS = `${EMPLOYMENT}/retirement-intentions`;
export const TODAY = '2026-10-01';

export interface IntentionView {
  readonly id: string;
  readonly employeeId: string;
  readonly status: string;
  readonly intendedDate: string;
  readonly reason: string | null;
  readonly expectedDateSnapshot: string | null;
  readonly earliestSnapshot: string | null;
  readonly latestSnapshot: string | null;
  readonly revision: number;
}

async function publishPresets(db: Db, tenantId: string, userId: string, exceptionAdmin: string) {
  await withTenant(db, tenantId, async (tx) => {
    const ctx = { tenantId, userId, timezone: 'Asia/Shanghai', now: new Date(), commandId: randomUUID() };
    for (const installed of await installPresets(tx, { ...ctx, expectedRevision: 0 })) {
      if (installed.approvalType !== 'retirement_intention') continue;
      const preset = PRESET_PROCESSES.find((p) => p.presetKey === installed.presetKey)!;
      const definition = { ...preset.definition, exceptionAdminUserId: exceptionAdmin };
      const draft = await replaceDraft(tx, { ...ctx, expectedRevision: installed.revision }, installed.id, definition);
      await publishProcess(tx, { ...ctx, expectedRevision: draft.revision }, installed.id);
    }
  });
}

export async function intentionWorld(db: Db, label: string) {
  const w = await approvalWorld(db, `rt20-${label}`);
  await publishPresets(db, w.tenant.id, w.hr.id, w.exceptionAdmin);
  const deptA = await w.org('部门A');
  const deptB = await w.org('部门B');
  const manager = await w.person('直接上级', deptB);
  const subject = await w.person('意向员工', deptB, { directManagerId: manager.employeeId });
  const rows = <T>(statement: ReturnType<typeof sql>) =>
    withTenant(db, w.tenant.id, async (tx) => {
      const result = await tx.execute(statement);
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
    });

  /** 写入人事的预计退休日期与弹性上下限（走人事写端口，与人事 PATCH 同一版本链）。 */
  async function setRetirement(
    facts: { expected: string | null; earliest?: string | null; latest?: string | null },
    employeeId = subject.employeeId,
  ) {
    await withTenant(db, w.tenant.id, (tx) =>
      appendEmployee(
        tx,
        {
          tenantId: w.tenant.id,
          userId: w.hr.id,
          timezone: 'Asia/Shanghai',
          now: w.clock(),
          commandId: randomUUID(),
          expectedRevision: 0,
        } as never,
        employeeId,
        {
          expectedRetirementDate: facts.expected,
          earliestRetirementDate: facts.earliest ?? null,
          latestRetirementDate: facts.latest ?? null,
        },
        false,
      ),
    );
  }
  /** 人事版本链现状：版本数 + 最新版本的退休相关列（A-6：通过前后必须相等）。 */
  const personnelState = async (employeeId = subject.employeeId) =>
    (
      await rows<Record<string, unknown>>(sql`SELECT count(*)::int AS versions, max(revision) AS revision,
        (array_agg(expected_retirement_date::text ORDER BY revision DESC))[1] AS expected,
        (array_agg(earliest_retirement_date::text ORDER BY revision DESC))[1] AS earliest,
        (array_agg(latest_retirement_date::text ORDER BY revision DESC))[1] AS latest,
        (array_agg(original_expected_retirement_date::text ORDER BY revision DESC))[1] AS original
        FROM personnel_employee_versions WHERE tenant_id=${w.tenant.id} AND employee_id=${employeeId}::uuid`)
    )[0]!;

  async function revisionOf(employeeId = subject.employeeId) {
    const employee = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `${EMPLOYMENT}/employees/${employeeId}`),
    );
    return employee.revision;
  }

  async function createRaw(
    body: Record<string, unknown>,
    options: { employeeId?: string; actor?: string; key?: string } = {},
  ) {
    const employeeId = options.employeeId ?? subject.employeeId;
    return w.request(options.actor ?? w.hr.id, 'POST', `${INTENTIONS}/employees/${employeeId}`, {
      ifMatch: await revisionOf(employeeId),
      body,
      ...(options.key ? { idempotencyKey: options.key } : {}),
    });
  }
  async function create(body: Record<string, unknown>, options: { employeeId?: string; actor?: string } = {}) {
    const response = await createRaw(body, options);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as IntentionView;
  }
  const get = async (id: string, actor = w.hr.id) =>
    w.json<IntentionView>(await w.request(actor, 'GET', `${INTENTIONS}/${id}`));
  const list = async (query = '', actor = w.hr.id) =>
    w.json<{ items: IntentionView[]; total: number }>(await w.request(actor, 'GET', `${INTENTIONS}${query}`));
  const patchRaw = (id: string, ifMatch: number, body: Record<string, unknown>, actor = w.hr.id) =>
    w.request(actor, 'PATCH', `${INTENTIONS}/${id}`, { ifMatch, body });
  const actionRaw = (id: string, action: 'submit' | 'withdraw', ifMatch: number, actor = w.hr.id) =>
    w.request(actor, 'POST', `${INTENTIONS}/${id}/${action}`, { ifMatch });
  async function act(id: string, action: 'submit' | 'withdraw', actor = w.hr.id) {
    const current = await get(id, actor);
    const response = await actionRaw(id, action, current.revision, actor);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as IntentionView;
  }

  const instance = (intentionId: string, actor = w.hr.id): Promise<InstanceView> => w.instanceOf(intentionId, actor);
  /** 审批人（默认直接上级）办理当前待办。 */
  async function decide(
    intentionId: string,
    action: 'approve' | 'disagree' | 'reject',
    actor: Person = manager,
    initiator = w.hr.id,
  ) {
    const view = await instance(intentionId, initiator);
    const task = w.pending(view).find((t) => t.assigneeUserId === actor.userId);
    expect(task, `${actor.name} 没有待办`).toBeDefined();
    const response = await w.taskAction(actor.userId, task!.id, action, view.revision, { comment: '合成意见' });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  /** 该意向申请相关的审计 / 命令台账 / 审批实例行，供“被拒后前后逐项相等”的断言。 */
  async function footprint(intentionId: string) {
    return {
      row: (
        await rows<Record<string, unknown>>(sql`SELECT state, revision, intended_date::text AS intended_date, reason,
          approval_instance_id::text AS approval_instance_id FROM retirement_intentions
          WHERE tenant_id=${w.tenant.id} AND id=${intentionId}::uuid`)
      )[0],
      instances: await rows<Record<string, unknown>>(sql`SELECT i.id::text AS id, i.status, i.revision,
          (SELECT count(*)::int FROM approval_tasks t WHERE t.tenant_id=i.tenant_id AND t.instance_id=i.id
            AND t.status='pending') AS pending
        FROM approval_instances i
        WHERE i.tenant_id=${w.tenant.id} AND i.business_id=${intentionId}::uuid ORDER BY i.id`),
      audits: (
        await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_events
          WHERE tenant_id=${w.tenant.id} AND object_id=${intentionId}`)
      )[0]!.n,
      ledger: (
        await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM command_ledger
          WHERE tenant_id=${w.tenant.id}`)
      )[0]!.n,
    };
  }

  /** 员工主档由指定账号创建（其“使用用户”维度创建人），再绑定账号并入职（可信夹具，同 BE-15b1 createdByUser）。 */
  async function personCreatedBy(
    creatorUserId: string,
    name: string,
    departmentId: string,
    fields: Record<string, unknown> = {},
  ): Promise<Person> {
    const userId = await w.member(name);
    const created = await w.json<{ id: string }>(
      await w.request(creatorUserId, 'POST', `${EMPLOYMENT}/employees`, {
        ifMatch: 0,
        body: { name, code: `RT_${randomUUID().replaceAll('-', '')}` },
      }),
      201,
    );
    await rows(sql`INSERT INTO permission_user_person_links(tenant_id, user_id, employee_id)
      VALUES (${w.tenant.id}, ${userId}::uuid, ${created.id}::uuid)`);
    await w.hire(created.id, { departmentId, ...fields });
    return { userId, employeeId: created.id, name };
  }

  /** 把员工调入另一部门（直接调动，今天生效）：意向申请的部门快照不变，员工当前部门变了。 */
  async function transferTo(departmentId: string, employeeId = subject.employeeId) {
    const response = await w.request(w.hr.id, 'POST', `${EMPLOYMENT}/employees/${employeeId}/businesses`, {
      ifMatch: await revisionOf(employeeId),
      body: { kind: 'transfer', mode: 'direct', effectiveDate: TODAY, fields: { departmentId } },
    });
    expect(response.status, await response.clone().text()).toBe(201);
  }

  return {
    ...w,
    deptA,
    deptB,
    manager,
    subject,
    rows,
    setRetirement,
    personnelState,
    revisionOf,
    createRaw,
    create,
    get,
    list,
    patchRaw,
    actionRaw,
    act,
    instance,
    decide,
    footprint,
    transferTo,
    personCreatedBy,
  };
}

export type IntentionWorld = Awaited<ReturnType<typeof intentionWorld>>;
export const reasonOf = async (response: Response) => {
  const body = (await response.json()) as { error?: { code?: string; details?: { reason?: string } } };
  return { status: response.status, code: body.error?.code, reason: body.error?.details?.reason };
};
