/**
 * R2-T04 BE-5d2 / AC-RT-20：意向退休日期申请（设计 §2.5、§11.1～§11.3，A-6）。
 * 创建 → 经审批中心真实提交（实例 business_type = retirement_intention 落库）→ 驳回改后重提 / 撤回 / 通过；
 * 范围外日期 400；同员工并存 409；审批人只见本单字段；通过只记录，人事版本与预计退休日期前后不变（A-6，DEC-637 / DEC-638）。
 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { intentionWorld, reasonOf, TODAY } from './AC-RT-intention-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const world = (label: string) => intentionWorld(database().db, `${label}-${uniqueSuffix()}`);

describe('AC-RT-20 意向申请主流程', () => {
  it('创建草稿冻结快照 → 提交走审批中心真实实例 → 驳回改后重提 → 通过：只记录，人事字段与版本不变（A-6）', async () => {
    const w = await world('flow');
    await w.setRetirement({ expected: '2030-06-01', earliest: '2029-06-01', latest: '2031-06-01' });
    const personnelBefore = await w.personnelState();

    const draft = await w.create({ intendedDate: '2030-03-01', reason: '身体原因' });
    expect(draft).toMatchObject({
      employeeId: w.subject.employeeId,
      status: 'draft',
      intendedDate: '2030-03-01',
      reason: '身体原因',
      expectedDateSnapshot: '2030-06-01',
      earliestSnapshot: '2029-06-01',
      latestSnapshot: '2031-06-01',
      revision: 1,
    });

    const submitted = await w.act(draft.id, 'submit');
    expect(submitted.status).toBe('in_review');
    const view = await w.instance(draft.id);
    expect(view).toMatchObject({ approvalType: 'retirement_intention', status: 'running', businessId: draft.id });
    const [typeRow] = await w.rows<{ business_type: string }>(
      sql`SELECT business_type FROM approval_instances WHERE tenant_id=${w.tenant.id} AND id=${view.id}::uuid`,
    );
    expect(typeRow).toEqual({ business_type: 'retirement_intention' });
    expect((await w.footprint(draft.id)).row).toMatchObject({ state: 'in_review', approval_instance_id: view.id });

    // 驳回到发起人 → 申请 rejected，可修改后同单重提（沿用原实例，DEC-103）
    await w.decide(draft.id, 'reject');
    expect((await w.get(draft.id)).status).toBe('rejected');
    const edited = await w.patchRaw(draft.id, (await w.get(draft.id)).revision, { intendedDate: '2030-04-01' });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const resubmitted = await w.act(draft.id, 'submit');
    expect(resubmitted).toMatchObject({ status: 'in_review', intendedDate: '2030-04-01' });
    expect((await w.instanceOfAll(draft.id)).map((item) => item.id)).toEqual([view.id]);

    await w.decide(draft.id, 'approve');
    expect(await w.get(draft.id)).toMatchObject({ status: 'approved', intendedDate: '2030-04-01' });
    // A-6：通过后只记录，不写回预计退休日期，不产生人事版本
    expect(await w.personnelState()).toEqual(personnelBefore);
    expect((await w.instance(draft.id)).status).toBe('approved');
  });

  it('撤回：草稿 / 审批中均可撤回为终态，释放“同员工一张”的占位；不同意：终态 disapproved', async () => {
    const w = await world('withdraw');
    const first = await w.create({ intendedDate: '2030-03-01' });
    expect((await w.act(first.id, 'withdraw')).status).toBe('withdrawn');

    const second = await w.create({ intendedDate: '2030-03-02' });
    await w.act(second.id, 'submit');
    const instance = await w.instance(second.id);
    expect((await w.act(second.id, 'withdraw')).status).toBe('withdrawn');
    expect((await w.detail(instance.id)).status).toBe('withdrawn');
    // 终态不能再提交 / 修改
    const current = await w.get(second.id);
    expect((await reasonOf(await w.actionRaw(second.id, 'submit', current.revision))).reason).toBe(
      'RETIREMENT_INTENTION_NOT_SUBMITTABLE',
    );
    expect((await w.patchRaw(second.id, current.revision, { reason: '改' })).status).toBe(409);

    const third = await w.create({ intendedDate: '2030-03-03' });
    await w.act(third.id, 'submit');
    await w.decide(third.id, 'disagree');
    expect((await w.get(third.id)).status).toBe('disapproved');
    // 办结后可再建
    await w.create({ intendedDate: '2030-03-04' });
    expect((await w.list(`?employeeId=${w.subject.employeeId}`)).total).toBe(4);
  });

  it('校验：日期晚于今天；有弹性范围时落在范围内、没有则不限（A-6）；员工当前在职；同员工并存 409；失败无写入', async () => {
    const w = await world('validate');
    await w.setRetirement({ expected: '2030-06-01', earliest: '2029-06-01', latest: '2031-06-01' });

    for (const intendedDate of [TODAY, '2020-01-01']) {
      expect(await reasonOf(await w.createRaw({ intendedDate })), intendedDate).toMatchObject({
        status: 400,
        reason: 'RETIREMENT_INTENTION_NOT_FUTURE',
      });
    }
    for (const intendedDate of ['2029-05-31', '2031-06-02']) {
      expect(await reasonOf(await w.createRaw({ intendedDate })), intendedDate).toMatchObject({
        status: 400,
        reason: 'RETIREMENT_INTENTION_OUT_OF_RANGE',
      });
    }
    expect((await w.list()).total).toBe(0);
    // 范围端点含边界
    const edge = await w.create({ intendedDate: '2031-06-01' });
    expect(edge.status).toBe('draft');

    // 同员工并存 409，且不产生第二张
    expect(await reasonOf(await w.createRaw({ intendedDate: '2030-01-01' }))).toMatchObject({
      status: 409,
      reason: 'RETIREMENT_INTENTION_IN_PROGRESS',
    });
    expect((await w.list()).total).toBe(1);

    // 修改同样按范围重校验；字段严格（未知字段 400）
    const current = await w.get(edge.id);
    expect((await reasonOf(await w.patchRaw(edge.id, current.revision, { intendedDate: '2035-01-01' }))).reason).toBe(
      'RETIREMENT_INTENTION_OUT_OF_RANGE',
    );
    expect((await w.patchRaw(edge.id, current.revision, { status: 'approved' })).status).toBe(400);
    expect((await w.patchRaw(edge.id, current.revision + 5, { reason: 'x' })).status).toBe(409);
    expect(await w.get(edge.id)).toMatchObject({ intendedDate: '2031-06-01', revision: current.revision });

    // 没有弹性范围：不限范围
    const other = await w.person('无弹性范围', w.deptB);
    expect((await w.create({ intendedDate: '2099-01-01' }, { employeeId: other.employeeId })).status).toBe('draft');

    // 未入职（无当前任职）的员工不能申请
    const pending = await w.employee('未入职');
    expect(await reasonOf(await w.createRaw({ intendedDate: '2030-01-01' }, { employeeId: pending.id }))).toMatchObject(
      {
        status: 409,
        reason: 'RETIREMENT_INTENTION_NOT_EMPLOYED',
      },
    );
  });

  it('审批人只见本单字段（DEC-057）：表单只含意向日期、原因与冻结快照，标题不含个人数据', async () => {
    const w = await world('fields');
    await w.setRetirement({ expected: '2030-06-01', earliest: '2029-06-01', latest: '2031-06-01' });
    const draft = await w.create({ intendedDate: '2030-03-01', reason: '家庭原因' });
    await w.act(draft.id, 'submit');
    const view = await w.detail((await w.instance(draft.id)).id, w.manager.userId);
    expect(Object.keys(view.form.values).sort()).toEqual(
      ['earliestSnapshot', 'expectedDateSnapshot', 'intendedDate', 'latestSnapshot', 'reason'].sort(),
    );
    expect(view.form.values).toMatchObject({ intendedDate: '2030-03-01', reason: '家庭原因' });
    expect(view.title).toBe('意向退休日期申请');
  });

  it('提交校验：员工已不在弹性范围内（人事调整了上下限）时重判并拒绝，申请保持原状', async () => {
    const w = await world('submit-recheck');
    await w.setRetirement({ expected: '2030-06-01', earliest: '2029-06-01', latest: '2031-06-01' });
    const draft = await w.create({ intendedDate: '2030-03-01' });
    await w.setRetirement({ expected: '2032-06-01', earliest: '2032-01-01', latest: '2033-01-01' });
    const before = await w.footprint(draft.id);
    const response = await w.actionRaw(draft.id, 'submit', draft.revision);
    expect(await reasonOf(response)).toMatchObject({ status: 400, reason: 'RETIREMENT_INTENTION_OUT_OF_RANGE' });
    expect(await w.footprint(draft.id)).toEqual(before);
  });
});
