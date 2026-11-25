/**
 * BE-11c-b 第 3 轮 P1-4 / P2-2（R2-T08 §4.5、§6.3）：调动分区的披露在冻结侧与读侧是同一个交集，错误信封同一条规则。
 *  - P1-4 合同变更逐行披露 = 办理时“容器 transferItems.contractChange 可见 ∩ 逐行合同对象权限 ∩ 节点表单”：
 *    办理时看不到容器，之后被授予容器查看权，审批中心已办详情与调动明细读接口都不得给出合同 ID / 终止日 / 原值；
 *  - P2-2 头 PATCH 的 400、删组织行的 409、整单校验的信封里的调动行 ID，按“看得到的调动行”折叠：
 *    任职 / 组织范围外的行与调动分区字段全被遮蔽时的行，一律不带行 ID，与读接口同一规则。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { oaNodes } from './AC-OA-approval-support.js';
import { transferWorld } from './AC-OA-11cb-support.js';
import { newOrg } from './AC-OA-items-support.js';
import { uniqueSuffix } from './support/unique.js';
import { ALL, bodyOf, expectError, onlyPeople } from './AC-OA-head-support.js';

const testDb = useTestDb();
const CONTAINER = 'transferItems.contractChange';
const TRANSFER_FIELDS = [
  'employeeId',
  'departmentId',
  'positionId',
  'postId',
  'levelId',
  'directManagerId',
  'dutyTransfer',
  'trial',
  'adjustSalary',
  'withEstablishment',
  'contractChange',
].map((field) => `transferItems.${field}`);
const CONTRACT_END = '2029-10-09';

describe('P1-4 办理时看不到合同变更容器：之后被授予也不得在已办详情里展开', () => {
  async function handledBlind(label: string) {
    const w = await transferWorld(testDb().db, label, { nodes: oaNodes([{ actions: { transfer: true } }]) });
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    const mover = await w.staff(w.a);
    const contractId = await w.contractOf(mover);
    const itemId = await w.seed(view.id, mover, {
      linkageInput: { contract: { targetId: contractId, fields: { endDate: CONTRACT_END } } },
    });
    await w.submitted(view.id);
    // 办理时：合同对象与逐行权限都有，但看不到调动明细的“合同变更”容器
    w.access.hiddenByUser.set(w.hrbp.userId, new Set([CONTAINER]));
    const target = await w.member('转交目标');
    const instance = await w.instance(view.id);
    const task = instance.tasks.find((t) => t.status === 'pending')!;
    const moved = await w.call(
      'POST',
      `/api/tenant/approval/tasks/${task.id}/transfer`,
      { ifMatch: instance.revision, body: { toUserId: target, comment: '转交' } },
      w.hrbp.userId,
    );
    expect(moved.status, await moved.clone().text()).toBe(200);
    return { w, view, itemId, contractId };
  }

  it('授予容器查看权后：调动明细读接口不给合同变更，审批中心已办详情同样不给合同 ID / 终止日 / 逐行编码', async () => {
    const { w, view, itemId, contractId } = await handledBlind('r3-container-grant');
    w.access.hiddenByUser.delete(w.hrbp.userId); // 之后授予容器查看权

    const read = await w.call(
      'GET',
      `/api/tenant/org-adjustment/adjustments/${view.id}/items/transfer`,
      {},
      w.hrbp.userId,
    );
    const items = ((await bodyOf(read)) as unknown as { items: { id: string; contractChange: unknown }[] }).items;
    expect(items.find((item) => item.id === itemId)!.contractChange).toBeNull();

    const detail = await w.detail((await w.instance(view.id)).id, w.hrbp.userId);
    const text = JSON.stringify({ form: detail.form, logs: detail.logs });
    expect(Object.keys(detail.form.values).filter((code) => code.includes('.contractChange.'))).toEqual([]);
    expect(Object.keys(detail.form.originals ?? {}).filter((code) => code.includes('.contractChange.'))).toEqual([]);
    expect(text).not.toContain(contractId);
    expect(text).not.toContain(CONTRACT_END);
  });
});

describe('P2-2 错误信封里的调动行 ID 按看得到的调动行折叠', () => {
  async function scoped(label: string) {
    const w = await transferWorld(testDb().db, label);
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    const [visible, hidden] = [await w.staff(w.a), await w.staff(w.a)];
    const visibleRow = await w.seed(view.id, visible);
    const hiddenRow = await w.seed(view.id, hidden);
    return { w, view, visible, hidden, visibleRow, hiddenRow };
  }
  const narrow = async (w: Awaited<ReturnType<typeof transferWorld>>, id: string) =>
    w.patch(id, { adjustmentRange: [w.a] }, (await w.stored(id))!.revision);

  it('头 PATCH 缩小范围的 400：任职范围外的调动行不带行 ID', async () => {
    const { w, view, visible, visibleRow, hiddenRow } = await scoped('r3-head-400-scope');
    w.access.employment = onlyPeople(w.a, visible);

    const res = await narrow(w, view.id);

    await expectError(res, 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_OUT_OF_RANGE');
    const text = await res.clone().text();
    expect(text).toContain(visibleRow);
    expect(text).not.toContain(hiddenRow);
  });

  it('头 PATCH 缩小范围的 400：调动分区字段全部被遮蔽时一行 ID 都不给', async () => {
    const { w, view, visibleRow, hiddenRow } = await scoped('r3-head-400-fields');
    for (const field of TRANSFER_FIELDS) w.access.hiddenFields.add(field);

    const res = await narrow(w, view.id);

    await expectError(res, 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_OUT_OF_RANGE');
    const text = await res.clone().text();
    expect(text).not.toContain(visibleRow);
    expect(text).not.toContain(hiddenRow);
  });

  it('整单校验信封：范围外与字段全遮蔽的调动行问题不带行 ID', async () => {
    const w = await transferWorld(testDb().db, 'r3-check-envelope');
    const view = await w.created(w.headBody({ adjustmentRange: [w.a] })); // 目标 B 不在范围：调动行都有 OUT_OF_RANGE 问题
    const [visible, hidden] = [await w.staff(w.a), await w.staff(w.a)];
    const visibleRow = await w.seed(view.id, visible);
    const hiddenRow = await w.seed(view.id, hidden);
    w.access.employment = onlyPeople(w.a, visible);

    const scopeText = JSON.stringify((await w.checked(view.id)).errors);
    expect(scopeText).toContain(visibleRow);
    expect(scopeText).not.toContain(hiddenRow);

    w.access.employment = ALL;
    for (const field of TRANSFER_FIELDS) w.access.hiddenFields.add(field);
    const fieldText = JSON.stringify((await w.checked(view.id)).errors);
    expect(fieldText).not.toContain(visibleRow);
    expect(fieldText).not.toContain(hiddenRow);
  });

  it('删组织行被调动行引用的 409：调动分区字段全部被遮蔽时不带行 ID 与分区', async () => {
    const w = await transferWorld(testDb().db, 'r3-delete-409-fields');
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    const orgItemId = (await w.item(view.id, newOrg(w.a, { name: `ZZ_被引用组织${uniqueSuffix()}` }))).items[0]!.id;
    const row = await w.seed(view.id, await w.staff(w.a), { departmentId: null, departmentItemId: orgItemId });
    for (const field of TRANSFER_FIELDS) w.access.hiddenFields.add(field);

    const res = await w.deleteItem(view.id, orgItemId);

    await expectError(res, 409, 'CONFLICT', 'ORG_ADJUSTMENT_ITEM_REFERENCED');
    const text = await res.clone().text();
    expect(text).not.toContain(row);
    expect(text).not.toContain('"section"');
  });
});
