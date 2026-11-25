/**
 * BE-11c-b 第 6 轮 P2-1（R2-T08 §6.3 / §8.3）：越界值的字段来源与信封裁剪一致。
 * `outOfRange` 命中的可能是目标组织（`orgItems.targetOrgId`）也可能是新上级（`orgItems.parentOrgId`）：
 * 错误信封里的 `orgId` 必须按实际命中的字段用节点披露集裁剪，与读接口同口径。公开 HTTP 回归：
 *  - 审批人编辑（POST /api/tenant/approval/tasks/:id/edit）缩小范围的 400：A 移到 B 下，节点开放目标组织、隐藏新上级
 *    → 不带 B；节点开放新上级、隐藏目标组织 → 带 B（读组织分区 200 也能看到 B）；
 *  - 同根因：HR 头 PATCH 同口径；调动行越界的 `orgId`（来源 / 目标部门）随 `transferItems.departmentId`，不随
 *    `orgItems.targetOrgId`。
 * 两个方向都保留可见行 ID 与业务码。
 */
import { useTestDb } from '@italent/testkit';
import { ORG_ADJUSTMENT_FORM_FIELDS } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { oaNodes } from './AC-OA-approval-support.js';
import { transferWorld, type TransferWorld } from './AC-OA-11cb-support.js';
import { bodyOf, expectError } from './AC-OA-head-support.js';
import { rename } from './AC-OA-items-support.js';

const testDb = useTestDb();
const OUT_OF_RANGE = 'ORG_ADJUSTMENT_OUT_OF_RANGE';

/** 审批人只能走审批路径读（没有申请单对象查看权）；节点表单按条件丢字段。 */
async function blindWorld(label: string, keep: (code: string) => boolean) {
  const formFields = ORG_ADJUSTMENT_FORM_FIELDS.filter(keep);
  const w = await transferWorld(testDb().db, label, {
    nodes: oaNodes([{ formFields, editableFields: ['adjustmentRange'] }]),
  });
  const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
  return { w, view };
}
/** A 移到 B 下：目标 = A（在缩小后的范围内），新上级 = B（缩小后越界）。 */
const moveAUnderB = (w: TransferWorld) => rename(w.a, { name: undefined, parent: { orgId: w.b } });
const read = (w: TransferWorld, id: string) =>
  w.call('GET', `/api/tenant/org-adjustment/adjustments/${id}/items/org`, {}, w.hrbp.userId);
const narrow = (w: TransferWorld, id: string) => w.act(id, w.hrbp, 'edit', { fields: { adjustmentRange: [w.a] } });

describe('P2-1 越界信封按命中的字段（目标组织 / 新上级）裁剪', () => {
  it('节点开放目标组织、隐藏新上级：缩小范围的 400 不带新上级 B，行 ID 与业务码保留', async () => {
    const { w, view } = await blindWorld('r6-parent-hidden', (code) => code !== 'orgItems.parentOrgId');
    const rowId = (await w.item(view.id, moveAUnderB(w))).items[0]!.id;
    await w.submitted(view.id);
    w.access.viewDenied = true;
    const got = await read(w, view.id);
    expect(got.status, await got.clone().text()).toBe(200);
    expect(await got.clone().text(), '读接口看不到新上级').not.toContain(w.b);

    const res = await narrow(w, view.id);

    await expectError(res, 400, 'VALIDATION_FAILED', OUT_OF_RANGE);
    const text = await res.clone().text();
    expect(text, '可见行 ID 保留').toContain(rowId);
    expect(text, '信封不得带出节点隐藏的新上级 ID').not.toContain(w.b);
  });

  it('节点开放新上级、隐藏目标组织：缩小范围的 400 带新上级 B（与读接口 200 一致，不过度裁剪）', async () => {
    const { w, view } = await blindWorld('r6-target-hidden', (code) => code !== 'orgItems.targetOrgId');
    const rowId = (await w.item(view.id, moveAUnderB(w))).items[0]!.id;
    await w.submitted(view.id);
    w.access.viewDenied = true;
    const got = await read(w, view.id);
    expect(got.status, await got.clone().text()).toBe(200);
    expect(await got.clone().text(), '读接口能看到新上级').toContain(w.b);

    const res = await narrow(w, view.id);

    await expectError(res, 400, 'VALIDATION_FAILED', OUT_OF_RANGE);
    const text = await res.clone().text();
    expect(text, '可见行 ID 保留').toContain(rowId);
    expect(text, '新上级可见，信封带出越界的 B').toContain(w.b);
  });

  it('同根因：HR 头 PATCH 缩小范围的 400 同口径——字段权限遮蔽新上级则不带 B，遮蔽目标组织则带 B', async () => {
    const hidden = await blindWorld('r6-hr-parent-hidden', () => true);
    await hidden.w.item(hidden.view.id, moveAUnderB(hidden.w));
    hidden.w.access.hiddenFields.add('orgItems.parentOrgId');
    const stored = (await hidden.w.stored(hidden.view.id))!.revision;
    const res = await hidden.w.patch(hidden.view.id, { adjustmentRange: [hidden.w.a] }, stored);
    await expectError(res, 400, 'VALIDATION_FAILED', OUT_OF_RANGE);
    expect(await res.clone().text(), 'HR 路径也不带被遮蔽的新上级').not.toContain(hidden.w.b);

    const open = await blindWorld('r6-hr-target-hidden', () => true);
    await open.w.item(open.view.id, moveAUnderB(open.w));
    open.w.access.hiddenFields.add('orgItems.targetOrgId');
    const revision = (await open.w.stored(open.view.id))!.revision;
    const kept = await open.w.patch(open.view.id, { adjustmentRange: [open.w.a] }, revision);
    await expectError(kept, 400, 'VALIDATION_FAILED', OUT_OF_RANGE);
    expect(await kept.clone().text(), '新上级可见则带 B').toContain(open.w.b);
  });
});

describe('同根因：调动行越界值的字段来源是 transferItems.departmentId', () => {
  /** 范围只含 A，员工在 A，目标部门选 B（越界）：HR 新增调动行 → 400 带顶层 orgId。 */
  async function overRange(label: string, hide: string) {
    const w = await transferWorld(testDb().db, label);
    const mover = await w.staff(w.a);
    const view = await w.created(w.headBody({ adjustmentRange: [w.a] }));
    w.access.hiddenFields.add(hide);
    return { w, res: await w.addTransfer(view.id, w.transferBody(mover, { orgId: w.b })) };
  }

  it('隐藏 transferItems.departmentId（orgItems.targetOrgId 可见）→ 400 不带越界部门 ID', async () => {
    const { w, res } = await overRange('r6-transfer-hidden', 'transferItems.departmentId');

    await expectError(res, 400, 'VALIDATION_FAILED', OUT_OF_RANGE);
    expect(await res.clone().text(), '部门字段被遮蔽，不带出').not.toContain(w.b);
  });

  it('隐藏 orgItems.targetOrgId（transferItems.departmentId 可见）→ 400 照常带越界部门 ID', async () => {
    const { w, res } = await overRange('r6-transfer-open', 'orgItems.targetOrgId');

    await expectError(res, 400, 'VALIDATION_FAILED', OUT_OF_RANGE);
    expect((await bodyOf(res)).error?.details?.orgId, '部门字段可见，不过度裁剪').toBe(w.b);
  });
});
