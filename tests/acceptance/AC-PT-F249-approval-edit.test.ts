/**
 * F-249（DEC-629 / DEC-634，docs/08_设计/R2-T05_兼职设计.md §4.5 / §13）：延长 / 新增节点对齐原站，审批人可编辑业务表单。
 * 预置流程原样安装（不用夹具的 editMode 覆盖）：延长节点开 新结束日期（必填）+ 延长备注；新增节点开 兼职类型 / 结束日期 /
 * 兼职部门 / 直线经理 / 职务 / 职级，必填 兼职类型 / 开始日期 / 兼职部门；薪资、工号、开始日期不开；“是否部门负责人”按 DEC-634 随 PT-7
 * 开放（见 AC-PT-linkage-request），新增下属不开（F234A C9 字段集，取最小集合）。
 * 审批编辑复用创建 / 修改同一校验入口（新增 = checkNewPartTime，延长 = checkDateRequest），经公开审批接口。
 * 日期框架：今天 2026-10-01，兼职默认 09-01 起。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { requestWorld, type RequestWorld } from './AC-PT-request-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const world = (label: string) => requestWorld(database().db, `f249-${label}`);

const reasonOf = async (response: Response) =>
  ((await response.json()) as { error: { details?: { reason?: string } } }).error.details?.reason;

/** 当前待办的第一个任务 + 实例视图。 */
async function firstTask(w: RequestWorld, requestId: string) {
  const view = await w.instance(requestId);
  return { view, task: w.pending(view)[0]! };
}

describe('F-249 延长节点：新结束日期（必填）+ 延长备注', () => {
  async function scene(label: string) {
    const w = await world(`extend-${label}`);
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const created = await w.extend(record, '2026-12-31');
    await w.send(created.id, created.revision);
    return { w, record, created, ...(await firstTask(w, created.id)) };
  }

  it('编辑并同意：改结束日 + 备注成功追加版本；落地按编辑后的结束日，原定结束日期不变', async () => {
    const { w, record, created, view, task } = await scene('ok');
    const ok = await w.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {
      comment: '合成意见',
      fields: { endDate: '2027-01-31', requestRemark: '审批人改备注' },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await w.load(created.id)).version).toMatchObject({
      versionNo: 2,
      endDate: '2027-01-31',
      remark: '审批人改备注',
      originalEndDate: '2026-10-31',
    });
    await w.approveInOrder(created.id, w.order.extend.slice(1));
    expect((await w.terms(record)).at(-1)).toMatchObject({ end_date: '2027-01-31', source: 'extend' });
  });

  it('清空结束日 → 400 PART_TIME_END_DATE_REQUIRED；等于原结束日 → 409；节点没开放的字段 → 403，均无写入', async () => {
    const { w, created, view, task } = await scene('refused');
    const before = { writes: await w.writes(), request: await w.load(created.id) };
    const act = (fields: Record<string, unknown>) =>
      w.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, { comment: '合成意见', fields });
    const blank = await act({ endDate: null });
    expect([blank.status, await reasonOf(blank)]).toEqual([400, 'PART_TIME_END_DATE_REQUIRED']);
    const equal = await act({ endDate: '2026-10-31' });
    expect([equal.status, await reasonOf(equal)]).toEqual([409, 'PART_TIME_NOT_EXTENDED']);
    const closed = await act({ departmentId: w.primary });
    expect([closed.status, await reasonOf(closed)]).toEqual([403, 'APPROVAL_FIELD_NOT_EDITABLE']);
    expect({ writes: await w.writes(), request: await w.load(created.id) }).toEqual(before);
  });
});

describe('F-249 新增节点：兼职类型 / 结束日期 / 兼职部门 / 直线经理 / 职务 / 职级', () => {
  async function scene(label: string) {
    const w = await world(`add-${label}`);
    const created = await w.create({ endDate: null });
    await w.send(created.id, 1);
    return { w, created, ...(await firstTask(w, created.id)) };
  }
  const approveWith = (s: Awaited<ReturnType<typeof scene>>, fields: Record<string, unknown>): Promise<Response> =>
    s.w.taskAction(s.task.assigneeUserId, s.task.id, 'approve', s.view.revision, { comment: '合成意见', fields });

  async function jobData(w: RequestWorld) {
    const api = tenantApi(database().db, { clock: () => new Date('2026-10-01T01:00:00.000Z') });
    const create = async (kind: string, extra: Record<string, unknown> = {}) => {
      const response = await api.request('POST', `/api/tenant/job/${kind}`, {
        user: w.hr.id,
        tenant: w.tenant.id,
        ifMatch: 0,
        body: { name: `${kind}${uniqueSuffix()}`, code: `F249_${uniqueSuffix()}`, startDate: '2026-01-01', ...extra },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await response.json()) as { id: string };
    };
    const type = await create('level-types');
    const level = await create('levels', { level: 3, levelTypeId: type.id });
    const post = await create('posts');
    return { post, level };
  }

  it('编辑并同意：6 项一次改全成功，版本追加；落地的兼职记录取编辑后的值', async () => {
    const s = await scene('six');
    const { w, created } = s;
    const department = await w.org(`新兼职部门${uniqueSuffix()}`);
    const { post, level } = await jobData(w);
    const manager = w.approvers.pHead.employeeId;
    const fields = {
      partTimeType: 'secondment',
      endDate: '2026-12-31',
      departmentId: department,
      directManagerId: manager,
      postId: post.id,
      levelId: level.id,
    };
    const ok = await approveWith(s, fields);
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await w.load(created.id)).version).toMatchObject({
      versionNo: 2,
      serviceType: 'secondment',
      endDate: '2026-12-31',
      departmentId: department,
      directManagerId: manager,
      postId: post.id,
      levelId: level.id,
      startDate: '2026-09-01',
    });
  });

  it('必填：清空兼职类型 / 兼职部门 → 400，整个同意失败（任务未关闭、版本不变）', async () => {
    const s = await scene('required');
    const { w, created } = s;
    const before = { writes: await w.writes(), request: await w.load(created.id) };
    for (const field of ['partTimeType', 'departmentId']) {
      const response = await approveWith(s, { [field]: null });
      expect(response.status, field).toBe(400);
    }
    expect({ writes: await w.writes(), request: await w.load(created.id) }).toEqual(before);
    expect(w.pending(await w.instance(created.id)).map((item) => item.id)).toEqual([s.task.id]);
  });

  it('复用创建入口的校验：兼职部门不存在 / 直线经理是本人 → 当次拒绝，版本不变', async () => {
    const s = await scene('validation');
    const { w, created } = s;
    const before = await w.load(created.id);
    const unknownOrg = await approveWith(s, { departmentId: '00000000-0000-4000-8000-000000000000' });
    expect(unknownOrg.status).toBeGreaterThanOrEqual(400);
    const self = await approveWith(s, { directManagerId: w.worker.employeeId });
    expect(self.status).toBeGreaterThanOrEqual(400);
    expect(await w.load(created.id)).toEqual(before);
  });

  it('不开：工号 / 薪资 / 新增下属 → 403 APPROVAL_FIELD_NOT_EDITABLE；开始日期 → 同样拒绝，均无写入', async () => {
    const s = await scene('closed');
    const { w, created } = s;
    const before = { writes: await w.writes(), request: await w.load(created.id) };
    for (const field of ['jobNumber', 'salaryAmount', 'addedSubordinateIds']) {
      const response = await approveWith(s, { [field]: 'x' });
      expect([response.status, await reasonOf(response)], field).toEqual([403, 'APPROVAL_FIELD_NOT_EDITABLE']);
    }
    const moved = await approveWith(s, { effectiveDate: '2026-09-02' });
    expect(moved.status).toBeGreaterThanOrEqual(400);
    expect({ writes: await w.writes(), request: await w.load(created.id) }).toEqual(before);
  });
});
