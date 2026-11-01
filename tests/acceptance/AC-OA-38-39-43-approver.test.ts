/**
 * BE-10c 审批侧：AC-OA-38 暂存行不进提交 / 同意的基线判断（DEC-644 A-8，§2.5）；AC-OA-39 审批中编辑经适配器复核
 * 审批人对主体组织的申请单范围（§9.3）；AC-OA-43 审批中编辑另须 EditApprovalIngApply（OA-R7），撤回无按钮。
 * EditApprovalIngApply 的语义按名称推断（待取证）。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type FlowWorld, flowWorld } from './AC-OA-approval-support.js';
import { expectError, only } from './AC-OA-head-support.js';
import { newOrg, rename } from './AC-OA-items-support.js';

const testDb = useTestDb();

/** 审批中的单据现状：头、明细、revision、实例业务版本一并比较。 */
async function snapshotOf(w: FlowWorld, id: string) {
  return {
    stored: await w.stored(id),
    rows: await w.rows(id),
    state: await w.state(id),
    businessVersion: await w.businessVersion(id),
  };
}

describe('AC-OA-38 暂存行：提交 / 同意只判非暂存行', () => {
  it('暂存行目标被改：提交与同意都不拦；非暂存行目标被改才拦', async () => {
    const w = await flowWorld(testDb().db, 'oa38-approve');
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    await w.item(view.id, rename(w.a));
    await w.item(view.id, rename(w.b, { isStaged: true }));
    await w.touchOrg(w.b);
    await w.submitted(view.id);
    await w.touchOrg(w.b);
    await w.acted(view.id, w.hrbp, 'approve');
    await w.touchOrg(w.a);
    await expectError(await w.act(view.id, w.head, 'approve'), 409, 'CONFLICT', 'ORG_ADJUSTMENT_BASELINE_CHANGED');
    expect((await w.state(view.id)).approval).toBe(1);
  });

  it('非暂存行引用暂存行 → 提交 400 STAGED_REFERENCE', async () => {
    const w = await flowWorld(testDb().db, 'oa38-ref');
    const view = await w.created();
    const staged = await w.item(view.id, newOrg(w.a, { isStaged: true }));
    await w.item(view.id, newOrg(w.a, { parent: { itemId: staged.items[0]!.id } }));
    await expectError(await w.submit(view.id), 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_STAGED_REFERENCE');
    expect((await w.state(view.id)).approval).toBe(0);
  });
});

describe('AC-OA-39 审批中编辑复核审批人的申请单范围', () => {
  it('主体组织出了审批人范围 → 编辑被拒，头 / 明细 / revision / 实例版本都不变；仍能读披露集', async () => {
    const w = await flowWorld(testDb().db, 'oa39-approver');
    const { id, itemId } = await w.draft();
    await w.submitted(id);
    w.access.main = only(w.b);
    const before = await snapshotOf(w, id);
    const res = await w.act(id, w.hrbp, 'edit', {
      fields: { subject: '范围外改', 'orgItems.name': [{ itemId, value: '范围外改名' }] },
    });
    expect([403, 404], await res.clone().text()).toContain(res.status);
    expect(await snapshotOf(w, id)).toEqual(before);
    const detail = await w.detail((await w.instance(id)).id, w.hrbp.userId);
    expect(detail.form.values).toHaveProperty('orgItems.name');
  });

  it('范围外与不存在的明细行同口径（不泄露存在性）', async () => {
    const w = await flowWorld(testDb().db, 'oa39-same');
    const { id } = await w.draft();
    await w.submitted(id);
    const missing = await w.act(id, w.hrbp, 'edit', {
      fields: { 'orgItems.name': [{ itemId: randomUUID(), value: '不存在' }] },
    });
    expect(missing.status, await missing.clone().text()).toBe(400);
    const other = await flowWorld(testDb().db, 'oa39-other');
    const foreign = await other.draft();
    const crossed = await w.act(id, w.hrbp, 'edit', {
      fields: { 'orgItems.name': [{ itemId: foreign.itemId, value: '别人的行' }] },
    });
    expect(crossed.status).toBe(missing.status);
    expect(await crossed.json()).toEqual(await missing.json());
  });
});

describe('AC-OA-43 审批编辑按钮与撤回入口', () => {
  it('审批人缺 EditApprovalIngApply → 编辑 403，单据不变；同意不受影响', async () => {
    const w = await flowWorld(testDb().db, 'oa43-approver');
    const { id } = await w.draft();
    await w.submitted(id);
    w.access.deniedButtons.add('EditApprovalIngApply');
    const before = await snapshotOf(w, id);
    expect((await w.act(id, w.hrbp, 'edit', { fields: { subject: '无按钮改' } })).status).toBe(403);
    expect(await snapshotOf(w, id)).toEqual(before);
    await w.acted(id, w.hrbp, 'approve');
  });

  it('撤回不要按钮：申请人缺全部按钮仍可撤回', async () => {
    const w = await flowWorld(testDb().db, 'oa43-withdraw');
    const { id } = await w.draft();
    await w.submitted(id);
    for (const code of ['EditAdjustOrgDetailBtn', 'EditApprovalIngApply', 'OrganizationApprovalDelete']) {
      w.access.deniedButtons.add(code);
    }
    const res = await w.withdraw(id);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await w.state(id)).approval).toBe(0);
  });
});
