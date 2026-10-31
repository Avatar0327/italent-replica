/**
 * F-291（F-267BE，DEC-654 批 1 / DEC-655）：审批详情对“当前可审批任务”下发本节点可编辑字段 form.edit。
 * 下发 = 节点 editableFields ∩ 查看人可见字段（按节点顺序，带当前值与必填）；与 actions 的 edit 判定、命令侧
 * “同意带 fields”的前置检查同源（edit-surface.ts），必填与命令侧拒收空值同一张表。口径：docs/09_派发/后续任务.md F-291。
 * 兼职预置流程原样安装（F-249）：延长 / 结束 = endDate + requestRemark，新增 = 7 项（含 PT-7 开放的是否部门负责人，不含新增下属）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { requestWorld, type RequestWorld } from './AC-PT-request-support.js';
import {
  approvalWorld,
  grantFieldAccess,
  permissionAdmin,
  transferScene,
  type InstanceView,
} from './AC-APV-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

interface EditSurface {
  taskId: string;
  mode: 'with_approve' | 'separate';
  fields: { key: string; required: boolean; value: unknown }[];
}
type Detail = InstanceView & { form: InstanceView['form'] & { edit?: EditSurface } };

const world = (label: string, options: Parameters<typeof requestWorld>[2] = {}) =>
  requestWorld(database().db, `f291-${label}`, options);

async function detailOf(w: RequestWorld, requestId: string, userId: string): Promise<Detail> {
  const view = await w.instance(requestId);
  return (await w.detail(view.id, userId)) as Detail;
}

const reasonOf = async (response: Response) =>
  ((await response.json()) as { error: { details?: { reason?: string } } }).error.details?.reason;

async function extendScene(label: string, options: Parameters<typeof requestWorld>[2] = {}) {
  const w = await world(`extend-${label}`, options);
  const record = await w.seedRecord({ endDate: '2026-10-31' });
  const created = await w.extend(record, '2026-12-31', '延长原因');
  await w.send(created.id, created.revision);
  const view = await w.instance(created.id);
  return { w, created, view, task: w.pending(view)[0]! };
}

describe('F-291 兼职三类节点：下发 edit', () => {
  it('延长：mode=with_approve，endDate 必填 + requestRemark 非必填，value 取当前值', async () => {
    const { w, created, task } = await extendScene('ok');
    const detail = await detailOf(w, created.id, task.assigneeUserId);
    expect(detail.form.edit).toEqual({
      taskId: task.id,
      mode: 'with_approve',
      fields: [
        { key: 'endDate', required: true, value: '2026-12-31' },
        { key: 'requestRemark', required: false, value: '延长原因' },
      ],
    });
  });

  it('结束：endDate 必填、requestRemark 非必填；备注无值时 value 为 null', async () => {
    const w = await world('end');
    const record = await w.seedRecord({ endDate: '2026-12-31' });
    const created = await w.end(record, '2026-10-15');
    await w.send(created.id, created.revision);
    const task = w.pending(await w.instance(created.id))[0]!;
    const detail = await detailOf(w, created.id, task.assigneeUserId);
    expect(detail.form.edit).toEqual({
      taskId: task.id,
      mode: 'with_approve',
      fields: [
        { key: 'endDate', required: true, value: '2026-10-15' },
        { key: 'requestRemark', required: false, value: null },
      ],
    });
  });

  it('新增：DEC-629 / DEC-634 开放的 7 项（含 PT-7 开放的是否部门负责人，不含新增下属），兼职类型 / 兼职部门必填', async () => {
    const w = await world('add');
    const created = await w.create({ endDate: null });
    await w.send(created.id, 1);
    const task = w.pending(await w.instance(created.id))[0]!;
    const edit = (await detailOf(w, created.id, task.assigneeUserId)).form.edit!;
    expect(edit.mode).toBe('with_approve');
    expect(edit.fields.map((field) => field.key)).toEqual([
      'partTimeType',
      'endDate',
      'departmentId',
      'directManagerId',
      'postId',
      'levelId',
      'isDepartmentHead',
    ]);
    expect(edit.fields.filter((field) => field.required).map((field) => field.key)).toEqual([
      'partTimeType',
      'departmentId',
    ]);
    expect(edit.fields.find((field) => field.key === 'partTimeType')?.value).toBe('part_time');
    expect(edit.fields.find((field) => field.key === 'departmentId')?.value).toBe(w.side);
    expect(edit.fields.find((field) => field.key === 'endDate')?.value).toBeNull();
  });

  it('节点 editMode=separate：mode=separate，actions 含 edit', async () => {
    const { w, created, task } = await extendScene('separate', { editMode: 'separate' });
    const detail = await detailOf(w, created.id, task.assigneeUserId);
    expect(detail.form.edit?.mode).toBe('separate');
    expect(detail.actions).toContain('edit');
  });
});

describe('F-291 不下发的情形', () => {
  it('非本人待办（发起人 / 其他审批人）不下发', async () => {
    const { w, created, task } = await extendScene('others');
    const other = [w.approvers.pHead, w.approvers.sHead].find((p) => p.userId !== task.assigneeUserId)!;
    expect((await detailOf(w, created.id, w.hr.id)).form.edit).toBeUndefined();
    expect((await detailOf(w, created.id, other.userId)).form.edit).toBeUndefined();
  });

  it('前加签人有待办但不下发（14 §11.3）', async () => {
    const { w, created, view, task } = await extendScene('add-sign', { addSign: true });
    const signer = await w.person('加签人', w.staff);
    const response = await w.taskAction(task.assigneeUserId, task.id, 'add-sign', view.revision, {
      userIds: [signer.userId],
      type: 'before',
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const signerView = await detailOf(w, created.id, signer.userId);
    expect(signerView.actions).toContain('approve');
    expect(signerView.form.edit).toBeUndefined();
  });

  it('员工信息类（approvalEdit=false）、editMode=none、查看人对可编辑字段全无查看权：不下发', async () => {
    // 先由 API 夹具初始化审批模块，避免单独加载编辑规则时提前进入审批存储的循环依赖。
    const { editSurface } = await import('../../apps/api/src/modules/approval/edit-surface.js');
    const node = { editMode: 'with_approve', editableFields: ['place'] } as never;
    const mine = { id: 't1' } as never;
    const given = (approvalType: string, nodeOverride: object = {}, viewable?: ReadonlySet<string>) =>
      editSurface({
        approvalType: approvalType as never,
        node: { ...(node as object), ...nodeOverride } as never,
        tasks: [],
        mine,
        values: { place: 'x' },
        viewable,
      });
    expect(given('transfer')).toMatchObject({ mode: 'with_approve', fields: [{ key: 'place', value: 'x' }] });
    expect(given('emp_info_change')).toBeNull();
    expect(given('transfer', {}, new Set(['effectiveDate']))).toBeNull();
    expect(given('transfer', { editMode: 'none', editableFields: [] })).toBeNull();
  });

  it('查看人对节点可编辑字段无查看权：该字段被剔除，其余按节点顺序保留', async () => {
    const w = await approvalWorld(database().db, 'f291-field-access');
    const s = await transferScene(w);
    const field = await w.json<{ id: string }>(
      await w.request(w.hr.id, 'POST', '/api/tenant/employment/custom-fields', {
        ifMatch: 0,
        body: { name: '机密备注', valueType: 'text', objectType: 'employment' },
      }),
      201,
    );
    const hidden = `custom:${field.id}`;
    const admin = await permissionAdmin(w);
    await grantFieldAccess(admin, s.outHead.userId, { view: ['id', 'departmentId', 'effectiveDate', 'place'] });
    await w.publishedProcess({
      nodes: [
        {
          key: 'out_head',
          approver: { type: 'department', value: 'latest_record_department_head' },
          formFields: ['departmentId', 'effectiveDate', 'place', hidden],
          editableFields: [hidden, 'place'],
          editMode: 'with_approve',
        },
      ],
    });
    const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to, place: '原地点' }));
    const response = await api.request('GET', `${BASE}/instances/${view.id}`, w.as(s.outHead.userId));
    const detail = (await response.json()) as Detail;
    expect(detail.form.edit?.fields.map((field) => field.key)).toEqual(['place']);
  });
});

describe('F-291 与命令侧同源', () => {
  it('下发的 fields 原样提交“同意”成功；多带一个未下发的键 → 403 APPROVAL_FIELD_NOT_EDITABLE', async () => {
    const { w, created, view, task } = await extendScene('roundtrip');
    const edit = (await detailOf(w, created.id, task.assigneeUserId)).form.edit!;
    const fields = Object.fromEntries(edit.fields.map((field) => [field.key, field.value]));
    const extra = await w.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {
      comment: '合成意见',
      fields: { ...fields, departmentId: w.primary },
    });
    expect([extra.status, await reasonOf(extra)]).toEqual([403, 'APPROVAL_FIELD_NOT_EDITABLE']);
    const ok = await w.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {
      comment: '合成意见',
      fields,
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
  });

  it('必填来源同一张表：下发 required 的键，提交空值都被命令拒收（400），非必填的键可清空', async () => {
    const w = await world('required');
    const created = await w.create({ endDate: null });
    await w.send(created.id, 1);
    const view = await w.instance(created.id);
    const task = w.pending(view)[0]!;
    const edit = (await detailOf(w, created.id, task.assigneeUserId)).form.edit!;
    for (const field of edit.fields.filter((item) => item.required)) {
      const blank = await w.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {
        comment: '合成意见',
        fields: { [field.key]: null },
      });
      const body = (await blank.json()) as { error: { details?: { reason?: string; field?: string } } };
      expect([blank.status, body.error.details?.reason, body.error.details?.field]).toEqual([
        400,
        'APPROVAL_FIELD_REQUIRED',
        field.key,
      ]);
    }
    const optional = await w.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {
      comment: '合成意见',
      fields: { endDate: null },
    });
    expect(optional.status, await optional.clone().text()).toBe(200);
  });
});

describe('F-291 调动：既有必填规则（DEC-165 新部门必填）纳入同一必填来源', () => {
  async function transferEdit(label: string) {
    const w = await approvalWorld(database().db, `f291-transfer-${label}`);
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [
        {
          key: 'out_head',
          approver: { type: 'department', value: 'latest_record_department_head' },
          formFields: ['departmentId', 'effectiveDate', 'place'],
          editableFields: ['departmentId', 'place'],
          editMode: 'with_approve',
        },
      ],
    });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to, place: '原地点' }));
    const task = view.tasks.find((item) => item.status === 'pending')!;
    return { w, s, view, task };
  }

  it('详情：departmentId required=true、place required=false', async () => {
    const { w, s, view } = await transferEdit('detail');
    const detail = (await w.detail(view.id, s.outHead.userId)) as Detail;
    expect(detail.form.edit?.fields).toEqual([
      { key: 'departmentId', required: true, value: expect.any(String) },
      { key: 'place', required: false, value: '原地点' },
    ]);
  });

  it('清空部门被拒（400 TRANSFER_REQUIRED_FIELDS，与既有口径一致），任务不动；合法新部门可同意', async () => {
    const { w, s, view, task } = await transferEdit('submit');
    const blank = await w.taskAction(s.outHead.userId, task.id, 'approve', view.revision, {
      fields: { departmentId: null },
    });
    expect(blank.status, await blank.clone().text()).toBe(400);
    expect(await blank.json()).toMatchObject({
      error: { details: { reason: 'TRANSFER_REQUIRED_FIELDS', missingFields: ['departmentId'] } },
    });
    expect((await w.detail(view.id, s.outHead.userId)).tasks.find((item) => item.id === task.id)?.status).toBe(
      'pending',
    );
    const other = await w.org(`新调入部门${uniqueSuffix()}`);
    const ok = await w.taskAction(s.outHead.userId, task.id, 'approve', view.revision, {
      fields: { departmentId: other, place: '新地点' },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
  });
});
