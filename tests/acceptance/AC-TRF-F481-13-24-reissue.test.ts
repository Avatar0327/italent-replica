import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { STANDARD_PROFILES } from '@italent/domain';
import { AppError } from '@italent/api';
import { describe, expect, it, vi } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import type { Authorizer } from '../../apps/api/src/authorization.js';
import * as contractPort from '../../apps/api/src/modules/transfer/linkage/contract.js';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { rows, SIGN_AT } from './AC-TRF-F481-s2-support.js';
import { BASE, EMPLOYMENT, REISSUE, json, mineWorld, reason, type Receipt } from './AC-TRF-F481-s3a-support.js';

const database = useTestDb();
const receipts = async (r: Response) => (await json<{ items: Receipt[] }>(r)).items;

describe('AC-TRF-F481-13/14/23/24 批量补发', () => {
  it('13②③ 撤销后重新选模板补发，新旧任务独立；签署中拒绝重复；同键重放不新建', async () => {
    const w = await mineWorld(database().db, 'reissue');
    const business = await w.direct();
    const [old] = await w.tasks();
    await w.revoke(old!);
    const key = crypto.randomUUID();
    const first = await receipts(await w.reissue([business.id], { idempotencyKey: key }));
    expect(first).toEqual([
      { id: business.id, ok: true, taskId: expect.any(String), status: 'signing', failureReason: null },
    ]);
    expect(await receipts(await w.reissue([business.id], { idempotencyKey: key }))).toEqual(first);
    expect(await receipts(await w.reissue([business.id]))).toEqual([
      { id: business.id, ok: false, code: 'ESIGN_TASK_IN_PROGRESS' },
    ]);
    const tasks = await w.tasks();
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.id === old!.id)!.status).toBe('revoked');
    expect(tasks.find((t) => t.id === first[0]!.taskId)).toMatchObject({
      origin: 'manual',
      initiatorUserId: w.session.user.id,
    });
    expect((await w.files(first[0]!.taskId!)).map((f) => f.templateId)).toEqual([w.templates[2]!.id]);
    await reason(
      await w.sign(
        w.employeeUser,
        tasks.find((t) => t.id === old!.id)!,
      ),
      'ESIGN_TASK_CLOSED',
    );
    const notices = await json<{ items: { title: string; body: string }[] }>(
      await w.hr('GET', '/api/tenant/approval/notifications'),
    );
    expect(notices.items[0]).toMatchObject({
      title: '电子签署已撤销',
      body: expect.stringContaining('ZZ_F481_EMP_01'),
    });
  });

  it('14 四条混批：成功、离职 NOT_FOUND、未来未生效、范围外 NOT_FOUND；默认空范围拒绝所有条', async () => {
    const w = await mineWorld(database().db, 'mixed');
    const active = await w.direct({ linkage: undefined });
    const futurePerson = await w.hire('ZZ_F481_FUTURE');
    const future = await w.saved(
      await w.transfer(futurePerson, { mode: 'direct', submit: false, effectiveDate: '2026-10-20' }),
    );
    const outside = await w.hire('ZZ_F481_OUTSIDE');
    const outsideTransfer = await w.saved(await w.transfer(outside, { mode: 'direct', submit: false }));
    const leaver = await w.hire('ZZ_F481_LEAVER');
    const leave = await w.session.business(
      leaver.employee.id,
      { kind: 'leave', mode: 'direct', effectiveDate: '2026-10-10', lastWorkDate: '2026-10-09' },
      (await w.session.getEmployee(leaver.employee.id)).revision,
    );
    let scope: ModuleScope = {
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      orgIds: [w.from.id, w.to.id],
      personIds: [w.person.employee.id, futurePerson.employee.id, leaver.employee.id],
      terms: undefined,
    };
    const authorize: Authorizer = (q) => !q.action.startsWith('data.');
    registerScopeProvider(authorize, {
      scope: async () => scope,
      authorize: async (q) => authorize(q),
      fields: async () => new Set(),
    });
    const call = w.restricted(authorize);
    const input = {
      items: [active.id, leave.id, future.id, outsideTransfer.id].map((businessId) => ({ businessId })),
      templateIds: [w.templates[2]!.id],
    };
    const key = crypto.randomUUID();
    const result = await receipts(await call('POST', `${BASE}/transfer-tasks`, { body: input, idempotencyKey: key }));
    expect(result).toEqual([
      { id: active.id, ok: true, taskId: expect.any(String), status: 'signing', failureReason: null },
      { id: leave.id, ok: false, code: 'NOT_FOUND' },
      { id: future.id, ok: false, code: 'ESIGN_TRANSFER_NOT_ACTIVE' },
      { id: outsideTransfer.id, ok: false, code: 'NOT_FOUND' },
    ]);
    expect(JSON.stringify(result)).not.toContain('ZZ_F481');
    scope = EMPTY_SCOPE;
    const replay = await call('POST', `${BASE}/transfer-tasks`, { body: input, idempotencyKey: key });
    expect(replay.status).toBe(404);
    expect(await receipts(await call('POST', `${BASE}/transfer-tasks`, { body: input }))).toEqual(
      input.items.map((i) => ({ id: i.businessId, ok: false, code: 'NOT_FOUND' })),
    );
    expect(await w.tasks()).toHaveLength(1);
  });

  it('14 批量和模板边界：空集/51条/重复/未知键/null 拒绝，50条可返回逐条回执，模板不可用整批400', async () => {
    const w = await mineWorld(database().db, 'bounds');
    const business = await w.direct({ linkage: undefined });
    const valid = { items: [{ businessId: business.id }], templateIds: [w.templates[0]!.id] };
    for (const body of [
      { ...valid, items: [] },
      { ...valid, items: [valid.items[0], valid.items[0]] },
      { ...valid, templateIds: [] },
      { ...valid, templateIds: null },
      { ...valid, templateIds: Array.from({ length: 21 }, () => crypto.randomUUID()) },
      { ...valid, templateIds: [w.templates[0]!.id, w.templates[0]!.id.toUpperCase()] },
      { items: valid.items },
      { ...valid, employeeId: null },
      { ...valid, items: [{ businessId: business.id, employeeId: w.person.employee.id }] },
    ])
      expect((await w.hr('POST', '/transfer-tasks', { body })).status).toBe(400);
    await reason(await w.reissue(Array.from({ length: 51 }, () => crypto.randomUUID())), 'BATCH_LIMIT_EXCEEDED', 400);
    expect(await receipts(await w.reissue(Array.from({ length: 50 }, () => crypto.randomUUID())))).toHaveLength(50);
    await w.call('PATCH', `/templates/${w.templates[0]!.id}`, { ifMatch: 1, body: { status: 'disabled' } });
    await reason(await w.hr('POST', '/transfer-tasks', { body: valid }), 'ESIGN_TEMPLATE_UNAVAILABLE', 400);
    expect(await w.tasks()).toEqual([]);
    const denial = w.restricted((q) => !q.resource?.includes(REISSUE));
    expect(
      (await denial('POST', `${BASE}/transfer-tasks`, { body: { ...valid, templateIds: [w.templates[2]!.id] } }))
        .status,
    ).toBe(403);
    expect(await w.tasks()).toEqual([]);
  });

  it('14 无账号写 failed 回执，不影响其他条；删除、非调动和不存在统一 NOT_FOUND', async () => {
    const w = await mineWorld(database().db, 'failed');
    const business = await w.direct({ linkage: undefined });
    await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`UPDATE tenant_memberships SET status='revoked'
      WHERE tenant_id=${w.tenantId} AND user_id=${w.employeeUser}::uuid`),
    );
    const result = await receipts(await w.reissue([business.id, w.person.hire.id, crypto.randomUUID()]));
    expect(result[0]).toMatchObject({ ok: true, status: 'failed', failureReason: 'EMPLOYEE_NO_ACCOUNT' });
    expect(result.slice(1).map((i) => i.code)).toEqual(['NOT_FOUND', 'NOT_FOUND']);
    expect(await w.notices()).toEqual([]);
    await w.session.request('DELETE', `/businesses/${business.id}`, {
      ifMatch: (await w.business(business.id)).revision,
    });
    expect(await receipts(await w.reissue([business.id]))).toEqual([{ id: business.id, ok: false, code: 'NOT_FOUND' }]);
  });

  it('23 R 仅补发授权能取模板并补发；N 都无权；仅 HR 发起不能补发；停用和跨租户模板不出', async () => {
    const w = await mineWorld(database().db, 'options');
    const business = await w.direct({ linkage: undefined });
    await w.call('PATCH', `/templates/${w.templates[1]!.id}`, { ifMatch: 1, body: { status: 'disabled' } });
    const r = w.restricted(
      (q) =>
        q.action === 'data.scope.all' ||
        (q.action === 'object.update' && q.resource === EMPLOYMENT) ||
        (q.action === 'object.button' && q.resource?.includes(REISSUE) === true),
    );
    const options = await json<{ items: { id: string; name: string }[] }>(
      await r('GET', `${BASE}/template-options/reissue`),
    );
    expect(options.items).toEqual([w.templates[0], w.templates[2]].map((t) => ({ id: t!.id, name: t!.name })));
    expect(
      (
        await receipts(
          await r('POST', `${BASE}/transfer-tasks`, {
            body: { items: [{ businessId: business.id }], templateIds: [options.items[0]!.id] },
          }),
        )
      )[0]!.ok,
    ).toBe(true);
    for (const path of ['/template-options/transfer-form', '/templates'])
      expect((await r('GET', `${BASE}${path}`)).status).toBe(403);
    expect(
      (await r('POST', `/api/tenant/employment/transfers/employees/${w.person.employee.id}`, { body: {}, ifMatch: 1 }))
        .status,
    ).toBe(403);
    const n = w.restricted(() => false);
    for (const path of ['/template-options/transfer-form', '/template-options/reissue'])
      expect((await n('GET', `${BASE}${path}`)).status).toBe(403);
    const onlyHr = w.restricted((q) => q.action === 'object.create' || q.resource?.includes('Transfer.Hr') === true);
    expect((await onlyHr('GET', `${BASE}/template-options/transfer-form`)).status).toBe(200);
    expect((await onlyHr('GET', `${BASE}/template-options/reissue`)).status).toBe(403);
    const other = await mineWorld(w.db, 'foreign-options');
    expect(JSON.stringify(await json(await other.hr('GET', '/template-options/reissue')))).not.toContain(
      w.templates[0]!.id,
    );
  });

  it('23 标准身份仅 HR 类预置 MulLaunchESignTranfer(list/update)', () => {
    const holders = STANDARD_PROFILES.filter((p) =>
      p.objects.some(
        (o) => o.objectCode === EMPLOYMENT && o.buttons.some((b) => b.buttonCode === REISSUE && b.level === 'list'),
      ),
    ).map((p) => p.code);
    expect(holders).toEqual(['standard_org_system_admin', 'standard_hr_admin', 'standard_hr_specialist']);
  });

  it('24 一批六种生效事实：无联动与已执行成功；未来/审批中/驳回/联动失败拒绝；重试生效后可补发', async () => {
    const w = await mineWorld(database().db, 'in-force');
    const empty = await w.direct({ linkage: undefined });
    const activePerson = await w.hire('ZZ_F481_ACTIVE');
    const linked = await w.saved(
      await w.transfer(activePerson, { mode: 'direct', submit: false, linkage: { adjustSalary: true } }),
    );
    const futurePerson = await w.hire('ZZ_F481_FUTURE');
    const future = await w.saved(
      await w.transfer(futurePerson, { mode: 'direct', submit: false, effectiveDate: '2026-10-20' }),
    );
    const pendingPerson = await w.hire('ZZ_F481_PENDING');
    const pending = await w.saved(await w.transfer(pendingPerson, {}));
    const rejectedPerson = await w.hire('ZZ_F481_REJECTED');
    const rejected = await w.saved(await w.transfer(rejectedPerson, {}));
    await runEmploymentTransition(
      w.db,
      { ...w.ctx(), expectedRevision: rejected.revision },
      { id: rejected.id, action: 'reject' },
    );
    const failedPerson = await w.hire('ZZ_F481_FAILED');
    const contract = await w.contract(failedPerson.employee.id);
    const failed = await w.saved(
      await w.transfer(failedPerson, {
        linkage: { contract: { targetId: contract.id, fields: { endDate: '2029-10-09' } } },
      }),
    );
    await w.approve(failed, '2026-10-07T01:00:00Z');
    const spy = vi
      .spyOn(contractPort, 'changeContractOnActivation')
      .mockRejectedValueOnce(new AppError('CONFLICT', '合成合同冲突'));
    try {
      expect((await w.runScheduler(SIGN_AT)).failed).toContain(failed.id);
    } finally {
      spy.mockRestore();
    }
    await withTenant(w.db, w.tenantId, async (tx) => {
      expect(
        rows(
          await tx.execute(
            sql`SELECT 1 FROM transfer_linkage_runs WHERE tenant_id=${w.tenantId} AND business_id=${empty.id}::uuid`,
          ),
        ),
      ).toEqual([]);
      expect(
        rows(
          await tx.execute(
            sql`SELECT 1 FROM transfer_linkage_runs WHERE tenant_id=${w.tenantId} AND business_id=${linked.id}::uuid`,
          ),
        ),
      ).toHaveLength(1);
    });
    const result = await receipts(
      await w.reissue([empty.id, linked.id, future.id, pending.id, rejected.id, failed.id]),
    );
    expect(result.map((i) => (i.ok ? i.status : i.code))).toEqual([
      'signing',
      'signing',
      ...Array(4).fill('ESIGN_TRANSFER_NOT_ACTIVE'),
    ]);
    expect((await w.retry(failed, SIGN_AT)).status).toBe(200);
    expect((await receipts(await w.reissue([failed.id])))[0]).toMatchObject({ ok: true, status: 'signing' });
  });

  it('09/13 并发补发只产生一个在途任务；同键异内容冲突；撤按钮后旧命令不给回执', async () => {
    const w = await mineWorld(database().db, 'batch-replay');
    const b = await w.direct({ linkage: undefined });
    const results = await Promise.all([w.reissue([b.id]), w.reissue([b.id])]);
    const items = (await Promise.all(results.map(receipts))).flat();
    expect(items.filter((i) => i.ok)).toHaveLength(1);
    expect(items.find((i) => !i.ok)!.code).toBe('ESIGN_TASK_IN_PROGRESS');
    expect(await w.tasks()).toHaveLength(1);
    await w.revoke((await w.tasks())[0]!);
    const key = crypto.randomUUID();
    await receipts(await w.reissue([b.id], { idempotencyKey: key }));
    await reason(await w.reissue([crypto.randomUUID()], { idempotencyKey: key }), 'IDEMPOTENCY_CONFLICT');
    const denied = w.restricted((q) => !q.resource?.includes(REISSUE));
    expect(
      (
        await denied('POST', `${BASE}/transfer-tasks`, {
          idempotencyKey: key,
          body: { items: [{ businessId: b.id }], templateIds: [w.templates[2]!.id] },
        })
      ).status,
    ).toBe(403);
  });
});
