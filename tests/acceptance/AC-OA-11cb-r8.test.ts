/**
 * BE-11c-b 第 8 轮 P2（R2-T08 §6.3 / F-339 ②、DEC-1010）：审批编辑回调的错误信封按审批中心“节点字段 ∩ 对象字段权”披露集裁剪，
 * 不走 HR 优先的通用详情入口。
 * 审批人同时有 HR 查看权时（对象字段权允许新上级、隐藏目标组织；当前审批节点隐藏新上级）：
 *  - HR 明细入口（HR 路径，对象字段权）能看到停用的新上级 B；
 *  - 审批中心实例详情（节点字段 ∩ 对象字段权）看不到 B；
 *  - 审批人只改标题的编辑 400 ORG_ADJUSTMENT_ORG_INACTIVE 同样省略 B，仍保留可见行 ID 与业务码；
 *  - 节点开放新上级且对象字段权允许时仍带出（节点正向用例见 AC-OA-11cb-r7），F-427 发起人提交 / 重提裁剪不变。
 */
import { useTestDb } from '@italent/testkit';
import { ORG_ADJUSTMENT_FORM_FIELDS } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { oaNodes } from './AC-OA-approval-support.js';
import { transferWorld } from './AC-OA-11cb-support.js';
import { expectError } from './AC-OA-head-support.js';
import { newOrg } from './AC-OA-items-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const INACTIVE = 'ORG_ADJUSTMENT_ORG_INACTIVE';

/**
 * 范围 A：新增组织挂在范围内的既有上级 B（A 的下级）下并提交；随后 B 被停用。
 * 审批人（hrbp）保留 HR 查看权（不置 viewDenied）：对象字段权隐藏目标组织、允许新上级；节点表单 keepNode 决定节点披露。
 */
async function hrViewerWorld(label: string, keepNode: (code: string) => boolean) {
  const formFields = ORG_ADJUSTMENT_FORM_FIELDS.filter(keepNode);
  const w = await transferWorld(testDb().db, label, {
    nodes: oaNodes([{ formFields, editableFields: ['subject'] }]),
  });
  const parent = await w.org(`上级${uniqueSuffix()}`, w.a);
  const view = await w.created(w.headBody({ adjustmentRange: [w.a] }));
  const rowId = (await w.item(view.id, newOrg(parent))).items[0]!.id;
  await w.submitted(view.id);
  await w.disable(parent);
  w.access.hiddenFields.add('orgItems.targetOrgId');
  return { w, view, rowId, parent };
}
const hrItems = (w: Awaited<ReturnType<typeof hrViewerWorld>>['w'], id: string) =>
  w.call('GET', `/api/tenant/org-adjustment/adjustments/${id}/items/org`, {}, w.hrbp.userId);

describe('P2 审批编辑回调改用审批中心节点披露集（审批人兼有 HR 查看权）', () => {
  it('节点隐藏新上级：HR 明细看得到 B，审批详情与编辑 400 都省略 B，保留可见行 ID 与业务码', async () => {
    const { w, view, rowId, parent } = await hrViewerWorld('r8-hr-node-hidden', (c) => c !== 'orgItems.parentOrgId');

    const hr = await hrItems(w, view.id);
    expect(hr.status, await hr.clone().text()).toBe(200);
    expect(await hr.clone().text(), 'HR 明细入口（对象字段权）能看到新上级 B').toContain(parent);
    const instance = await w.instance(view.id);
    const detail = await w.call('GET', `/api/tenant/approval/instances/${instance.id}`, {}, w.hrbp.userId);
    expect(detail.status, await detail.clone().text()).toBe(200);
    expect(await detail.clone().text(), '审批中心实例详情（节点字段 ∩ 对象字段权）看不到 B').not.toContain(parent);

    const res = await w.act(view.id, w.hrbp, 'edit', { fields: { subject: `改标题${uniqueSuffix()}` } });

    await expectError(res, 400, 'VALIDATION_FAILED', INACTIVE);
    const text = await res.clone().text();
    expect(text, '可见行 ID 保留').toContain(rowId);
    expect(text, '节点隐藏新上级：编辑 400 不得带出 B，即使审批人另有 HR 查看权').not.toContain(parent);
  });

  it('节点开放新上级（对象字段权也允许）：编辑 400 带出 B（对照：HR 查看权不吞掉节点正向披露）', async () => {
    const { w, view, rowId, parent } = await hrViewerWorld('r8-hr-node-open', () => true);

    const res = await w.act(view.id, w.hrbp, 'edit', { fields: { subject: `改标题${uniqueSuffix()}` } });

    await expectError(res, 400, 'VALIDATION_FAILED', INACTIVE);
    const text = await res.clone().text();
    expect(text, '可见行 ID 保留').toContain(rowId);
    expect(text, '节点开放新上级且对象字段权允许：带出 B').toContain(parent);
  });
});
