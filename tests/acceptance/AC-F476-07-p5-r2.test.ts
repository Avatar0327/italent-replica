/**
 * F-476 P5 第 1 轮审查返工（PR #651）：
 * - P1-1 兼职冻结读按完整披露集（上限 ∩ 节点表单 ∩ 当前字段权）裁剪，节点未配置的字段两个入口都隐藏；
 * - P1-2 子集申请详情：只有「本人已办」读冻结份；抄送人 / 待办未办 / 任务被取消 / 非参与人保持基线守卫（404）；
 * - P2-2 子集容器（values / currentValues / originals）在真实字段目录下非空，内部按子集字段权裁，原值受显示开关控制；
 * - P2-3 兼职冻结读的主职 / 员工分组随办理冻结，办理后改主职 / 档案不漂移，撤字段权后隐藏。
 */
import { MODULE_OBJECTS, SUBSETS, type SubsetKind } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { requestWorld } from './AC-PT-request-support.js';
import { BASE, latestInstance, noAdmin, personnelScene, resubmit, rights, textFieldsOf } from './AC-F476-p5-support.js';

const testDb = useTestDb();
const PT = '/api/tenant/employment/part-time-requests';
const OBJECT = MODULE_OBJECTS.employmentRecord.code;
const EMPLOYEE = 'TenantBase.Employee';

describe('F-476 P5 R1 兼职：披露集 / 主职与员工分组冻结', () => {
  async function handled(label: string) {
    const w = await requestWorld(testDb().db, label);
    const r = rights(w);
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const created = await w.extend(record, '2026-12-31');
    await w.send(created.id, created.revision);
    const [first] = w.order.extend;
    const view = await w.instance(created.id);
    await r.decide(view.id, first!, 'approve');
    const read = async (user: string) => ({
      route: await r.get(user, `${PT}/${created.id}`),
      centre: await r.detail(user, view.id),
    });
    return { w, r, first: first!, read };
  }

  it('P1-1 字段有权但节点未配置：申请详情与审批中心详情都隐藏，节点配置了的照常披露', async () => {
    const s = await handled('f476-r2-pt-form');
    const { route, centre } = await s.read(s.first.userId);
    expect(route.body.contentView?.mode).toBe('frozen');
    const fields = Object.keys((route.body.fields ?? {}) as object);
    expect(fields).toContain('departmentId');
    expect(fields).not.toContain('positionId');
    const values = (centre.body as { form?: { values?: object } }).form?.values ?? {};
    expect(Object.keys(values)).toContain('departmentId');
    expect(Object.keys(values)).not.toContain('positionId');
  });

  it('P2-3 办理后改主职 / 档案仍显示获准的旧内容；撤字段权后隐藏', async () => {
    const w = await requestWorld(testDb().db, 'f476-r2-pt-group');
    const r = rights(w);
    const record = await w.seedRecord({ endDate: '2026-10-31' });
    const created = await w.extend(record, '2026-12-31');
    await w.send(created.id, created.revision);
    const [first] = w.order.extend;
    const view = await w.instance(created.id);
    const before = await r.get(w.hr.id, `${PT}/${created.id}`);
    const primary = before.body.primary as { id: string; fields: { departmentId: string } } | null;
    const oldName = (before.body.employee as { name: string } | null)?.name;
    expect(primary?.fields.departmentId, '现读应有主职分组').toBe(w.primary);
    expect(oldName, '现读应有员工分组').toBeTruthy();
    await r.decide(view.id, first!, 'approve');

    // 办理后：主职记录追加一版快照，主职部门被改（员工名称头不可改，只验证它随办理冻结且受字段权约束）
    const moved = await w.org('ZZ_调入后部门');
    await w.moveSnapshot(primary!.id, moved);
    const live = await r.get(w.hr.id, `${PT}/${created.id}`);
    expect((live.body.primary as { fields: { departmentId: string } }).fields.departmentId).toBe(moved);

    const frozen = await r.get(first!.userId, `${PT}/${created.id}`);
    expect(frozen.status).toBe(200);
    expect(frozen.body.contentView?.mode).toBe('frozen');
    expect(frozen.body.primary, '冻结读应带办理时的主职分组').not.toBeNull();
    expect(frozen.body.employee, '冻结读应带办理时的员工分组').not.toBeNull();
    expect((frozen.body.primary as { fields: { departmentId: string } }).fields.departmentId).toBe(w.primary);
    expect((frozen.body.employee as { name: string }).name).toBe(oldName);

    r.hide(OBJECT, 'departmentId');
    r.hide(EMPLOYEE, 'name');
    const revoked = await r.get(first!.userId, `${PT}/${created.id}`);
    expect(revoked.body.primary, '冻结读应带主职分组').toBeDefined();
    expect(Object.keys((revoked.body.primary as { fields: object } | null)?.fields ?? {})).not.toContain(
      'departmentId',
    );
    expect(Object.keys((revoked.body.employee as object | null) ?? {})).not.toContain('name');
  });
});

describe('F-476 P5 R1 子集申请详情：参与人矩阵（P1-2）', () => {
  const subset: SubsetKind = 'education';
  const [field, kept] = textFieldsOf(subset) as [string, string];

  async function pending(label: string) {
    const s = await personnelScene(testDb().db, label);
    // 读者都是普通参与人：不带流程管理员按钮权，才轮到参与人守卫起作用
    const r = rights(s.w, noAdmin);
    const target = await s.record(subset, { [field]: 'ZZ_原值', [kept]: 'ZZ_保持' });
    const request = await s.apply(subset, { [field]: 'ZZ_办理时', [kept]: 'ZZ_保持' }, target);
    const instance = await latestInstance(s.w, 'personnel_change', request.id);
    const read = (user: string) => r.get(user, s.requestPath(request.id));
    return { ...s, r, request, instance, read };
  }

  it('抄送人（具申请对象查看权、非本人）读申请详情：404，与基线一致', async () => {
    const s = await pending('f476-r2-matrix-cc');
    const view = await s.w.detail(s.instance.id);
    const task = view.tasks.find((t) => t.status === 'pending' && t.assigneeUserId === s.n1.userId)!;
    const sent = await s.r.request(s.n1.userId, 'POST', `${BASE}/tasks/${task.id}/cc`, {
      ifMatch: view.revision,
      body: { userIds: [s.cc.userId] },
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    expect((await s.read(s.cc.userId)).status).toBe(404);
  });

  it('待办未办的审批人读申请详情：404', async () => {
    const s = await pending('f476-r2-matrix-pending');
    expect((await s.read(s.n1.userId)).status).toBe(404);
  });

  it('任务被取消（发起人撤回）后，原待办人读申请详情：404', async () => {
    const s = await pending('f476-r2-matrix-cancelled');
    const view = await s.w.detail(s.instance.id);
    const res = await s.r.request(s.subject.userId, 'POST', `${BASE}/instances/${s.instance.id}/withdraw`, {
      ifMatch: view.revision,
      body: {},
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await s.read(s.n1.userId)).status).toBe(404);
  });

  it('非参与人 404；本人读现值、本人已办的审批人读冻结份（对照）', async () => {
    const s = await pending('f476-r2-matrix-control');
    expect((await s.read(s.stranger.userId)).status).toBe(404);
    const own = await s.read(s.subject.userId);
    expect([own.status, own.body.contentView?.mode]).toEqual([200, 'live']);
    await s.r.decide(s.instance.id, s.n1, 'approve');
    const done = await s.read(s.n1.userId);
    expect([done.status, done.body.contentView?.mode]).toEqual([200, 'frozen']);
  });
});

describe('F-476 P5 R1 子集容器投影契约与原值显示开关（P2-2）', () => {
  const subset: SubsetKind = 'education';
  const [field, kept] = textFieldsOf(subset) as [string, string];
  const objectCode = SUBSETS[subset].objectCode;

  async function handled(label: string) {
    const s = await personnelScene(testDb().db, label);
    const r = rights(s.w);
    const target = await s.record(subset, { [field]: 'ZZ_原值', [kept]: 'ZZ_保持' });
    const request = await s.apply(subset, { [field]: 'ZZ_办理时', [kept]: 'ZZ_保持' }, target);
    const instance = await latestInstance(s.w, 'personnel_change', request.id);
    await r.decide(instance.id, s.n1, 'approve');
    await r.decide(instance.id, s.n2, 'reject');
    await resubmit(s.w, instance.id, s.subject.userId, { [field]: 'ZZ_改后', [kept]: 'ZZ_保持' });
    const read = (user: string) => r.get(user, s.requestPath(request.id));
    return { ...s, r, read };
  }

  it('真实字段目录下三个容器非空，内部按子集字段权裁剪（撤一个字段只少一个键）', async () => {
    const s = await handled('f476-r2-container');
    const route = await s.read(s.n2.userId);
    expect(route.body.contentView?.mode).toBe('frozen');
    for (const container of ['values', 'currentValues', 'originals'] as const)
      expect(Object.keys((route.body[container] ?? {}) as object), container).toEqual(expect.arrayContaining([field]));
    s.r.hide(objectCode, field);
    const hidden = await s.read(s.n2.userId);
    for (const container of ['values', 'currentValues', 'originals'] as const) {
      const keys = Object.keys((hidden.body[container] ?? {}) as object);
      expect(keys, container).not.toContain(field);
      expect(keys, container).toContain(kept);
    }
  });

  it('原值受审批原值显示开关控制：关闭后申请详情与审批中心都不给原值；开启时只给上限 ∩ 当前有权的', async () => {
    const s = await handled('f476-r2-originals');
    const on = await s.read(s.n2.userId);
    expect(JSON.stringify(on.body.originals)).toContain('ZZ_原值');
    const off = await s.w.request(s.w.hr.id, 'PUT', '/api/tenant/settings/approval.show_original_values', {
      ifMatch: 0,
      body: { value: false },
    });
    expect(off.status, await off.clone().text()).toBe(200);
    const route = await s.read(s.n2.userId);
    expect(route.status).toBe(200);
    expect(JSON.stringify(route.body)).not.toContain('ZZ_原值');
    expect(Object.keys((route.body.currentValues ?? {}) as object)).toContain(field);
  });
});
