import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { applySignEvent } from '../../apps/api/src/modules/esign/sign-events.js';
import { initiateTransferSign } from '../../apps/api/src/modules/esign/transfer-sign.js';
import { isTransferInForce } from '../../apps/api/src/modules/esign/transfer-in-force.js';
import * as notifications from '../../apps/api/src/modules/approval/notifications.js';
import { tenantApi } from './support/tenant-api.js';
import { controlledApi, everyField } from './AC-LNK-support.js';
import { signWorld, SIGN_AT, rows, type SignWorld } from './AC-TRF-F481-s2-support.js';
import type { SignEvent } from '@italent/domain';

const database = useTestDb();
const ctx = (w: SignWorld) => ({
  tenantId: w.tenantId,
  tenantName: w.session.tenant.name,
  userId: w.session.user.id,
  timezone: w.session.tenant.timezone,
  now: new Date(SIGN_AT),
  commandId: randomUUID(),
  expectedRevision: 1,
});
const event = (w: SignWorld, task: { id: string; revision: number }, e: SignEvent) =>
  withTenant(w.db, w.tenantId, (tx) => applySignEvent(tx, ctx(w), task, e));
async function complete(w: SignWorld) {
  const [task] = await w.tasks();
  const employee = await event(w, task!, {
    type: 'node_signed',
    node: 'employee',
    actorUserId: task!.employeeSignerUserId,
    at: new Date(SIGN_AT),
  });
  expect(employee.currentNode).toBe('enterprise');
  expect(await w.notices()).toEqual([]);
  return event(w, employee, {
    type: 'node_signed',
    node: 'enterprise',
    actorUserId: w.session.user.id,
    at: new Date(SIGN_AT),
  });
}
async function audits(w: SignWorld, id: string) {
  return withTenant(w.db, w.tenantId, async (tx) =>
    rows<{ action: string; after: object }>(
      await tx.execute(sql`
    SELECT action,after FROM audit_events WHERE tenant_id=${w.tenantId} AND object_id=${id} ORDER BY action`),
    ),
  );
}
async function releaseContract(w: SignWorld) {
  const contract = (await w.contracts(w.person.employee.id)).find((c) => c.status === 'valid')!;
  const api = tenantApi(w.db, { clock: () => new Date(SIGN_AT) });
  const response = await api.request('POST', '/api/tenant/contracts/commands', {
    ...w.as,
    ifMatch: contract.revision,
    body: {
      operation: 'terminate',
      mode: 'direct',
      employeeId: w.person.employee.id,
      targetId: contract.id,
      fields: { actualTerminationDate: '2026-10-10' },
    },
  });
  expect(response.status, await response.clone().text()).toBe(201);
}

describe('AC-TRF-F481-17 / 21 签署状态、通知与审计同事务', () => {
  it('21 两次确认生成完成任务和恰好两条通知；旧 revision 与乱序不改变状态；终态吸收', async () => {
    const w = await signWorld(database().db, '21-complete');
    await w.direct();
    const [task] = await w.tasks();
    expect((await audits(w, task!.id)).map((a) => a.action)).toEqual(['esign.task.initiated']);
    await expect(
      event(w, task!, {
        type: 'node_signed',
        node: 'enterprise',
        actorUserId: w.session.user.id,
        at: new Date(SIGN_AT),
      }),
    ).rejects.toMatchObject({ details: { reason: 'ESIGN_NODE_MISMATCH' } });
    await expect(
      event(
        w,
        { ...task!, revision: 99 },
        { type: 'node_signed', node: 'employee', actorUserId: task!.employeeSignerUserId, at: new Date(SIGN_AT) },
      ),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const done = await complete(w);
    expect(done).toMatchObject({ status: 'completed', currentNode: null, revision: 3, completedAt: new Date(SIGN_AT) });
    expect((await w.notices()).map((n) => [n.template_code, n.recipient_user_id, n.business_type])).toEqual([
      ['esign_completed_employee', task!.employeeSignerUserId, 'esign_task'],
      ['esign_completed_initiator', w.session.user.id, 'esign_task'],
    ]);
    expect((await audits(w, task!.id)).map((a) => a.action)).toEqual([
      'esign.task.completed',
      'esign.task.initiated',
      'esign.task.node_signed',
      'esign.task.node_signed',
    ]);
    await expect(
      event(w, done, { type: 'revoked', cause: 'manual', actorUserId: w.session.user.id, at: new Date(SIGN_AT) }),
    ).rejects.toMatchObject({ details: { reason: 'ESIGN_TASK_CLOSED' } });
    expect(await w.notices()).toHaveLength(2);
  });

  it('21 第二条通知写入失败：完成状态、第一条通知、两条审计均回滚', async () => {
    const w = await signWorld(database().db, '21-rollback');
    await w.direct();
    const [task] = await w.tasks();
    const ready = await event(w, task!, {
      type: 'node_signed',
      node: 'employee',
      actorUserId: task!.employeeSignerUserId,
      at: new Date(SIGN_AT),
    });
    const before = await audits(w, task!.id);
    const original = notifications.notifyMessage;
    const spy = vi
      .spyOn(notifications, 'notifyMessage')
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new Error('SYN_NOTIFICATION_WRITE_FAILED'));
    try {
      await expect(
        event(w, ready, {
          type: 'node_signed',
          node: 'enterprise',
          actorUserId: w.session.user.id,
          at: new Date(SIGN_AT),
        }),
      ).rejects.toThrow('SYN_NOTIFICATION_WRITE_FAILED');
    } finally {
      spy.mockRestore();
    }
    expect(await w.tasks()).toEqual([ready]);
    expect(await w.notices()).toEqual([]);
    expect(await audits(w, task!.id)).toEqual(before);
  });

  it('17 合同仍有效拒绝删除；调整合同后删除撤销在途并保留已完成任务', async () => {
    const w = await signWorld(database().db, '17');
    const business = await w.direct();
    const done = await complete(w);
    const next = await withTenant(w.db, w.tenantId, (tx) =>
      initiateTransferSign(tx, ctx(w), {
        businessId: business.id,
        templateIds: [w.templates[2]!.id],
        initiatorUserId: w.session.user.id,
        origin: 'manual',
      }),
    );
    const remove = async () =>
      w.session.request('DELETE', `/businesses/${business.id}`, {
        ifMatch: (await w.business(business.id)).revision,
      });
    expect((await remove()).status).toBe(409);
    expect((await w.tasks()).find((t) => t.id === next.id)).toEqual(next);
    await releaseContract(w);
    const response = await remove();
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await w.business(business.id)).status).toBe('deleted');
    const tasks = await w.tasks();
    expect(tasks.find((t) => t.id === done.id)).toEqual(done);
    expect(tasks.find((t) => t.id === next.id)).toMatchObject({
      status: 'revoked',
      revokeCause: 'business_deleted',
      currentNode: null,
    });
    expect((await w.notices()).filter((n) => n.business_id === next.id).map((n) => n.template_code)).toEqual([
      'esign_revoked_employee',
      'esign_revoked_initiator',
    ]);
    expect((await audits(w, next.id)).map((a) => a.action)).toEqual(['esign.task.initiated', 'esign.task.revoked']);
    expect(await withTenant(w.db, w.tenantId, (tx) => isTransferInForce(tx, ctx(w), business.id))).toBe(false);
  });

  it.each(['revoked', 'expired', 'provider_failed'] as const)('完整状态迁移 %s，终态无当前节点', async (type) => {
    const w = await signWorld(database().db, `state-${type}`);
    await w.direct();
    const [task] = await w.tasks();
    let e: SignEvent = { type: 'expired', at: new Date('2026-10-12T01:00:00Z') };
    if (type === 'revoked') e = { type, cause: 'manual', actorUserId: w.session.user.id, at: new Date(SIGN_AT) };
    if (type === 'provider_failed') e = { type, reason: 'SYN_PROVIDER_FAILURE', at: new Date(SIGN_AT) };
    const after = await event(w, task!, e);
    expect(after).toMatchObject({ status: type === 'provider_failed' ? 'failed' : type, currentNode: null });
    expect(await w.notices()).toHaveLength(type === 'revoked' ? 2 : 0);
    await expect(event(w, after, e)).rejects.toMatchObject({ details: { reason: 'ESIGN_TASK_CLOSED' } });
  });
});

describe('AC-TRF-F481-04 / 20 两字段授权与联动出参', () => {
  it('20 模板列表按保存顺序、停用显示不可用；逐字段撤权后没有隐藏 ID 或名称', async () => {
    const w = await signWorld(database().db, '20');
    const business = await w.saved(await w.transfer(w.person, { mode: 'direct', submit: false, linkage: w.linkage() }));
    const read = () => w.session.request('GET', `/transfers/${business.id}/linkage`);
    expect(await (await read()).json()).toMatchObject({
      esign: { templates: w.templates.slice(0, 2).map((t) => ({ id: t.id, name: t.name, available: true })) },
    });
    await w.call('PATCH', `/templates/${w.templates[0]!.id}`, { ifMatch: 1, body: { status: 'disabled' } });
    expect(await (await read()).json()).toMatchObject({
      esign: {
        templates: [
          { id: w.templates[0]!.id, available: false },
          { id: w.templates[1]!.id, available: true },
        ],
      },
    });
    for (const hidden of ['electronicSignature', 'esignTemplateIds']) {
      const fields = everyField('TenantBase.EmploymentRecord').filter((f) => f !== hidden);
      const request = controlledApi(
        w.db,
        w.tenantId,
        w.session.user.id,
        { fields: { 'TenantBase.EmploymentRecord': fields } },
        SIGN_AT,
      );
      const response = await request('GET', `/api/tenant/employment/transfers/${business.id}/linkage`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      if (hidden === 'electronicSignature') expect(body).not.toHaveProperty('esign');
      expect(JSON.stringify(body)).not.toContain(w.templates[0]!.id);
      expect(JSON.stringify(body)).not.toContain(w.templates[0]!.name);
    }
  });

  it.each(['electronicSignature', 'esignTemplateIds'])(
    '04 缺 %s 编辑权：新增和改联动均 403，原选择不变',
    async (field) => {
      const w = await signWorld(database().db, `04-${field}`);
      const request = controlledApi(
        w.db,
        w.tenantId,
        w.session.user.id,
        { deny: (q) => ['object.create', 'object.update'].includes(q.action) && q.fields?.includes(field) === true },
        '2026-10-01T01:00:00Z',
      );
      const response = await request('POST', `/api/tenant/employment/transfers/employees/${w.person.employee.id}`, {
        ifMatch: (await w.session.getEmployee(w.person.employee.id)).revision,
        body: {
          initiator: 'hr',
          transferTypeCode: 'cross_department',
          mode: 'direct',
          effectiveDate: '2026-10-10',
          fields: { departmentId: w.to.id },
          linkage: w.linkage(),
        },
      });
      expect(response.status, await response.clone().text()).toBe(403);
      const business = await w.saved(
        await w.transfer(w.person, { mode: 'direct', submit: false, linkage: w.linkage() }),
      );
      const edit = await request('PUT', `/api/tenant/employment/transfers/${business.id}/linkage`, {
        ifMatch: business.revision,
        body: { contract: w.linkage().contract, esign: null },
      });
      expect(edit.status, await edit.clone().text()).toBe(403);
      const unchanged = await w.session.request('GET', `/transfers/${business.id}/linkage`);
      expect(await unchanged.json()).toMatchObject({
        revision: business.revision,
        options: { esign: { templateIds: w.templates.slice(0, 2).map((t) => t.id) } },
      });
    },
  );
});

describe('F-481 S2 并发与删除事务回滚', () => {
  it('同 revision 并发确认恰好一次推进，另一条 REVISION_CONFLICT', async () => {
    const w = await signWorld(database().db, 'concurrent');
    await w.direct();
    const [task] = await w.tasks();
    const e: SignEvent = {
      type: 'node_signed',
      node: 'employee',
      actorUserId: task!.employeeSignerUserId,
      at: new Date(SIGN_AT),
    };
    const results = await Promise.allSettled([event(w, task!, e), event(w, task!, e)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'REVISION_CONFLICT' }) }),
    ]);
    expect((await w.tasks())[0]).toMatchObject({ currentNode: 'enterprise', revision: 2 });
    expect((await audits(w, task!.id)).map((a) => a.action)).toEqual([
      'esign.task.initiated',
      'esign.task.node_signed',
    ]);
  });

  it('17 删除时撤销通知失败，删除墓碑、任务、审计均回滚；同命令重试成功且不重复通知', async () => {
    const w = await signWorld(database().db, 'delete-rollback');
    const business = await w.direct();
    await releaseContract(w);
    const [task] = await w.tasks();
    const revision = (await w.business(business.id)).revision;
    const key = crypto.randomUUID();
    const remove = () =>
      w.session.request('DELETE', `/businesses/${business.id}`, { ifMatch: revision, idempotencyKey: key });
    const spy = vi
      .spyOn(notifications, 'notifyMessage')
      .mockRejectedValueOnce(new Error('SYN_NOTIFICATION_WRITE_FAILED'));
    try {
      expect((await remove()).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect((await w.business(business.id)).status).toBe('effective');
    expect(await w.tasks()).toEqual([task]);
    expect(await w.notices()).toEqual([]);
    expect((await audits(w, task!.id)).map((a) => a.action)).toEqual(['esign.task.initiated']);
    expect((await remove()).status).toBe(200);
    expect((await remove()).status).toBe(200);
    expect(await w.notices()).toHaveLength(2);
  });
});
