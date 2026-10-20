/**
 * R2-T04 BE-5d2 第 1 轮审查返工（#456）：审批中心经适配器进入的复核统一入口（DEC-431①）与相关回归。
 * ① 重提按实际修正字段复核编辑权（与 HR 直接修改同口径）；② HR 改已驳回申请时关联实例版本同事务刷新，旧页面 409；
 * ③ 创建按“即将写入的部门 / 员工 / 本单发起人”三坐标授权，不用员工主档创建人。被拒时完整快照（申请行、实例、任务、日志、审计、台账）逐项相等。
 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { intentionWorld, reasonOf, type IntentionWorld } from './AC-RT-intention-support.js';
import { realUser, setRecordScopeRules } from './AC-RT-intention-real-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const world = (label: string) => intentionWorld(database().db, `${label}-${uniqueSuffix()}`);
const APPROVAL = '/api/tenant/approval';

type Operator = Awaited<ReturnType<typeof realUser>>;

/** 操作人创建并提交，经理驳回：申请 rejected，实例 returned。 */
async function rejectedBy(w: IntentionWorld, operator: Operator) {
  const created = await operator.call('POST', `/retirement-intentions/employees/${w.subject.employeeId}`, {
    ifMatch: await w.revisionOf(),
    body: { intendedDate: '2030-03-01', reason: '原始原因' },
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const intention = (await created.json()) as { id: string; revision: number };
  expect(
    (await operator.call('POST', `/retirement-intentions/${intention.id}/submit`, { ifMatch: intention.revision }))
      .status,
  ).toBe(200);
  await w.decide(intention.id, 'reject', w.manager, operator.userId);
  expect((await w.get(intention.id)).status).toBe('rejected');
  return { id: intention.id, instance: await w.instance(intention.id, operator.userId) };
}

describe('AC-RT-20d 审批中心重提按实际修正字段复核（P1-1）', () => {
  it('收回 intendedDate 编辑权：PATCH 与审批中心重提都 403，完整快照不变；仍可编辑的字段重提成功', async () => {
    const w = await world('resubmit-fields');
    const operator = await realUser(w, 'HR操作人', { orgIds: [w.deptB] });
    const { id, instance } = await rejectedBy(w, operator);
    await operator.revokeFieldEdit('intendedDate');

    const before = await w.footprint(id);
    const current = await w.get(id);
    const patched = await operator.call('PATCH', `/retirement-intentions/${id}`, {
      ifMatch: current.revision,
      body: { intendedDate: '2030-05-01' },
    });
    expect(patched.status, await patched.clone().text()).toBe(403);
    const resubmitted = await operator.call('POST', `${APPROVAL}/instances/${instance.id}/resubmit`, {
      ifMatch: instance.revision,
      body: { fields: { intendedDate: '2030-05-01' } },
    });
    expect(resubmitted.status, await resubmitted.clone().text()).toBe(403);
    expect(await w.footprint(id)).toEqual(before);
    expect(await w.get(id)).toMatchObject({ intendedDate: '2030-03-01', status: 'rejected' });

    // 对照：只改仍有编辑权的字段（原因）可重提，且保存的就是修正内容
    const ok = await operator.call('POST', `${APPROVAL}/instances/${instance.id}/resubmit`, {
      ifMatch: instance.revision,
      body: { fields: { reason: '补充说明' } },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await w.get(id)).toMatchObject({ status: 'in_review', reason: '补充说明', intendedDate: '2030-03-01' });
  });
});

describe('AC-RT-20d HR 改已驳回申请：关联实例版本同事务刷新（P2-3）', () => {
  it('旧审批页面（修改前的实例 revision）重提 409，新内容保留；刷新后可重提', async () => {
    const w = await world('stale-resubmit');
    const draft = await w.create({ intendedDate: '2030-03-01', reason: '原始原因' });
    await w.act(draft.id, 'submit');
    await w.decide(draft.id, 'reject');
    const stale = await w.instance(draft.id);
    expect(stale.status).toBe('returned');

    const edited = await w.patchRaw(draft.id, (await w.get(draft.id)).revision, { reason: '新原因' });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const refreshed = await w.instance(draft.id);
    expect(refreshed.revision).toBeGreaterThan(stale.revision);

    const before = await w.footprint(draft.id);
    const rejected = await w.instanceAction(w.hr.id, stale.id, 'resubmit', stale.revision, {
      fields: { reason: '旧原因' },
    });
    expect(rejected.status, await rejected.clone().text()).toBe(409);
    expect(await w.footprint(draft.id)).toEqual(before);
    expect(await w.get(draft.id)).toMatchObject({ reason: '新原因', status: 'rejected' });

    const ok = await w.instanceAction(w.hr.id, refreshed.id, 'resubmit', refreshed.revision, {});
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await w.get(draft.id)).toMatchObject({ reason: '新原因', status: 'in_review' });
  });
});

describe('AC-RT-20d 创建按三坐标授权（P2-4）', () => {
  it('“使用用户”维度：员工由别人创建、本申请由自己发起 → 成功，发起人 = 自己，自己可读可写', async () => {
    const w = await world('create-using-user');
    await setRecordScopeRules(w, ['using_user']);
    const operator = await realUser(w, '使用用户HR');
    const created = await operator.call('POST', `/retirement-intentions/employees/${w.subject.employeeId}`, {
      ifMatch: await w.revisionOf(),
      body: { intendedDate: '2030-03-01' },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const intention = (await created.json()) as { id: string; revision: number };
    const [stored] = await w.rows<{ initiator_user_id: string }>(
      sql`SELECT initiator_user_id::text FROM retirement_intentions WHERE tenant_id=${w.tenant.id}
        AND id=${intention.id}::uuid`,
    );
    expect(stored!.initiator_user_id).toBe(operator.userId);
    expect((await operator.call('GET', `/retirement-intentions/${intention.id}`)).status).toBe(200);
    const patched = await operator.call('PATCH', `/retirement-intentions/${intention.id}`, {
      ifMatch: intention.revision,
      body: { reason: '本人改' },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
  });

  it('组织范围外仍 404 且不写入：快照部门 B 不在范围 [A]', async () => {
    const w = await world('create-out-of-scope');
    const operator = await realUser(w, '部门A的HR', { orgIds: [w.deptA] });
    const before = await w.list();
    const response = await operator.call('POST', `/retirement-intentions/employees/${w.subject.employeeId}`, {
      ifMatch: await w.revisionOf(),
      body: { intendedDate: '2030-03-01' },
    });
    expect(await reasonOf(response)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(await w.list()).toEqual(before);
    const [count] = await w.rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM retirement_intentions WHERE tenant_id=${w.tenant.id}`,
    );
    expect(count!.n).toBe(0);
  });
});
