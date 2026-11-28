/**
 * BE-11c-b 第 7 轮 P2①（R2-T08 §6.3 / F-339 ②、F-427）：停用的新上级（ORG_INACTIVE）按审批节点实际披露的字段裁剪。
 * 新上级与目标组织的查看权不能在所有出口绑在一起：
 *  - 审批人编辑（POST /api/tenant/approval/tasks/:id/edit）只改标题时，整单校验 400 ORG_ADJUSTMENT_ORG_INACTIVE：
 *    节点只开放 orgItems.parentOrgId → 带出停用的新上级 B（读接口 200 同样看得到 B）；
 *    节点只开放 orgItems.targetOrgId → 不带 B（读接口也看不到 B）；
 *  - 两个方向都保留可见行 ID 与业务码；
 *  - F-427 发起人重提的既有裁剪（AC-OA-F427-resubmit-error-trim）不变，这里同用例再钉一遍“只隐藏目标组织也不带”。
 */
import { useTestDb } from '@italent/testkit';
import { ORG_ADJUSTMENT_FORM_FIELDS } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { flowWorld, oaNodes } from './AC-OA-approval-support.js';
import { transferWorld, type TransferWorld } from './AC-OA-11cb-support.js';
import { expectError } from './AC-OA-head-support.js';
import { newOrg } from './AC-OA-items-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const INACTIVE = 'ORG_ADJUSTMENT_ORG_INACTIVE';

/** 范围 A：新增组织挂在范围内的既有上级 B（A 的下级）下并提交；随后 B 被停用。节点只开放 keep 里的字段，审批人只能走审批路径读。 */
async function inactiveParentWorld(label: string, keep: (code: string) => boolean) {
  const formFields = ORG_ADJUSTMENT_FORM_FIELDS.filter(keep);
  const w = await transferWorld(testDb().db, label, {
    nodes: oaNodes([{ formFields, editableFields: ['subject'] }]),
  });
  const parent = await w.org(`上级${uniqueSuffix()}`, w.a);
  const view = await w.created(w.headBody({ adjustmentRange: [w.a] }));
  const rowId = (await w.item(view.id, newOrg(parent))).items[0]!.id;
  await w.submitted(view.id);
  await w.disable(parent);
  w.access.viewDenied = true;
  return { w, view, rowId, parent };
}
const read = (w: TransferWorld, id: string) =>
  w.call('GET', `/api/tenant/org-adjustment/adjustments/${id}/items/org`, {}, w.hrbp.userId);
const editTitle = (w: TransferWorld, id: string) =>
  w.act(id, w.hrbp, 'edit', { fields: { subject: `改标题${uniqueSuffix()}` } });

describe('P2① 审批节点按 orgItems.parentOrgId 裁剪停用的新上级', () => {
  it('节点只开放新上级：400 带停用的新上级 B（与读接口 200 一致），保留行 ID 与业务码', async () => {
    const keep = (code: string) => code !== 'orgItems.targetOrgId';
    const { w, view, rowId, parent } = await inactiveParentWorld('r7-parent-open', keep);
    const got = await read(w, view.id);
    expect(got.status, await got.clone().text()).toBe(200);
    expect(await got.clone().text(), '读接口能看到新上级').toContain(parent);

    const res = await editTitle(w, view.id);

    await expectError(res, 400, 'VALIDATION_FAILED', INACTIVE);
    const text = await res.clone().text();
    expect(text, '可见行 ID 保留').toContain(rowId);
    expect(text, '新上级字段可见，信封带出停用的 B').toContain(parent);
  });

  it('节点只开放目标组织：400 不带停用的新上级 B（读接口也看不到），保留行 ID 与业务码', async () => {
    const keep = (code: string) => code !== 'orgItems.parentOrgId';
    const { w, view, rowId, parent } = await inactiveParentWorld('r7-target-open', keep);
    const got = await read(w, view.id);
    expect(got.status, await got.clone().text()).toBe(200);
    expect(await got.clone().text(), '读接口看不到新上级').not.toContain(parent);

    const res = await editTitle(w, view.id);

    await expectError(res, 400, 'VALIDATION_FAILED', INACTIVE);
    const text = await res.clone().text();
    expect(text, '可见行 ID 保留').toContain(rowId);
    expect(text, '新上级字段被遮蔽，信封不带 B').not.toContain(parent);
  });
});

describe('P2① 保留 F-427：发起人重提仍随 orgItems.targetOrgId（且新上级字段也须可见）', () => {
  async function rejected(label: string, hide: string) {
    const w = await flowWorld(testDb().db, label);
    const parent = await w.org(`上级${uniqueSuffix()}`, w.a);
    const view = await w.created();
    const itemId = (await w.item(view.id, newOrg(parent))).items[0]!.id;
    await w.submitted(view.id);
    await w.acted(view.id, w.hrbp, 'reject');
    await w.disable(parent);
    w.access.hiddenFields.add(hide);
    return { parent, itemId, res: await w.instanceAction(view.id, 'resubmit') };
  }

  it('只隐藏 orgItems.targetOrgId → 重提的 400 不带停用的新上级', async () => {
    const { parent, itemId, res } = await rejected('r7-f427-target', 'orgItems.targetOrgId');
    await expectError(res, 400, 'VALIDATION_FAILED', INACTIVE);
    const text = await res.clone().text();
    expect(text).toContain(itemId);
    expect(text).not.toContain(parent);
  });

  it('只隐藏 orgItems.parentOrgId → 重提的 400 同样不带停用的新上级', async () => {
    const { parent, res } = await rejected('r7-f427-parent', 'orgItems.parentOrgId');
    await expectError(res, 400, 'VALIDATION_FAILED', INACTIVE);
    expect(await res.clone().text()).not.toContain(parent);
  });
});
