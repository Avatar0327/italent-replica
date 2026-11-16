import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { STANDARD_PROFILES, MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import * as notifications from '../../apps/api/src/modules/approval/notifications.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { recordsWorld, json, RECORD, BASE, COLUMNS } from './AC-TRF-F481-s3b-support.js';
import { SIGN_AT } from './AC-TRF-F481-s2-support.js';

const database = useTestDb();
describe('AC-TRF-F481-12 / 13① / 15 / 19 / 21 签署记录', () => {
  it('15 三页签五状态、八列、分页倒序与字段裁剪；空范围默认关闭', async () => {
    const w = await recordsWorld(database().db, 'list');
    const completed = await w.complete(w.task);
    const revoked = await w.event(await w.next(), {
      type: 'revoked',
      cause: 'manual',
      actorUserId: w.session.user.id,
      at: new Date(SIGN_AT),
    });
    const expired = await w.event(await w.next(), { type: 'expired', at: new Date(SIGN_AT) });
    const failed = await w.event(await w.next(), {
      type: 'provider_failed',
      reason: 'SYN_FAILURE',
      at: new Date(SIGN_AT),
    });
    const signing = await w.next();
    await withTenant(w.db, w.tenantId, async (tx) => {
      for (const [i, task] of [completed, revoked, expired, failed, signing].entries()) {
        const initiatedAt = new Date(Date.parse(SIGN_AT) + i * 1000).toISOString();
        await tx.execute(sql`UPDATE esign_tasks SET initiated_at=${initiatedAt}
          WHERE tenant_id=${w.tenantId} AND id=${task.id}`);
      }
    });
    const all = await json(await w.call('GET', `${BASE}/records?tab=all`));
    expect(all.items.map((r: { id: string }) => r.id)).toEqual([
      signing.id,
      failed.id,
      expired.id,
      revoked.id,
      completed.id,
    ]);
    expect(all.total).toBe(5);
    for (const key of COLUMNS) expect(all.items[0]).toHaveProperty(key);
    expect(all.items[0].owner).toMatchObject({ id: w.person.employee.id, name: 'ZZ_F481_EMP_01' });
    expect(all.items[0].files).toEqual([{ seq: 1, name: 'ZZ_F481_A' }]);
    for (const [tab, task] of [
      ['signing', signing],
      ['completed', completed],
    ] as const) {
      const body = await json(await w.call('GET', `${BASE}/records?tab=${tab}`));
      expect(body.items.map((r: { id: string }) => r.id)).toEqual([task.id]);
      expect(body.total).toBe(1);
    }
    const page = await json(await w.call('GET', `${BASE}/records?tab=all&page=2&pageSize=2`));
    expect(page.items.map((r: { id: string }) => r.id)).toEqual([expired.id, revoked.id]);
    expect(page.total).toBe(5);
    for (const query of ['pageSize=101', 'page=0', 'tab=invalid'])
      expect((await w.call('GET', `${BASE}/records?${query}`)).status).toBe(400);
    const trim = w.request({ fields: { [RECORD]: COLUMNS.filter((f) => f !== 'initiator') } });
    for (const row of (await json(await trim('GET', `${BASE}/records`))).items)
      expect(row).not.toHaveProperty('initiator');
    const empty = w.request({ scopes: { [RECORD]: EMPTY_SCOPE } });
    expect(await json(await empty('GET', `${BASE}/records`))).toMatchObject({ items: [], total: 0 });
    const denied = w.request({ deny: (q) => q.resource === RECORD && q.action === 'object.view' });
    expect((await denied('GET', `${BASE}/records`)).status).toBe(403);
  });

  it('15 / 19 范围在分页前过滤；跨租户撤销和下载与不存在相同', async () => {
    const w = await recordsWorld(database().db, 'scope');
    const scope = {
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      terms: [
        {
          dimension: 'organization' as const,
          orgIds: [w.from.id],
          personIds: [],
          personQuery: { kind: 'organization' as const, tenantId: w.tenantId, asOf: '2026-10-10' },
        },
      ],
    };
    const request = w.request({ scopes: { [RECORD]: scope } });
    expect(await json(await request('GET', `${BASE}/records?pageSize=1`))).toMatchObject({ items: [], total: 0 });
    const allowed = w.request({
      scopes: { [RECORD]: { ...scope, terms: [{ ...scope.terms[0]!, orgIds: [w.to.id] }] } },
    });
    expect(
      (await json(await allowed('GET', `${BASE}/records?pageSize=1`))).items.map((r: { id: string }) => r.id),
    ).toEqual([w.task.id]);
    for (const action of ['revoke', 'remind']) {
      const body = await json(
        await request('POST', `${BASE}/records/${action}`, { body: { items: [{ id: w.task.id, revision: 1 }] } }),
      );
      expect(body.items).toEqual([{ id: w.task.id, ok: false, code: 'NOT_FOUND' }]);
    }
    const b = await recordsWorld(database().db, 'foreign');
    const foreignList = await json(await b.call('GET', `${BASE}/records`));
    expect(foreignList.items.map((r: { id: string }) => r.id)).toEqual([b.task.id]);
    expect(foreignList.total).toBe(1);
    for (const id of [w.task.id, randomUUID()]) {
      const body = await json(await b.batch('revoke', [{ id, revision: 1 }]));
      expect(body.items).toEqual([{ id, ok: false, code: 'NOT_FOUND' }]);
      expect((await b.call('GET', `${BASE}/records/files?ids=${id}`)).status).toBe(404);
      expect((await b.call('GET', `${BASE}/mine/${id}/files`)).status).toBe(404);
    }
    expect(await w.tasks()).toEqual([w.task]);
  });

  it('12 员工与企业提醒、终态逐条失败、50 条上限；21 提醒审计与幂等', async () => {
    const w = await recordsWorld(database().db, 'remind');
    const key = randomUUID();
    expect((await json(await w.batch('remind', [w.task], key))).items).toEqual([{ id: w.task.id, ok: true }]);
    expect((await json(await w.batch('remind', [w.task], key))).items).toEqual([{ id: w.task.id, ok: true }]);
    expect(await w.notices()).toHaveLength(1);
    expect((await w.notices())[0]).toMatchObject({
      template_code: 'esign_remind',
      recipient_user_id: w.task.employeeSignerUserId,
      business_type: 'esign_task',
    });
    expect((await w.audits(w.task.id)).filter((a) => a.action === 'esign.task.reminded')).toHaveLength(1);
    expect((await w.batch('remind', [{ ...w.task, revision: 99 }], key)).status).toBe(409);
    const ready = await w.employeeSign((await w.tasks())[0]!);
    expect((await json(await w.batch('remind', [ready]))).items[0].ok).toBe(true);
    expect(await w.notices()).toHaveLength(2);
    expect((await w.notices()).some((n) => n.recipient_user_id === w.session.user.id)).toBe(true);
    const done = await w.event(ready, {
      type: 'node_signed',
      node: 'enterprise',
      actorUserId: w.session.user.id,
      at: new Date(SIGN_AT),
    });
    const pending = await w.next();
    expect((await json(await w.batch('remind', [done, pending]))).items).toEqual([
      { id: done.id, ok: false, code: 'ESIGN_TASK_CLOSED' },
      { id: pending.id, ok: true },
    ]);
    const tooMany = await json(
      await w.batch(
        'remind',
        Array.from({ length: 51 }, () => ({ id: randomUUID(), revision: 1 })),
      ),
      400,
    );
    expect(tooMany.error.details.reason).toBe('BATCH_LIMIT_EXCEEDED');
    expect((await w.batch('remind', [])).status).toBe(400);
    const fifty = await json(
      await w.batch(
        'remind',
        Array.from({ length: 50 }, () => ({ id: randomUUID(), revision: 1 })),
      ),
    );
    expect(fifty.items).toHaveLength(50);
  });

  it('13① 撤销通知各一；旧 revision 拒绝，重读显式重提成功，员工不能再签', async () => {
    const w = await recordsWorld(database().db, 'revoke');
    expect((await json(await w.batch('revoke', [{ ...w.task, revision: 99 }]))).items).toEqual([
      { id: w.task.id, ok: false, code: 'REVISION_CONFLICT' },
    ]);
    expect(await w.tasks()).toEqual([w.task]);
    const key = randomUUID();
    const current = (await w.tasks())[0]!;
    expect((await json(await w.batch('revoke', [current], key))).items).toEqual([{ id: current.id, ok: true }]);
    expect((await json(await w.batch('revoke', [current], key))).items[0].ok).toBe(true);
    const revoked = (await w.tasks())[0]!;
    expect(revoked).toMatchObject({ status: 'revoked', revokeCause: 'manual', currentNode: null, revision: 2 });
    expect((await w.notices()).map((n) => [n.template_code, n.recipient_user_id])).toEqual([
      ['esign_revoked_employee', w.task.employeeSignerUserId],
      ['esign_revoked_initiator', w.session.user.id],
    ]);
    await expect(w.employeeSign(revoked)).rejects.toMatchObject({
      status: 409,
      details: { reason: 'ESIGN_TASK_CLOSED' },
    });
    expect((await w.audits(revoked.id)).filter((a) => a.action === 'esign.task.revoked')).toHaveLength(1);
  });

  it.each(['remind', 'revoke'])('21 %s 通知失败时任务/通知/审计回滚，原命令重试成功', async (action) => {
    const w = await recordsWorld(database().db, `rollback-${action}`);
    const before = await w.audits(w.task.id);
    const key = randomUUID();
    const spy = vi.spyOn(notifications, 'notifyMessage').mockRejectedValueOnce(new Error('SYN_NOTICE_FAILURE'));
    try {
      expect((await w.batch(action, [w.task], key)).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(await w.tasks()).toEqual([w.task]);
    expect(await w.notices()).toEqual([]);
    expect(await w.audits(w.task.id)).toEqual(before);
    expect((await json(await w.batch(action, [w.task], key))).items[0].ok).toBe(true);
    expect((await json(await w.batch(action, [w.task], key))).items[0].ok).toBe(true);
    expect(await w.notices()).toHaveLength(action === 'remind' ? 1 : 2);
  });

  it('12 / 13 按钮独立授权，重放回执按当前范围复核', async () => {
    const w = await recordsWorld(database().db, 'replay');
    const grants = { scopes: {} as Record<string, typeof EMPTY_SCOPE> };
    const request = w.request(grants);
    const key = randomUUID();
    const body = { items: [{ id: w.task.id, revision: 1 }] };
    expect((await json(await request('POST', `${BASE}/records/remind`, { body, key }))).items[0].ok).toBe(true);
    grants.scopes[RECORD] = EMPTY_SCOPE;
    const replay = await json(await request('POST', `${BASE}/records/remind`, { body, key }));
    expect(replay.items).toEqual([{ id: w.task.id, ok: false, code: 'NOT_FOUND' }]);
    expect(await w.notices()).toHaveLength(1);
    for (const action of ['remind', 'revoke']) {
      const denied = w.request({ deny: (q) => q.action === 'object.button' });
      expect((await denied('POST', `${BASE}/records/${action}`, { body })).status).toBe(403);
    }
  });

  it('15 ESignRecord 仅授予 HR 标准身份，八列含 files', () => {
    const definition = Object.values(MODULE_OBJECTS).find((o) => o.code === RECORD);
    expect(definition).toBeDefined();
    expect(definition!.fields.map((f) => f.code)).toEqual(expect.arrayContaining(COLUMNS));
    for (const profile of STANDARD_PROFILES) {
      const grant = profile.objects.find((o) => o.objectCode === RECORD);
      if (profile.hr) expect(grant?.fields).toContainEqual({ fieldCode: 'files', view: true, edit: false });
      else expect(grant).toBeUndefined();
    }
  });

  it('12 / 13 并发同命令只提醒一次，同 revision 撤销只有一次成功', async () => {
    const w = await recordsWorld(database().db, 'concurrent');
    const key = randomUUID();
    const reminders = await Promise.all([w.batch('remind', [w.task], key), w.batch('remind', [w.task], key)]);
    for (const response of reminders) expect((await json(response)).items).toEqual([{ id: w.task.id, ok: true }]);
    expect(await w.notices()).toHaveLength(1);
    const responses = await Promise.all([w.batch('revoke', [w.task]), w.batch('revoke', [w.task])]);
    const receipts = await Promise.all(responses.map((r) => json(r)));
    expect(receipts.map((r) => r.items[0].ok).sort()).toEqual([false, true]);
    expect(receipts.find((r) => !r.items[0].ok)!.items[0].code).toBe('REVISION_CONFLICT');
    expect(await w.notices()).toHaveLength(3);
  });
});
