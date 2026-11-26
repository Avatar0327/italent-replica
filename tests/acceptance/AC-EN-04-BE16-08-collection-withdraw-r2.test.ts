/**
 * AC-EN-04（16a-2c）第 2 轮审查回归：撤回后的审批披露、曾入职判定、授权绑定取消版本、履历同步与详情动作。
 * 夹具与桩见 AC-EN-BE16-08-support.ts；数据全部 ZZ_BE16_* 合成。
 */
import { sql } from '@italent/db';
import { expect, it } from 'vitest';
import { saveDraft, submit } from '../../apps/api/src/modules/onboarding/collection-submit.js';
import { saveSubset } from '../../apps/api/src/modules/personnel/subsets.js';
import { businessRevision } from './AC-EN-BE2a-support.js';
import { identityAt, liveCount, publishApproval, submitted, world, type World } from './AC-EN-BE16-08-support.js';

const school = 'ZZ_BE16_SCHOOL';
const collection = (id: string) => `/api/tenant/onboarding/entries/${id}/collection`;
const json = async (res: Response, status = 200) => {
  expect(res.status, await res.clone().text()).toBe(status);
  return res.json();
};

async function submitForReview(x: World) {
  const before = await x.person();
  const values = {
    profileRevision: Number(before?.revision ?? 0),
    profile: { name: 'ZZ_BE16_COLLECTED' },
    subsets: [{ kind: 'education', revision: 0, values: { school } }],
  };
  await x.tenant((tx) => submit(tx, x.expected(1), { ...x.ref, taskId: x.taskId }, values));
}

// 注意：本文件只有“履历同步开关”相关用例会调用 submitted()（把全库开关打开），曾入职用例必须排在它之前。
it('AC-EN-04 r2-3 离职后以 hire 开新周期的人，履历同步开关关闭时也不能被撤回清档', async () => {
  const x = await world('hireAgain');
  const [setting] = await x.query(sql`SELECT value FROM system_settings WHERE key='EntrySyncJobHistory'`);
  expect(setting?.value ?? false).not.toBe(true);
  await x.tenant((tx) => saveSubset(tx, x.expected(0), x.employee.id, 'education', { school: 'ZZ_BE16_OLD_SCHOOL' }));
  const profileRevision = Number((await x.person())!.revision);
  await x.tenant((tx) =>
    saveDraft(tx, x.expected(1), { ...x.ref, taskId: x.taskId }, { profileRevision, profile: {}, subsets: [] }),
  );
  await x.cancel();
  const before = await x.person();
  await expect(x.withdraw()).rejects.toMatchObject({ details: { reason: 'COLLECTION_WITHDRAW_REHIRE' } });
  expect(await x.person()).toEqual(before);
  expect(await liveCount(x, 'personnel_education')).toBe(1);
  expect((await x.state()).task.status).not.toBe('withdrawn');
});

it('AC-EN-04 r2-1 撤回后审批已办详情与冻结办理份不再披露曾提交值，历史版本保留', async () => {
  const x = await world('hire', true);
  const a = await publishApproval(x);
  await submitForReview(x);
  const active = await x.state();
  const [instance] = active.instances;
  const [work] = active.approvalWork;
  await json(await a.decide(work!.id, instance!.revision, 'reject'));
  expect((await a.detail(instance!.id)).status).toBe(200);
  await x.cancel();
  expect(await (await a.detail(instance!.id)).text()).toContain(school);
  await x.withdraw();
  const after = await a.detail(instance!.id);
  expect(after.status, await after.clone().text()).toBe(200);
  expect(await after.text()).not.toContain(school);
  const { submissions, task } = await x.state();
  expect(task.status).toBe('withdrawn');
  expect(JSON.stringify(submissions.map((row) => row.values))).toContain(school);
});

it('AC-EN-04 r2-1b 审批在办时取消并撤回，迟到的办理被拒为 APPROVAL_TASK_CLOSED，人员 / 采集 / 审批状态不变', async () => {
  const x = await world('hire', true);
  const a = await publishApproval(x);
  await submitForReview(x);
  // 不驳回：采集审批保持在办，取消与撤回由系统自己关闭
  const open = await x.state();
  expect(open.instances).toHaveLength(1);
  expect(open.instances[0]).toMatchObject({ status: 'running' });
  const [work] = open.approvalWork;
  expect(work).toMatchObject({ status: 'pending' });
  await x.cancel();
  await x.withdraw();
  const settled = await x.state();
  expect(settled.task.status).toBe('withdrawn');
  const [instance] = settled.instances;
  expect(instance!.status).not.toBe('running');
  const [closedWork] = settled.approvalWork;
  expect(closedWork).toMatchObject({ id: work!.id });
  expect(closedWork!.status).not.toBe('pending');
  const snapshot = async () => ({
    person: await x.person(),
    ...(await x.state()),
    education: await liveCount(x, 'personnel_education'),
  });
  const before = await snapshot();
  // 取最新实例修订发起办理：先过修订校验，才会落到 approval/actions.ts:92 assertOpen 的关闭判定
  const late = await a.decide(work!.id, instance!.revision, 'approve');
  expect(late.status, await late.clone().text()).toBe(409);
  expect(await late.json()).toMatchObject({ error: { details: { reason: 'APPROVAL_TASK_CLOSED' } } });
  expect(await snapshot()).toEqual(before);
  expect(before.education).toBe(0);
});

it('AC-EN-04 r2-4 改期恢复后再次取消，签发于第一次取消的撤回授权被拒，新授权可用且单次', async () => {
  const x = await world();
  await submitted(x);
  await x.cancel();
  const old = await x.issue();
  await x.restore();
  await x.cancel();
  const before = await x.person();
  await expect(x.withdraw(old)).rejects.toMatchObject({
    code: 'FORBIDDEN',
    details: { reason: 'COLLECTION_WITHDRAW_GRANT_STALE' },
  });
  expect(await x.person()).toEqual(before);
  expect((await x.state()).task.status).not.toBe('withdrawn');
  // 绑定别的候选人 / 任务的授权同样被拒
  const wrong = identityAt(x.recordId, await businessRevision(x.w, x.recordId), { taskId: 'ZZ_BE16_OTHER_TASK' });
  await expect(x.withdraw(wrong)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(await x.withdraw()).toMatchObject({ status: 'withdrawn' });
  await expect(x.withdraw()).rejects.toMatchObject({ details: { reason: 'COLLECTION_ALREADY_WITHDRAWN' } });
});

it('AC-EN-04 r2-6 撤回履历投影后编辑原（已取消）任职记录不报 500，履历仍保持撤回', async () => {
  const x = await world();
  await submitted(x);
  await x.cancel();
  await x.withdraw();
  expect(await liveCount(x, 'personnel_job_history')).toBe(0);
  const edit = async (place: string) =>
    x.w.session.request('PATCH', `/records/${x.recordId}`, {
      ifMatch: await businessRevision(x.w, x.recordId),
      body: { fields: { place } },
    });
  const cancelled = await edit('ZZ_BE16_PLACE_1');
  expect(cancelled.status, await cancelled.clone().text()).toBe(200);
  expect(await liveCount(x, 'personnel_job_history')).toBe(0);
});

it('AC-EN-04 r2-7 撤回后恢复待入职，采集详情给出发起动作，且与发起接口实际能力一致', async () => {
  const x = await world();
  const profileRevision = Number((await x.person())!.revision);
  await x.tenant((tx) =>
    saveDraft(tx, x.expected(1), { ...x.ref, taskId: x.taskId }, { profileRevision, profile: {}, subsets: [] }),
  );
  await x.cancel();
  await x.withdraw();
  await x.restore();
  const detail = await json(await x.request('GET', collection(x.recordId)));
  expect(detail.task).toMatchObject({ status: 'withdrawn' });
  expect(detail.availableActions).toHaveLength(1);
  const started = await x.request('POST', collection(x.recordId) + '/start', {
    ifMatch: 0, // 终态任务重新发起按“无在办任务”校验，期望修订为 0（同 startCollection）
    body: {
      businessId: x.recordId,
      businessRevision: detail.businessRevision,
      caseRevision: detail.caseRevision,
    },
  });
  expect(started.status, await started.clone().text()).toBe(201);
  expect(await started.json()).toMatchObject({ status: 'ready' });
});
