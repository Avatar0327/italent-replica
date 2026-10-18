/**
 * BE-15b1 第 3 轮审查返工（#415）P2-1（续），真实授权器（authorize: undefined）：考核对象的实体数据范围规则含“使用用户”
 * （创建人维度）时，列表 / 详情 / 修改 / 审批中心重提共用的范围谓词不能因 SQL 别名遮蔽整体 500（PostgreSQL 42703）。
 * - 员工主档的创建人（使用用户）：能列出、查看、修改、重提考核，同键重放照常；
 * - 只做过旁观 / 发起、不是员工创建人的经办人：员工调离其管理范围后，列表看不到，详情 / 修改 / 重提与不存在同为 404。
 * 规则分两组：只配使用用户；管理单元 ∪ 使用用户。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { realOperator, setAssessmentScopeRules } from './AC-PB-BE15b1-real-support.js';
import { assessmentWorld, type AssessmentView, type LaunchReceipt } from './AC-PB-BE15b1-support.js';

const testDb = useTestDb();
const MISSING = '00000000-0000-4000-8000-000000000001';

const RULE_SETS = [
  { name: '只配使用用户', rules: ['using_user'], union: false },
  { name: '管理单元 ∪ 使用用户', rules: ['management', 'using_user'], union: true },
] as const;

const ids = async (response: Response) =>
  ((await response.json()) as { items: { id: string }[] }).items.map((item) => item.id);

describe.each(RULE_SETS)('使用用户范围的考核办理（$name）', ({ name, rules, union }) => {
  const label = union ? 'union' : 'user';

  async function setup(suffix: string) {
    const w = await assessmentWorld(testDb().db, `r4-${label}-${suffix}`);
    const creator = await realOperator(w);
    const bystander = await realOperator(w, { orgIds: [w.department] });
    await setAssessmentScopeRules(w, rules);
    const person = await w.probationer('使用用户员工', { createdBy: creator.userId });
    return { w, creator, bystander, person };
  }

  it(`${name}：员工创建人能列出 / 查看 / 修改，旁观经办人 404`, async () => {
    const { w, creator, bystander, person } = await setup('crud');
    const id = await w.launch('probation', person);
    await w.complete(id, person, { managerRating: 'meets', regularizationOpinion: 'normal' });
    if (union) {
      // 调动前：旁观经办人按管理单元（原部门）也能看到
      const before = await bystander.call('GET', '/probation-assessments');
      expect(before.status, await before.clone().text()).toBe(200);
      expect(await ids(before)).toEqual([id]);
    }
    const other = await w.org(`调入部门-${label}`);
    const moved = await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${person.employeeId}/businesses`, {
      ifMatch: await w.employeeRevision(person.employeeId),
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-01', fields: { departmentId: other } },
    });
    expect(moved.status, await moved.clone().text()).toBe(201);

    const listed = await creator.call('GET', '/probation-assessments');
    expect(listed.status, await listed.clone().text()).toBe(200);
    expect(await ids(listed)).toEqual([id]);
    const detail = await creator.call('GET', `/probation-assessments/${id}`);
    expect(detail.status, await detail.clone().text()).toBe(200);
    const current = (await detail.json()) as AssessmentView;
    const patched = await creator.call('PATCH', `/probation-assessments/${id}`, {
      ifMatch: current.revision,
      body: { managerRating: 'exceeds' },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect((await w.get(id)).managerRating).toBe('exceeds');

    // 旁观经办人：不是员工创建人，员工已调离其管理范围
    const hiddenList = await bystander.call('GET', '/probation-assessments');
    expect(hiddenList.status, await hiddenList.clone().text()).toBe(200);
    expect(await ids(hiddenList)).toEqual([]);
    const after = await w.get(id);
    const hidden = await bystander.call('GET', `/probation-assessments/${id}`);
    const missing = await bystander.call('GET', `/probation-assessments/${MISSING}`);
    expect(hidden.status, await hidden.clone().text()).toBe(404);
    expect(await hidden.json()).toEqual(await missing.json());
    const denied = await bystander.call('PATCH', `/probation-assessments/${id}`, {
      ifMatch: after.revision,
      body: { managerRating: 'below' },
    });
    expect(denied.status, await denied.clone().text()).toBe(404);
    expect(await w.get(id)).toEqual(after);
  });

  it(`${name}：员工创建人经审批中心重提，同键重放照常`, async () => {
    const { w, creator, person } = await setup('resubmit');
    w.asInitiator(creator.userId);
    const launched = await creator.call('POST', '/probation-assessments', {
      body: {
        assessmentType: 'probation',
        assessmentName: '使用用户考核',
        assessmentDate: '2026-10-01',
        items: [{ employeeId: person.employeeId, revision: await w.employeeRevision(person.employeeId) }],
      },
    });
    expect(launched.status, await launched.clone().text()).toBe(200);
    const receipt = (await launched.json()) as LaunchReceipt;
    expect(receipt.items[0], JSON.stringify(receipt)).toMatchObject({ status: 'succeeded' });
    const id = receipt.items[0]!.assessmentId!;
    await w.decide(id, person, 'approve', { selfEvaluation: '自评' });
    await w.decide(id, w.manager, 'reject');
    expect((await w.get(id)).status).toBe('rejected');
    const view = await w.instance(id);
    const resubmit = () =>
      creator.call('POST', `/api/tenant/approval/instances/${view.id}/resubmit`, {
        ifMatch: view.revision,
        key: `resubmit-${id}`,
        body: {
          fields: { managerRating: 'exceeds', regularizationOpinion: 'early', regularizationDate: '2026-10-15' },
        },
      });
    const first = await resubmit();
    expect(first.status, await first.clone().text()).toBe(200);
    expect((await w.get(id)).status).toBe('in_review');
    const replay = await resubmit();
    expect(replay.status, await replay.clone().text()).toBe(200);
  });

  it.runIf(union)(`${name}：只因管理单元发起过考核的经办人，范围收回后重提 404`, async () => {
    const { w, bystander, person } = await setup('resubmit-out');
    w.asInitiator(bystander.userId);
    const launched = await bystander.call('POST', '/probation-assessments', {
      body: {
        assessmentType: 'probation',
        assessmentName: '旁观经办人发起',
        assessmentDate: '2026-10-01',
        items: [{ employeeId: person.employeeId, revision: await w.employeeRevision(person.employeeId) }],
      },
    });
    expect(launched.status, await launched.clone().text()).toBe(200);
    const id = ((await launched.json()) as LaunchReceipt).items[0]!.assessmentId!;
    await w.decide(id, person, 'approve', { selfEvaluation: '自评' });
    await w.decide(id, w.manager, 'reject');
    const view = await w.instance(id);
    await bystander.setScope([await w.org(`无关部门-${label}`)]);
    const denied = await bystander.call('POST', `/api/tenant/approval/instances/${view.id}/resubmit`, {
      ifMatch: view.revision,
      body: { fields: { managerRating: 'exceeds' } },
    });
    expect(denied.status, await denied.clone().text()).toBe(404);
    expect((await w.get(id)).status).toBe('rejected');
  });
});
