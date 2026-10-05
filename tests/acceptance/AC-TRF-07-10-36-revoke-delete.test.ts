/**
 * R1-T11 撤销与删除任职（`08` §6、REQ-TRF-005）。
 * - AC-TRF-07：未审批完成的调动申请由 HR 撤销 → 记录置“作废”、流程作废、不生成任职；作废后只能删除（W-224）。
 *   发起人撤回 → 草稿，草稿可直接删除（W-010 / W-011，AC-TRF-28 同口径）。
 * - AC-TRF-08：已完成的只能删除任职；删除后前一条结束日恢复，时间轴、同日顺序（DEC-108 / 112）与“变更前”一致。
 * - AC-TRF-09 / 10：有合同变更、职责转交联动时阻止删除（DEC-012）；DEC-172 组织联动同样阻止。
 * - AC-TRF-36：其后有在途申请（审批中 / 审批通过未生效）时拒绝删除（DEC-126）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import { approvalWorld, TRANSFER_NODES, transferScene, type InstanceView } from './AC-APV-support.js';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const rows = <T>(value: unknown) => (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

async function world(label: string) {
  const w = await activationWorld(database().db, label);
  const third = await w.session.org('第三部门', { establishedOn: '2026-01-01' });
  const subject = await w.hired('调动员工');

  async function direct(effectiveDate: string, fields: Record<string, unknown>, employeeId = subject.employee.id) {
    const employee = await w.session.getEmployee(employeeId);
    return w.session.business(
      employeeId,
      { kind: 'transfer', mode: 'direct', effectiveDate, fields },
      employee.revision,
    );
  }

  async function action(id: string, verb: 'revoke' | 'withdraw', options: { key?: string; revision?: number } = {}) {
    const revision = options.revision ?? (await w.business(id)).revision;
    return w.session.request('POST', `/businesses/${id}/${verb}`, {
      ifMatch: revision,
      ...(options.key ? { idempotencyKey: options.key } : {}),
    });
  }

  async function remove(id: string, options: { key?: string; revision?: number } = {}) {
    const revision = options.revision ?? (await w.business(id)).revision;
    return w.session.request('DELETE', `/businesses/${id}`, {
      ifMatch: revision,
      ...(options.key ? { idempotencyKey: options.key } : {}),
    });
  }

  async function instanceStatus(businessId: string) {
    return withTenant(w.db, w.session.tenant.id, async (tx) => {
      const [row] = rows<{ status: string }>(
        await tx.execute(sql`SELECT status FROM approval_instances
          WHERE tenant_id=${w.session.tenant.id} AND business_id=${businessId}::uuid ORDER BY created_at DESC LIMIT 1`),
      );
      return row?.status ?? null;
    });
  }

  /** 时间轴快照：生效日、结束日、部门、前一条（“变更前”按版本链取，不单独存列）。 */
  async function timeline(employeeId = subject.employee.id, asOf = '2026-10-01') {
    return (await w.session.records(employeeId, asOf)).map((record) => ({
      id: record.id,
      effectiveDate: record.effectiveDate,
      stopDate: record.stopDate,
      departmentId: record.fields.departmentId,
      previousRecordId: record.previousRecordId,
      isCurrent: record.isCurrent,
    }));
  }

  return { ...w, third, subject, direct, action, remove, instanceStatus, timeline };
}

async function errorOf(response: Response) {
  const body = (await response.json()) as ErrorBody;
  return {
    status: response.status,
    code: body.error.code,
    message: body.error.message,
    reason: body.error.details?.reason,
    details: body.error.details,
  };
}

describe('AC-TRF-07 未审批完成的调动可撤销', () => {
  it('HR 撤销审批中的申请：记录置作废、流程作废、不生成任职；作废后只能删除', async () => {
    const w = await world('trf07-revoke');
    const before = await w.timeline();
    const application = await w.apply(w.subject.employee.id, '2026-10-20', { departmentId: w.to.id });
    expect(application.status).toBe('in_review');
    expect(await w.instanceStatus(application.id)).toBe('running');

    const revoked = await w.action(application.id, 'revoke');
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect(await revoked.json()).toMatchObject({ id: application.id, status: 'voided', record: null });
    expect(await w.instanceStatus(application.id)).toBe('cancelled');
    expect(await w.timeline()).toEqual(before);
    w.session.setNow('2026-10-20T01:00:00Z');
    expect((await w.runScheduler('2026-10-20T01:00:00Z')).failed).toEqual([]);
    expect(await w.timeline(w.subject.employee.id, '2026-10-20')).toHaveLength(1);
    expect((await w.business(application.id)).status).toBe('voided');

    // 作废后不能再撤销、提交或撤回，只剩“删除任职”。
    expect(await errorOf(await w.action(application.id, 'revoke'))).toMatchObject({ status: 409 });
    expect(await errorOf(await w.action(application.id, 'withdraw'))).toMatchObject({ status: 409 });
    const deleted = await w.remove(application.id);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await deleted.json()).toMatchObject({ status: 'deleted' });
    const audit = await w.auditEvents(application.id);
    expect(audit.map((event) => event.action)).toEqual(
      expect.arrayContaining(['employment.business.state.voided', 'employment.business.delete']),
    );
    const outbox = await w.outboxEvents(application.id);
    expect(outbox.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(['employment.business.state.voided', 'employment.business.delete']),
    );
  });

  it('驳回到发起人的申请也可撤销；已审批通过（未生效）与直接调动不能撤销，只能删除任职', async () => {
    const w = await world('trf07-states');
    const approved = await w.apply(w.subject.employee.id, '2026-10-20', { departmentId: w.to.id });
    await w.approve(approved, '2026-10-01T02:00:00Z');
    expect((await w.business(approved.id)).status).toBe('approved');
    expect(await errorOf(await w.action(approved.id, 'revoke'))).toMatchObject({ status: 409, code: 'CONFLICT' });
    expect((await w.remove(approved.id)).status).toBe(200);

    const directTransfer = await w.direct('2026-09-20', { departmentId: w.to.id });
    expect(await errorOf(await w.action(directTransfer.id, 'revoke'))).toMatchObject({ status: 409 });
  });

  it('发起人撤回回到草稿（W-010），草稿可直接删除（W-011），员工当前任职不变', async () => {
    const w = await world('trf07-withdraw');
    const before = await w.timeline();
    const application = await w.apply(w.subject.employee.id, '2026-10-20', { departmentId: w.to.id });
    const withdrawn = await w.action(application.id, 'withdraw');
    expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
    expect(await withdrawn.json()).toMatchObject({ status: 'draft' });
    expect(await w.instanceStatus(application.id)).toBe('withdrawn');
    const deleted = await w.remove(application.id);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await w.timeline()).toEqual(before);
  });

  it('撤销校验 revision（409）、同键重放幂等、同键异内容冲突；无撤销按钮权限 403；跨租户 404', async () => {
    const w = await world('trf07-command');
    const application = await w.apply(w.subject.employee.id, '2026-10-20', { departmentId: w.to.id });
    const stale = await w.action(application.id, 'revoke', { revision: application.revision - 1 });
    expect(await errorOf(stale)).toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    expect((await w.business(application.id)).status).toBe('in_review');

    const deny: Authorizer = (request) =>
      !(request.action === 'object.button' && String(request.resource).includes('Employment.Revoke'));
    const limited = tenantApi(w.db, { authorize: deny, clock: () => new Date('2026-10-01T01:00:00Z') });
    const forbidden = await limited.request('POST', `/api/tenant/employment/businesses/${application.id}/revoke`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: application.revision,
    });
    expect(forbidden.status).toBe(403);
    expect((await w.business(application.id)).status).toBe('in_review');

    const other = await world('trf07-command-other');
    const foreign = await other.session.request('POST', `/businesses/${application.id}/revoke`, {
      ifMatch: application.revision,
    });
    expect(foreign.status).toBe(404);

    const key = randomUUID();
    const first = await w.action(application.id, 'revoke', { key, revision: application.revision });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const replay = await w.action(application.id, 'revoke', { key, revision: application.revision });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    const misuse = await w.remove(application.id, { key, revision: application.revision });
    expect(await errorOf(misuse)).toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(await w.auditEvents(application.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'employment.business.state.voided' })]),
    );
    expect(
      (await w.auditEvents(application.id)).filter((event) => event.action === 'employment.business.state.voided'),
    ).toHaveLength(1);
  });
});

describe('AC-TRF-08 已完成的调动只能删除任职', () => {
  it('删除最新一条：前一条结束日恢复为“至今”，员工当前任职回滚，审批流程仍为通过', async () => {
    const w = await world('trf08-latest');
    const application = await w.apply(w.subject.employee.id, '2026-09-20', { departmentId: w.to.id });
    await w.approve(application, '2026-10-01T02:00:00Z');
    expect((await w.business(application.id)).status).toBe('effective');
    expect((await w.timeline()).at(-1)).toMatchObject({ departmentId: w.to.id, isCurrent: true });

    const key = randomUUID();
    const deleted = await w.remove(application.id, { key });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    const body = await deleted.json();
    expect(body).toMatchObject({ status: 'deleted' });
    expect(await w.timeline()).toEqual([
      expect.objectContaining({
        id: w.subject.hire.id,
        stopDate: '9999-12-31',
        departmentId: w.from.id,
        isCurrent: true,
      }),
    ]);
    // 同键重放返回原结果，不重复删除。
    const replay = await w.remove(application.id, { key, revision: (body as { revision: number }).revision - 1 });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(body);

    // 审计与 outbox 由同一命令写入（DEC-019 / §10）。
    const audit = await w.auditEvents(application.id);
    expect(audit.map((event) => event.action)).toEqual(
      expect.arrayContaining(['employment.record.delete', 'employment.business.delete']),
    );
    const commands = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      rows<{ auditCommand: string; outboxCommand: string }>(
        await tx.execute(sql`SELECT a.command_id AS "auditCommand", o.command_id AS "outboxCommand"
          FROM audit_events a JOIN employment_outbox o ON o.tenant_id=a.tenant_id
            AND o.object_id::text=a.object_id::text AND o.event_type=a.action
          WHERE a.tenant_id=${w.session.tenant.id} AND a.object_id=${application.id}
            AND a.action='employment.record.delete'`),
      ),
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]!.auditCommand).toBe(commands[0]!.outboxCommand);
  });

  it('删除中间一条：前一条区间接到后一条，后一条的“变更前”改取前一条；后续记录不被重算（W-013）', async () => {
    const w = await world('trf08-middle');
    const middle = await w.direct('2026-09-10', { departmentId: w.to.id });
    const later = await w.direct('2026-09-20', { departmentId: w.third.id });
    expect((await w.timeline()).map((item) => item.departmentId)).toEqual([w.from.id, w.to.id, w.third.id]);

    const deleted = await w.remove(middle.id);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await w.timeline()).toEqual([
      expect.objectContaining({ id: w.subject.hire.id, stopDate: '2026-09-19', departmentId: w.from.id }),
      expect.objectContaining({
        id: later.id,
        stopDate: '9999-12-31',
        departmentId: w.third.id,
        previousRecordId: w.subject.hire.id,
        isCurrent: true,
      }),
    ]);
    const detail = await w.session.record(later.id);
    expect(detail.before).toMatchObject({ fields: { departmentId: w.from.id } });
    // 被删记录不可再读，也不能重复删除。
    expect((await w.session.request('GET', `/records/${middle.id}`)).status).toBe(404);
    expect((await w.remove(middle.id)).status).toBe(409);
  });

  it('同日多条按操作先后（DEC-108）：删除当日较早的一条，当日最后一条仍为当天最终状态', async () => {
    const w = await world('trf08-same-day');
    const first = await w.direct('2026-09-10', { departmentId: w.to.id });
    const second = await w.direct('2026-09-10', { departmentId: w.third.id });
    expect((await w.timeline()).map((item) => item.id)).toEqual([w.subject.hire.id, first.id, second.id]);

    const deleted = await w.remove(first.id);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await w.timeline()).toEqual([
      expect.objectContaining({ id: w.subject.hire.id, stopDate: '2026-09-09' }),
      expect.objectContaining({ id: second.id, previousRecordId: w.subject.hire.id, isCurrent: true }),
    ]);
    // 再删当日最后一条：入职记录恢复为至今。
    expect((await w.remove(second.id)).status).toBe(200);
    expect(await w.timeline()).toEqual([
      expect.objectContaining({ id: w.subject.hire.id, stopDate: '9999-12-31', isCurrent: true }),
    ]);
  });

  it('同日删除当日最后一条：当日较早的一条重新成为当天的当前任职并延续到后一条', async () => {
    const w = await world('trf08-same-day-last');
    const first = await w.direct('2026-09-10', { departmentId: w.to.id });
    const second = await w.direct('2026-09-10', { departmentId: w.third.id });
    const later = await w.direct('2026-09-25', { departmentId: w.from.id });
    expect((await w.remove(second.id)).status).toBe(200);
    expect(await w.timeline()).toEqual([
      expect.objectContaining({ id: w.subject.hire.id, stopDate: '2026-09-09' }),
      expect.objectContaining({ id: first.id, stopDate: '2026-09-24', departmentId: w.to.id }),
      expect.objectContaining({ id: later.id, previousRecordId: first.id, isCurrent: true }),
    ]);
  });

  it('删除校验 revision：过期 revision 返回 409，记录不变', async () => {
    const w = await world('trf08-revision');
    const transfer = await w.direct('2026-09-20', { departmentId: w.to.id });
    const stale = await w.remove(transfer.id, { revision: transfer.revision - 1 });
    expect(await errorOf(stale)).toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    expect(await w.timeline()).toHaveLength(2);
  });

  it('入职记录其后还有同周期记录时不能删除（开新周期的记录须最后删除）', async () => {
    const w = await world('trf08-hire');
    await w.direct('2026-09-20', { departmentId: w.to.id });
    const refused = await w.remove(w.subject.hire.id);
    expect(await errorOf(refused)).toMatchObject({ status: 409, code: 'EMPLOYMENT_FUTURE_VERSION_EXISTS' });
    expect(await w.timeline()).toHaveLength(2);
  });
});

describe('AC-TRF-36 其后有在途申请时拒绝删除（DEC-126）', () => {
  it('其后有审批中的申请：拒绝删除并列出申请单号；记录、申请、流程均不变；撤销后可删除', async () => {
    const w = await world('trf36-review');
    const transfer = await w.direct('2026-09-20', { departmentId: w.to.id });
    const application = await w.apply(w.subject.employee.id, '2026-10-20', { departmentId: w.third.id });
    const before = await w.timeline();

    const refused = await errorOf(await w.remove(transfer.id));
    expect(refused).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: '该员工有在途申请，请先撤销或驳回后再删除',
      reason: 'EMPLOYMENT_PENDING_APPLICATION_EXISTS',
      details: { applications: [{ id: application.id, effectiveDate: '2026-10-20', status: 'in_review' }] },
    });
    expect(await w.timeline()).toEqual(before);
    expect((await w.business(application.id)).status).toBe('in_review');
    expect(await w.instanceStatus(application.id)).toBe('running');
    expect((await w.business(transfer.id)).status).toBe('effective');

    expect((await w.action(application.id, 'revoke')).status).toBe(200);
    const deleted = await w.remove(transfer.id);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await w.timeline()).toHaveLength(1);
  });

  it('其后有审批通过未生效的申请同样拒绝；草稿不算在途；生效日早于被删记录的申请不拦', async () => {
    const w = await world('trf36-approved');
    const transfer = await w.direct('2026-09-20', { departmentId: w.to.id });
    const approved = await w.apply(w.subject.employee.id, '2026-10-20', { departmentId: w.third.id });
    await w.approve(approved, '2026-10-01T02:00:00Z');
    expect(await errorOf(await w.remove(transfer.id))).toMatchObject({
      status: 409,
      reason: 'EMPLOYMENT_PENDING_APPLICATION_EXISTS',
      details: { applications: [{ id: approved.id, status: 'approved' }] },
    });
    expect((await w.remove(approved.id)).status).toBe(200);

    const employee = await w.session.getEmployee(w.subject.employee.id);
    await w.session.business(
      w.subject.employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-25', fields: { departmentId: w.third.id } },
      employee.revision,
    );
    const deleted = await w.remove(transfer.id);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
  });
});

describe('AC-TRF-09 / 10 有联动变更时阻止删除（DEC-012）', () => {
  it('合同变更、职责转交联动（R1-T10 经联动探针登记）存在时拒绝删除并列出对象；撤销联动后可删除', async () => {
    const w = await world('trf09-10');
    const transfer = await w.direct('2026-09-20', { departmentId: w.to.id });
    const linked = new Set(['contract', 'duty']);
    const { registerDeletionLinkageProbe } = await import('../../apps/api/src/modules/employment/deletion-guards.js');
    // R1-T10 尚未合并：以同一接口模拟它登记的合同变更 / 职责转交联动，删除只读取“当前仍在的联动”。
    registerDeletionLinkageProbe('test:contract', async (_tx, _ctx, record) =>
      record.id === transfer.id && linked.has('contract') ? [{ kind: 'contract', label: '合同【HT-2026-001】' }] : [],
    );
    registerDeletionLinkageProbe('test:duty', async (_tx, _ctx, record) =>
      record.id === transfer.id && linked.has('duty') ? [{ kind: 'duty', label: '职责转交【2 项待办】' }] : [],
    );
    const before = await w.timeline();

    const refused = await errorOf(await w.remove(transfer.id));
    expect(refused).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      reason: 'EMPLOYMENT_LINKED_CHANGES_EXIST',
      message: '已联动修改合同【HT-2026-001】及职责转交【2 项待办】，请先调整后再删除',
      details: { linkages: [{ kind: 'contract' }, { kind: 'duty' }] },
    });
    expect(await w.timeline()).toEqual(before);

    linked.delete('contract');
    expect(await errorOf(await w.remove(transfer.id))).toMatchObject({
      message: '已联动修改职责转交【2 项待办】，请先调整后再删除',
    });
    linked.delete('duty');
    expect((await w.remove(transfer.id)).status).toBe(200);
  });
});

describe('DEC-172 删除带组织联动的已生效调动：阻止删除', () => {
  async function linkedWorld(label: string) {
    const w = await world(label);
    const subordinates = [await w.hired('新增下属甲'), await w.hired('新增下属乙')];
    const transfer = await w.direct('2026-09-20', {
      departmentId: w.to.id,
      isDepartmentHead: true,
      isStoreManager: true,
      addedSubordinateIds: subordinates.map((item) => item.employee.id),
    });
    return { ...w, subordinates, transfer };
  }

  async function orgRevision(w: ActivationWorld, id: string) {
    return withTenant(w.db, w.session.tenant.id, async (tx) => {
      const [row] = rows<{ revision: number }>(
        await tx.execute(sql`SELECT revision FROM org_objects WHERE tenant_id=${w.session.tenant.id} AND id=${id}`),
      );
      return Number(row!.revision);
    });
  }

  it('负责人 / 店长 / 新增下属仍在时拒绝删除，提示列出组织与人数；调整后可删除', async () => {
    const w = await linkedWorld('dec172');
    const refused = await errorOf(await w.remove(w.transfer.id));
    expect(refused).toMatchObject({
      status: 409,
      reason: 'EMPLOYMENT_LINKED_CHANGES_EXIST',
      message: '已联动修改【调入部门】负责人、店长及 2 名员工的直线经理，请先调整后再删除',
      details: {
        linkages: [
          { kind: 'organization', orgId: w.to.id, roles: ['personInCharge', 'shopOwner'] },
          { kind: 'directManager', count: 2 },
        ],
      },
    });

    // HR 调整：组织负责人、店长改由他人担任，下属直线经理改回。
    const other = await w.hired('新负责人');
    const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
    const patched = await api.request('PATCH', `/api/tenant/org/organizations/${w.to.id}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: await orgRevision(w, w.to.id),
      body: { personInChargeId: other.employee.id, shopOwnerId: other.employee.id, effectiveDate: '2026-10-01' },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect(await errorOf(await w.remove(w.transfer.id))).toMatchObject({
      message: '已联动修改 2 名员工的直线经理，请先调整后再删除',
    });
    for (const subordinate of w.subordinates) {
      const current = await w.business(subordinate.hire.id);
      const edited = await w.session.request('PATCH', `/records/${subordinate.hire.id}`, {
        ifMatch: current.revision,
        body: { fields: { directManagerId: null } },
      });
      expect(edited.status, await edited.clone().text()).toBe(200);
    }
    const deleted = await w.remove(w.transfer.id);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
  });

  it('只设店长、没有新增下属的调动：提示只列店长', async () => {
    const w = await world('dec172-shop');
    const transfer = await w.direct('2026-09-20', { departmentId: w.to.id, isStoreManager: true });
    expect(await errorOf(await w.remove(transfer.id))).toMatchObject({
      status: 409,
      message: '已联动修改【调入部门】店长，请先调整后再删除',
    });
  });

  it('未来生效、尚未联动的直接调动可以直接删除', async () => {
    const w = await world('dec172-future');
    const subordinate = await w.hired('未来下属');
    const transfer = await w.direct('2026-10-20', {
      departmentId: w.to.id,
      isDepartmentHead: true,
      addedSubordinateIds: [subordinate.employee.id],
    });
    const deleted = await w.remove(transfer.id);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await w.timeline()).toHaveLength(1);
  });
});

describe('AC-TRF-07 / 08 与审批中心', () => {
  function current(view: InstanceView) {
    const tasks = view.tasks.filter((task) => task.status === 'pending');
    expect(tasks).toHaveLength(1);
    return tasks[0]!;
  }

  it('审批中心办结通过后删除任职：任职记录删除，流程仍为“通过”', async () => {
    const w = await approvalWorld(database().db, 'trf08-instance');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!] });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    const view = await w.submit(draft);
    const approved = await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision);
    expect(approved.status, await approved.clone().text()).toBe(200);
    const business = await w.business(draft.id);
    expect(business.status).toBe('effective');
    const deleted = await w.request(w.hr.id, 'DELETE', `/api/tenant/employment/businesses/${draft.id}`, {
      ifMatch: business.revision,
    });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect((await w.detail(view.id)).status).toBe('approved');
    expect((await w.business(draft.id)).status).toBe('deleted');
  });

  it('HR 撤销与最后节点同意并发：一方成功、另一方 409，不出现死锁或 500', async () => {
    const w = await approvalWorld(database().db, 'trf07-race');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!] });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    const view = await w.submit(draft);
    const business = await w.business(draft.id);
    const raced = await Promise.all([
      w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision),
      w.request(w.hr.id, 'POST', `/api/tenant/employment/businesses/${draft.id}/revoke`, {
        ifMatch: business.revision,
      }),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([200, 409]);
    const final = await w.detail(view.id);
    const after = await w.business(draft.id);
    if (final.status === 'approved') expect(after.status).toBe('effective');
    else expect([final.status, after.status]).toEqual(['cancelled', 'voided']);
  });
});
