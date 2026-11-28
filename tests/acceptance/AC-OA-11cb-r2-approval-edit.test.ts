/**
 * BE-11c-b 第 2 轮 P2-1（R2-T08 §4.4 / §6.3）：审批中编辑调动行。当前审批人（节点开放 `transferItems.*`）经审批中心
 * 编辑入口改调动行：按审批人当前权限三层判（`EditApprovalIngApply` + 字段写权 + 任职 / 组织范围，新旧两侧），
 * 按候选状态一次整单校验、同事务写行、revision 只 + 1、审批快照随之重算；改不了的列、看不到的行一律 400。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { oaNodes } from './AC-OA-approval-support.js';
import { transferWorld } from './AC-OA-11cb-support.js';
import { expectError, onlyPeople } from './AC-OA-head-support.js';
import { randomUUID } from 'node:crypto';

const testDb = useTestDb();
const OUT_OF_RANGE = 'ORG_ADJUSTMENT_OUT_OF_RANGE';

async function setup(label: string) {
  const w = await transferWorld(testDb().db, label, {
    nodes: oaNodes([{ editableFields: ['subject', 'transferItems.departmentId', 'transferItems.employeeId'] }]),
  });
  const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
  const mover = await w.staff(w.a);
  const itemId = await w.seed(view.id, mover);
  await w.submitted(view.id);
  const edit = (fields: Record<string, unknown>) => w.act(view.id, w.hrbp, 'edit', { fields });
  return { w, view, mover, itemId, edit };
}

describe('P2-1 审批中编辑调动行', () => {
  it('审批人改目标部门：200，行落库、revision 只 + 1、实例版本与审批详情快照同步、写一条明细审计', async () => {
    const { w, view, itemId, edit } = await setup('r2-edit-ok');
    const before = await w.state(view.id);

    const res = await edit({ 'transferItems.departmentId': [{ itemId, value: w.a }] });

    expect(res.status, await res.clone().text()).toBe(200);
    expect((await w.transferRows(view.id))[0]).toMatchObject({ id: itemId, department_id: w.a });
    expect((await w.state(view.id)).revision).toBe(before.revision + 1);
    expect(await w.businessVersion(view.id)).toBe(`revision:${before.revision + 1}`);
    expect(await w.transferAudits(view.id)).toContain('org-adjustment.transfer-item.update');
    const detail = await w.detail((await w.instance(view.id)).id, w.hrbp.userId);
    expect(detail.form.values['transferItems.departmentId']).toEqual([{ itemId, value: w.a }]);
  });

  it('改后的目标不在调整范围：整单校验 400 OUT_OF_RANGE，行 / revision / 实例版本都不变', async () => {
    const { w, view, itemId, edit } = await setup('r2-edit-range');
    const before = { state: await w.state(view.id), rows: await w.transferRows(view.id) };

    const res = await edit({ 'transferItems.departmentId': [{ itemId, value: w.subject }] });

    await expectError(res, 400, 'VALIDATION_FAILED', OUT_OF_RANGE);
    expect({ state: await w.state(view.id), rows: await w.transferRows(view.id) }).toEqual(before);
  });

  it('审批人没有 transferItems.departmentId 字段写权 → 403，行不变', async () => {
    const { w, view, itemId, edit } = await setup('r2-edit-field');
    const before = await w.transferRows(view.id);
    w.access.deniedFields.add('transferItems.departmentId');

    const res = await edit({ 'transferItems.departmentId': [{ itemId, value: w.a }] });

    expect(res.status, await res.clone().text()).toBe(403);
    expect(await w.transferRows(view.id)).toEqual(before);
  });

  it('审批人看不到该员工（任职范围外）：与行不存在同一 400，行不变', async () => {
    const { w, view, itemId, edit } = await setup('r2-edit-hidden');
    const before = await w.transferRows(view.id);
    w.access.employment = onlyPeople(w.a, await w.staff(w.a)); // 范围里没有调动行的员工

    const hidden = await edit({ 'transferItems.departmentId': [{ itemId, value: w.a }] });
    const missing = await edit({ 'transferItems.departmentId': [{ itemId: randomUUID(), value: w.a }] });

    await expectError(hidden, 400, 'VALIDATION_FAILED');
    expect(await hidden.clone().text()).toBe(await missing.clone().text());
    expect(await w.transferRows(view.id)).toEqual(before);
  });

  it('改身份列（员工）→ 400，不能在审批中换人；行不变', async () => {
    const { w, view, itemId, edit } = await setup('r2-edit-identity');
    const before = await w.transferRows(view.id);

    const res = await edit({ 'transferItems.employeeId': [{ itemId, value: await w.staff(w.b) }] });

    await expectError(res, 400, 'VALIDATION_FAILED');
    expect(await w.transferRows(view.id)).toEqual(before);
  });
});
