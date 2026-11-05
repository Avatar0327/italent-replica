/**
 * F-427（R2-T08 §6.3，F-339 ②）：审批中心重提（已驳回退回单）的校验类错误按重提人的字段查看权裁剪——
 * 看不到的字段不得出现在错误里（字段名、值、提示文案）。路由 10 已有同口径裁剪，这里补审批中心入口。
 * 触发用 ORG_INACTIVE：驳回后新增行的上级被停用，整单校验的问题带上级组织 ID（orgItems.targetOrgId 同口径）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld } from './AC-OA-approval-support.js';
import { bodyOf, expectError } from './AC-OA-head-support.js';
import { newOrg } from './AC-OA-items-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();

async function rejectedWithInactiveParent(label: string) {
  const w = await flowWorld(testDb().db, label);
  const parent = await w.org(`上级${uniqueSuffix()}`, w.a);
  const view = await w.created();
  const itemId = (await w.item(view.id, newOrg(parent))).items[0]!.id;
  await w.submitted(view.id);
  await w.acted(view.id, w.hrbp, 'reject');
  await w.disable(parent);
  return { w, id: view.id, itemId, parent };
}

describe('F-427 审批中心重提的校验错误按查看权裁剪', () => {
  it('看得到 orgItems.targetOrgId：400 ORG_INACTIVE 带出上级组织 ID（正向对照）', async () => {
    const { w, id, itemId, parent } = await rejectedWithInactiveParent('f427-visible');
    const res = await w.instanceAction(id, 'resubmit');
    await expectError(res, 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_ORG_INACTIVE');
    expect((await bodyOf(res)).error?.details?.items).toEqual([
      expect.objectContaining({ section: 'org', itemId, orgId: parent }),
    ]);
  });

  it('看不到 orgItems.targetOrgId：同一错误不带组织 ID，整个响应里也找不到该组织；单据仍 6', async () => {
    const { w, id, itemId, parent } = await rejectedWithInactiveParent('f427-hidden');
    w.access.hiddenFields.add('orgItems.targetOrgId');
    const res = await w.instanceAction(id, 'resubmit');
    const text = await res.clone().text();
    await expectError(res, 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_ORG_INACTIVE');
    const items = (await bodyOf(res)).error?.details?.items as Record<string, unknown>[];
    expect(items).toEqual([expect.objectContaining({ section: 'org', itemId })]);
    expect(items[0]).not.toHaveProperty('orgId');
    expect(text).not.toContain(parent);
    expect((await w.state(id)).approval).toBe(6);
  });
});
