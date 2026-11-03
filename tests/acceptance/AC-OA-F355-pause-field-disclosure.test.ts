/**
 * F-355（BE-11a 组织暂停错误 adjustmentCode 可见性裁剪，DEC-406；后补-权限，并入 F-087；与 F-342 共用一组实现）：
 * 暂停类错误的 adjustmentCode 就是调整单的“编码”字段（OrganizationApproval.code），
 * 字段查看权也要过：看不到该字段的人只给通用提示；撤销字段限制后（同一人再次操作）立即恢复，不缓存上一次的判定。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { headWorld } from './AC-OA-head-support.js';
import { approvalFixture } from './AC-OA-read-support.js';
import { pauseOrgs } from './support/org-adjustment-execution.js';

const testDb = useTestDb();
const ORGS = '/api/tenant/org/organizations';

async function pausedWorld(label: string) {
  const w = await headWorld(testDb().db, label);
  const view = await w.created(w.head({ adjustmentRange: [w.a] }));
  await pauseOrgs(w.db, w.tenant.id, view.id, [w.a]);
  const create = () =>
    w.call('POST', ORGS, { ifMatch: 0, body: { name: '暂停下新建', parents: { admin: { parentId: w.a } } } });
  return { w, view, create };
}

async function details(response: Response) {
  expect(response.status, await response.clone().text()).toBe(409);
  const text = await response.text();
  const body = JSON.parse(text) as { error: { details: Record<string, unknown> } };
  return { details: body.error.details, text };
}

describe('F-355 暂停原因 adjustmentCode 的字段查看权', () => {
  it('看不到调整单“编码”字段 → 通用提示；其余字段不可见不影响编码披露', async () => {
    const { w, view, create } = await pausedWorld('f355-field');
    w.access.hiddenFields = new Set(['code']);
    const hidden = await details(await create());
    expect(hidden.details).toEqual({ reason: 'ORG_ADJUSTMENT_EXECUTING' });
    expect(hidden.text).not.toContain(view.code);

    w.access.hiddenFields = new Set(['subject', 'content', 'adjustmentRange']);
    expect((await details(await create())).details).toEqual({
      reason: 'ORG_ADJUSTMENT_EXECUTING',
      adjustmentCode: view.code,
    });
  });

  it('审批人路径（无对象查看权）：能打开实例，但“编码”不在节点可填字段目录内 → 通用提示', async () => {
    const w = await headWorld(testDb().db, 'f355-approver');
    const approver = await w.member('合成审批人');
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    await approvalFixture(w, view.id, approver, ['subject', 'effectiveDate']);
    await pauseOrgs(w.db, w.tenant.id, view.id, [w.a]);
    w.access.viewDenied = true;
    const body = { name: '审批人新建', parents: { admin: { parentId: w.a } } };
    const hidden = await details(await w.call('POST', ORGS, { ifMatch: 0, body }, approver));
    expect(hidden.details).toEqual({ reason: 'ORG_ADJUSTMENT_EXECUTING' });
    expect(hidden.text).not.toContain(view.code);
  });
});
