/**
 * F-280（#453 R1 后补-权限）兼职新增申请的审批快照保留联动意图（docs/08_设计/R2-T05_兼职设计.md §4.5 / §4.8，DEC-634，DEC-058 / DEC-406）：
 * - isDepartmentHead 如实保留：明确填“否”就是 false，只有没填才是 null；
 * - 新增下属（addedSubordinateIds，员工 ID 列表）进快照表单，节点只读展示、不进审批编辑集合（F234A C9）；
 * - 这两项是本单内容（新增申请没有原值），无字段查看权的审批人走现有盲审口径（DEC-058），详情按字段查看权裁剪。
 * 日期框架：今天 2026-10-01。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { grantVisibleFields, permissionAdmin } from './AC-APV-support.js';
import { requestWorld } from './AC-PT-request-support.js';

const database = useTestDb();
const ALL = MODULE_OBJECTS.employmentRecord.fields.map((field) => field.code);

describe('F-280 审批快照：联动意图', () => {
  it('① 明确填“否”保留为 false（不是 null）；没填才是 null', async () => {
    const w = await requestWorld(database().db, 'f280-false');
    const explicit = await w.create({ isDepartmentHead: false });
    await w.send(explicit.id, explicit.revision);
    expect((await w.instance(explicit.id)).form.values).toMatchObject({ isDepartmentHead: false });
    const blank = await w.create({ startDate: '2026-09-02' });
    await w.send(blank.id, blank.revision);
    expect((await w.instance(blank.id)).form.values.isDepartmentHead ?? null).toBeNull();
  });

  it('② 快照带新增下属（员工 ID 列表）', async () => {
    const w = await requestWorld(database().db, 'f280-subs');
    const sub = await w.person('下属', w.primary);
    const created = await w.create({ isDepartmentHead: true, addedSubordinateIds: [sub.employeeId] });
    await w.send(created.id, created.revision);
    expect((await w.instance(created.id)).form.values).toMatchObject({
      isDepartmentHead: true,
      addedSubordinateIds: [sub.employeeId],
    });
  });

  it('③ 无字段查看权：详情按现有裁剪口径隐藏这两项，同意被盲审拦住', async () => {
    const db = database().db;
    const hidden = ['isDepartmentHead', 'addedSubordinateIds'];
    const w = await requestWorld(db, 'f280-blind');
    const world = await permissionAdmin(w);
    const sub = await w.person('下属', w.primary);
    await grantVisibleFields(
      world,
      w.approvers.pHrbp.userId,
      ALL.filter((code) => !hidden.includes(code)),
    );
    const created = await w.create({ isDepartmentHead: false, addedSubordinateIds: [sub.employeeId] });
    await w.send(created.id, created.revision);
    const view = await w.instance(created.id);
    const detail = await world.api.request(
      'GET',
      `/api/tenant/approval/instances/${view.id}`,
      w.as(w.approvers.pHrbp.userId),
    );
    const asApprover = (await detail.json()) as { form: { values: Record<string, unknown> } };
    for (const code of hidden) expect(asApprover.form.values, code).not.toHaveProperty(code);
    const task = w.pending(view)[0]!;
    const blocked = await world.api.request('POST', `/api/tenant/approval/tasks/${task.id}/approve`, {
      ...w.as(w.approvers.pHrbp.userId),
      ifMatch: view.revision,
      body: { comment: '意见' },
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: { details: { reason: 'APPROVAL_BLIND_REVIEW' } } });
  });
});
