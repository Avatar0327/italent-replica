/**
 * R2-T04 BE-5d2 / AC-RT-20c：审批中心范围接线（设计 §11.2，P3）。
 * ① 实例详情对无任职记录范围的管理员不可见；② 只有“使用用户”维度时按 retirement_intentions.initiator_user_id 判断
 * （instanceScopeSql 新分支），他人发起的实例不可见；③ 撤回缺 Employment.RetireIntention 时 403；
 * ④ perBusinessType 下合同 / IDP / Offer 范围不能放行意向实例（落入任职记录默认分支）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { intentionWorld, reasonOf } from './AC-RT-intention-support.js';
import { realUser, setRecordScopeRules } from './AC-RT-intention-real-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const world = (label: string) => intentionWorld(database().db, `${label}-${uniqueSuffix()}`);
const APPROVAL = '/api/tenant/approval';

async function submitted(w: Awaited<ReturnType<typeof world>>) {
  const draft = await w.create({ intendedDate: '2030-03-01' });
  await w.act(draft.id, 'submit');
  return { intention: draft, instance: await w.instance(draft.id) };
}

describe('AC-RT-20c 审批中心范围接线', () => {
  it('① 管理员实例详情按任职记录范围：无范围不可见，有部门范围可见', async () => {
    const w = await world('admin-scope');
    const { instance } = await submitted(w);
    const admin = await realUser(w, '流程管理员', { adminButtons: ['adminTransfer'] });
    expect((await admin.call('GET', `${APPROVAL}/instances/${instance.id}`)).status).toBe(404);
    await admin.setScope([w.deptB]);
    expect((await admin.call('GET', `${APPROVAL}/instances/${instance.id}`)).status).toBe(200);
    await admin.setScope([w.deptA]);
    expect((await admin.call('GET', `${APPROVAL}/instances/${instance.id}`)).status).toBe(404);
  });

  it('② 只有“使用用户”维度：创建人取意向申请自己的发起人——发起人可经审批中心撤回自己的实例，他人不可见', async () => {
    const w = await world('creator');
    await setRecordScopeRules(w, ['using_user']);
    const initiator = await realUser(w, '发起人', { adminButtons: ['adminTransfer'] });
    const stranger = await realUser(w, '旁观管理员', { adminButtons: ['adminTransfer'] });
    const mine = await w.personCreatedBy(initiator.userId, '发起人创建的员工', w.deptB, {
      directManagerId: w.manager.employeeId,
    });
    const created = await initiator.call('POST', `/retirement-intentions/employees/${mine.employeeId}`, {
      ifMatch: await w.revisionOf(mine.employeeId),
      body: { intendedDate: '2030-03-01' },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const intention = (await created.json()) as { id: string; revision: number };
    expect(
      (await initiator.call('POST', `/retirement-intentions/${intention.id}/submit`, { ifMatch: intention.revision }))
        .status,
    ).toBe(200);
    const instance = await w.instance(intention.id, initiator.userId);

    // 他人（不是参与人，只有使用用户维度）看不到；管理员代他人发起的另一张实例，发起人同样看不到
    expect((await stranger.call('GET', `${APPROVAL}/instances/${instance.id}`)).status).toBe(404);
    const other = await submitted(w);
    expect((await initiator.call('GET', `${APPROVAL}/instances/${other.instance.id}`)).status).toBe(404);
    // 发起人自己的实例：instanceScopeSql 的创建人分支取本表发起人，撤回前置（requireWithdrawRight）的范围谓词成立
    const withdrawn = await initiator.call('POST', `${APPROVAL}/instances/${instance.id}/withdraw`, {
      ifMatch: instance.revision,
      body: {},
    });
    expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
    expect((await w.get(intention.id)).status).toBe('withdrawn');
  });

  it('③ 审批中心撤回缺 Employment.RetireIntention 按钮：403，申请与实例不变；恢复按钮后成功', async () => {
    const w = await world('withdraw-button');
    const operator = await realUser(w, '撤回人', { orgIds: [w.deptB] });
    const revision = await w.revisionOf();
    const created = await operator.call('POST', `/retirement-intentions/employees/${w.subject.employeeId}`, {
      ifMatch: revision,
      body: { intendedDate: '2030-03-01' },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const intention = (await created.json()) as { id: string; revision: number };
    expect(
      (await operator.call('POST', `/retirement-intentions/${intention.id}/submit`, { ifMatch: intention.revision }))
        .status,
    ).toBe(200);
    const instance = await w.instance(intention.id, operator.userId);
    await operator.revokeButton();
    const before = await w.footprint(intention.id);
    const denied = await operator.call('POST', `${APPROVAL}/instances/${instance.id}/withdraw`, {
      ifMatch: instance.revision,
      body: {},
    });
    expect(denied.status).toBe(403);
    expect(await w.footprint(intention.id)).toEqual(before);
    expect((await reasonOf(denied)).status).toBe(403);
  });

  it('④ perBusinessType：只有合同范围的管理员看不到意向实例（落入任职记录默认分支，不被合同 / IDP / Offer 范围放行）', async () => {
    const w = await world('per-type');
    const { instance } = await submitted(w);
    // 任职记录范围只有“使用用户”（该管理员不是发起人）；组织范围 [B] 只会放行合同等其他对象，不能放行意向实例
    await setRecordScopeRules(w, ['using_user']);
    const admin = await realUser(w, '合同范围管理员', { adminButtons: ['adminTransfer'], orgIds: [w.deptB] });
    expect((await admin.call('GET', `${APPROVAL}/instances/${instance.id}`)).status).toBe(404);
  });
});
