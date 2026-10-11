/**
 * R3-T02 PR-B B5：编辑锁 EV-R14 / AC-EV-05（规格 24 EV-R14、补充“AC-EV-05 原站表现”；设计 §3.2）。
 * `apply_count > 0`（已有报名）时只许改：名称、所属组织、年度、周期、负责人、起止日期、申请人、可申报级别（跨级限制）、
 * 参评条件（B6）、环节的名称 / 日期 / 顺序 / 流程 / 转入方式 / 通知；增删环节、改适用范围 / 类型 / 材料模板等其余内容 → 409
 * ACTIVITY_HAS_APPLICANTS，数据不变。原样提交不算改动；校验类错误（如清空资格审批流程）仍是 400。`apply_count` 只读，
 * 测试直接置数（真实维护在 C2）。未报名时可改全部内容、增删环节。删除活动：只有草稿且没有报名的才能删（保守默认，需取证）。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { errorOf, ok } from './AC-EV-support.js';
import {
  ACTIVITIES,
  type ActivityFixtures,
  activityFixtures,
  type ActivityOperator,
  type ActivityOperatorOptions,
  activityOperator,
  type ActivityView,
  activityWorld,
  type ActivityWorld,
  type ChainView,
  sendableChain,
} from './AC-EV-activity-support.js';

const testDb = useTestDb();
const suffix = () => randomUUID().slice(0, 6);

describe('AC-EV-05 编辑锁（已有报名的活动）', () => {
  let w: ActivityWorld;
  let f: ActivityFixtures;
  beforeAll(async () => {
    w = (await activityWorld(testDb().db)) as ActivityWorld;
    f = await activityFixtures(w);
  });
  const manager = (options: ActivityOperatorOptions = {}) =>
    activityOperator(w, { evOrgs: [w.orgA, w.orgC], personOrgs: [w.orgA], ...options });
  const patch = (op: ActivityOperator, activity: ActivityView, data: Record<string, unknown>) =>
    op.request('PATCH', `${ACTIVITIES}/${activity.id}`, { ifMatch: activity.revision, body: data });
  const expectError = async (response: Response, status: number, reason?: string) => {
    expect(response.status, await response.clone().text()).toBe(status);
    if (reason) expect((await errorOf(response)).reason).toBe(reason);
  };
  /** 带 N 个报名的草稿活动（管理员建，库里置数）。 */
  async function withApplicants(count = 1, extra: Record<string, unknown> = {}) {
    const activity = await w.adminActivity(f.body({ categoryIds: [(await w.qlCategory()).id], ...extra }));
    await w.setApplyCount(activity.id, count);
    return w.adminRead(activity.id);
  }
  const chainsWith = (activity: ActivityView, type: ChainView['type'], change: Record<string, unknown>) =>
    activity.chains.map((chain) => ({ ...sendableChain(chain), ...(chain.type === type ? change : {}) }));
  const unchanged = async (before: ActivityView) => expect(await w.adminRead(before.id)).toEqual(before);

  it('删环节 409，改日期 200；前后读对比：409 不改动任何数据，200 只改了日期', async () => {
    const op = await manager();
    const activity = await withApplicants();
    const without = activity.chains.filter((chain) => chain.type !== 'material').map(sendableChain);
    await expectError(await patch(op, activity, { chains: without }), 409, 'ACTIVITY_HAS_APPLICANTS');
    await unchanged(activity);
    const moved = await ok<ActivityView>(
      await patch(op, activity, { chains: chainsWith(activity, 'apply', { endDate: '2026-03-30' }) }),
    );
    expect(moved.chains.find((chain) => chain.type === 'apply')!.endDate).toBe('2026-03-30');
    expect(moved.chains.map((chain) => chain.id)).toEqual(activity.chains.map((chain) => chain.id));
    expect(moved.chains.filter((chain) => chain.type !== 'apply')).toEqual(
      activity.chains.filter((chain) => chain.type !== 'apply'),
    );
    expect(moved).toMatchObject({ revision: activity.revision + 1, applyCount: 1, status: 'draft' });
  });

  it('增环节 409（没有答辩环节的活动补一个答辩）', async () => {
    const op = await manager();
    const activity = await withApplicants(2, { chains: [f.chains()[0], f.chains()[3]] });
    const added = [...activity.chains.map(sendableChain)];
    added.splice(1, 0, f.chains()[2]!);
    await expectError(await patch(op, activity, { chains: added }), 409, 'ACTIVITY_HAS_APPLICANTS');
    await unchanged(activity);
  });

  type Change = (activity: ActivityView) => Record<string, unknown> | Promise<Record<string, unknown>>;
  const allowed: readonly [string, Change][] = [
    ['名称', () => ({ name: `新名称${suffix()}` })],
    ['所属组织', () => ({ ownerOrgId: w.orgC })],
    ['年度', () => ({ year: 2027 })],
    ['周期', async () => ({ cycleId: (await w.activityCycle()).id })],
    ['负责人', async () => ({ managerEmployeeId: (await w.hire('新负责人', w.orgA)).id })],
    ['起止日期', () => ({ startDate: '2025-12-01', endDate: '2027-01-31' })],
    ['申请人', () => ({ applicants: ['others'] })],
    ['可申报级别（跨级限制）', () => ({ maxLevelJump: 3 })],
    ['环节名称', (a) => ({ chains: chainsWith(a, 'defense', { name: '终审' }) })],
    ['环节流程', (a) => ({ chains: chainsWith(a, 'apply', { approvalProcessCode: 'QUAL_APPLY_V2' }) })],
    ['环节转入方式', (a) => ({ chains: chainsWith(a, 'material', { transferMode: 'manual' }) })],
    ['环节通知', (a) => ({ chains: chainsWith(a, 'result', { noticeTemplateCode: 'TPL_RESULT' }) })],
    [
      '环节顺序（材料与答辩对调）',
      (a) => {
        const list = a.chains.map(sendableChain);
        return { chains: [list[0], list[2], list[1], list[3]] };
      },
    ],
  ];
  it.each(allowed)('已有报名：可以改%s → 200', async (_label, change) => {
    const op = await manager();
    const activity = await withApplicants();
    const response = await patch(op, activity, await change(activity));
    expect(response.status, await response.clone().text()).toBe(200);
  });

  const locked: readonly [string, Change][] = [
    ['活动类型', () => ({ typeId: f.type2.id })],
    ['适用组织范围', () => ({ orgRange: f.orgs(w.orgA, w.orgC) })],
    ['适用组织范围的“包含下级”', () => ({ orgRange: [{ orgId: w.orgA, includeDescendants: true }] })],
    ['申请类别', () => ({ categoryIds: [f.cat2.id] })],
    ['申请级别', () => ({ levelIds: [f.lv1.id] })],
    ['评定生效日期', () => ({ effectiveDate: '2027-02-01' })],
    ['通知范围', () => ({ noticeOrgRange: [w.orgA, w.orgC] })],
    ['材料提交模板', (a) => ({ chains: chainsWith(a, 'material', { materialTemplate: 'TPL_OTHER' }) })],
    ['环节评价表', async (a) => ({ chains: chainsWith(a, 'defense', { formId: (await w.form(w.orgA)).id }) })],
    ['是否强控截止', (a) => ({ chains: chainsWith(a, 'apply', { hardDeadline: false }) })],
    ['是否允许破格', (a) => ({ chains: chainsWith(a, 'apply', { allowException: false }) })],
    ['破格提名角色', (a) => ({ chains: chainsWith(a, 'apply', { exceptionRoles: ['manager'] }) })],
  ];
  it.each(locked)('已有报名：改%s → 409 ACTIVITY_HAS_APPLICANTS，数据不变', async (_label, change) => {
    const op = await manager();
    const activity = await withApplicants();
    const data = await change(activity);
    await expectError(await patch(op, activity, data), 409, 'ACTIVITY_HAS_APPLICANTS');
    await unchanged(activity);
  });

  it('原样提交（整份回传，含所有锁定字段）不算改动，200；清空资格审批流程仍是 400 而不是 409', async () => {
    const op = await manager();
    const activity = await withApplicants();
    const same = await patch(op, activity, {
      typeId: activity.typeId,
      orgRange: activity.orgRange,
      categoryIds: activity.categoryIds,
      levelIds: activity.levelIds,
      effectiveDate: activity.effectiveDate,
      noticeOrgRange: activity.noticeOrgRange,
      chains: activity.chains.map(sendableChain),
    });
    expect(same.status, await same.clone().text()).toBe(200);
    const current = await w.adminRead(activity.id);
    await expectError(
      await patch(op, current, { chains: chainsWith(current, 'apply', { approvalProcessCode: null }) }),
      400,
      'APPROVAL_PROCESS_REQUIRED',
    );
    await expectError(
      await patch(op, current, { chains: chainsWith(current, 'apply', { approvalProcessCode: '' }) }),
      400,
      'APPROVAL_PROCESS_REQUIRED',
    );
  });

  it('没有报名时可改全部内容、增删环节', async () => {
    const op = await manager();
    const activity = await withApplicants(0);
    const stripped = await ok<ActivityView>(
      await patch(op, activity, { chains: activity.chains.filter((c) => c.type !== 'material').map(sendableChain) }),
    );
    expect(stripped.chains.map((chain) => chain.type)).toEqual(['apply', 'defense', 'result']);
    const retyped = await ok<ActivityView>(
      await patch(op, stripped, { typeId: f.type2.id, orgRange: f.orgs(w.orgA, w.orgC) }),
    );
    expect(retyped.typeId).toBe(f.type2.id);
  });

  it('删除活动：草稿且没有报名才能删；有报名 409 ACTIVITY_HAS_APPLICANTS；进行中 / 已完成 409 ACTIVITY_NOT_DRAFT', async () => {
    const op = await manager();
    const remove = (activity: ActivityView) =>
      op.request('DELETE', `${ACTIVITIES}/${activity.id}`, { ifMatch: activity.revision });
    const applied = await withApplicants();
    await expectError(await remove(applied), 409, 'ACTIVITY_HAS_APPLICANTS');
    await unchanged(applied);
    for (const status of ['published', 'completed'] as const) {
      const activity = await withApplicants(0);
      await w.setStatus(activity.id, status);
      const current = await w.adminRead(activity.id);
      await expectError(await remove(current), 409, 'ACTIVITY_NOT_DRAFT');
      await unchanged(current);
    }
    const draft = await withApplicants(0);
    await ok(await remove(draft));
    expect((await op.request('GET', `${ACTIVITIES}/${draft.id}`)).status).toBe(404);
  });
});
