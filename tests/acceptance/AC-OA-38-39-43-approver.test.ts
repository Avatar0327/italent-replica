/**
 * BE-10c 审批侧：AC-OA-38 暂存行不进提交 / 同意的基线判断（DEC-644 A-8，§2.5）；AC-OA-39 审批中编辑经适配器复核
 * 审批人对主体组织的申请单范围（§9.3）；AC-OA-43 审批中编辑另须 EditApprovalIngApply（OA-R7），撤回无按钮。
 * EditApprovalIngApply 的语义按名称推断（待取证）。
 * 第 2 轮（R2-T08 §4.4）：审批中编辑与提交 / 重提走同一套整单校验（改后完整候选状态），头与明细一次校验一次写入；
 * 同意前（beforeApprove）也跑同一套校验兜底。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type FlowWorld, flowWorld, oaNodes } from './AC-OA-approval-support.js';
import { expectError, only } from './AC-OA-head-support.js';
import { newOrg, rename } from './AC-OA-items-support.js';

const testDb = useTestDb();
const OUT_OF_RANGE = 'ORG_ADJUSTMENT_OUT_OF_RANGE';

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

/** n1 另开放上级与调整范围（第 2 轮回归用）。 */
const wideNodes = () =>
  oaNodes([
    {
      editableFields: ['subject', 'content', 'adjustmentRange', 'orgItems.name', 'orgItems.parentOrgId'],
    },
  ]);

/** 草稿：暂存新增行 S + 非暂存新增行 L（都挂在 a 下），提交进审批。 */
async function stagedPair(w: FlowWorld) {
  const view = await w.created();
  const staged = (await w.item(view.id, newOrg(w.a, { isStaged: true }))).items[0]!.id;
  const live = (await w.item(view.id, newOrg(w.a))).items[0]!.id;
  await w.submitted(view.id);
  return { id: view.id, staged, live };
}

describe('AC-OA-38 AC-OA-43 第 2 轮：审批中编辑与提交同一套整单校验（§4.4）', () => {
  it('把非暂存行的上级改指暂存行 → 400 STAGED_REFERENCE，头 / 明细 / revision / 实例版本都不变', async () => {
    const w = await flowWorld(testDb().db, 'oa-r2-staged', { nodes: wideNodes() });
    const { id, staged, live } = await stagedPair(w);
    const before = await snapshotOf(w, id);
    const res = await w.act(id, w.hrbp, 'edit', {
      fields: { 'orgItems.parentOrgId': [{ itemId: live, value: { itemRef: staged } }] },
    });
    await expectError(res, 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_STAGED_REFERENCE');
    expect(await snapshotOf(w, id)).toEqual(before);
  });

  it('非暂存行基线过期 → 编辑 409 BASELINE_CHANGED（不得 200），单据不变', async () => {
    const w = await flowWorld(testDb().db, 'oa-r2-baseline');
    const { id } = await w.draft();
    await w.submitted(id);
    await w.touchOrg(w.a);
    const before = await snapshotOf(w, id);
    const res = await w.act(id, w.hrbp, 'edit', { fields: { subject: '基线过期仍改' } });
    await expectError(res, 409, 'CONFLICT', 'ORG_ADJUSTMENT_BASELINE_CHANGED');
    expect(await snapshotOf(w, id)).toEqual(before);
  });

  it('同意兜底：绕过编辑直接造出引用暂存行的状态 → 同意 400 STAGED_REFERENCE，仍审批中', async () => {
    const w = await flowWorld(testDb().db, 'oa-r2-approve');
    const { id, staged, live } = await stagedPair(w);
    // 可信夹具：直接改库，模拟任何绕过编辑入口造成的非法状态
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`UPDATE org_adjustment_org_items SET parent_org_id = NULL, parent_item_id = ${staged}
        WHERE id = ${live}`),
    );
    await expectError(await w.act(id, w.hrbp, 'approve'), 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_STAGED_REFERENCE');
    expect((await w.state(id)).approval).toBe(1);
  });

  it('一次同时改范围 a → b 与新增行上级 a → b：单看任一步都非法、组合合法 → 200，revision 只 + 1', async () => {
    const w = await flowWorld(testDb().db, 'oa-r2-combined', { nodes: wideNodes() });
    const view = await w.created();
    const live = (await w.item(view.id, newOrg(w.a))).items[0]!.id;
    await w.submitted(view.id);
    const before = await snapshotOf(w, view.id);
    for (const fields of [{ adjustmentRange: [w.b] }, { 'orgItems.parentOrgId': [{ itemId: live, value: w.b }] }]) {
      await expectError(await w.act(view.id, w.hrbp, 'edit', { fields }), 400, 'VALIDATION_FAILED', OUT_OF_RANGE);
    }
    expect(await snapshotOf(w, view.id)).toEqual(before);
    const res = await w.act(view.id, w.hrbp, 'edit', {
      fields: { adjustmentRange: [w.b], 'orgItems.parentOrgId': [{ itemId: live, value: w.b }] },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await w.stored(view.id)).toMatchObject({ range: [w.b], revision: before.state.revision + 1 });
    expect((await w.rows(view.id))[0]).toMatchObject({ id: live, parent_org_id: w.b });
    expect(await w.businessVersion(view.id)).toBe(`revision:${before.state.revision + 1}`);
  });
});

/** n1 改为“编辑并同意”（with_approve），开放上级与改名（第 3 轮回归用）。 */
const withApproveNodes = () =>
  oaNodes([{ editMode: 'with_approve', editableFields: ['subject', 'orgItems.name', 'orgItems.parentOrgId'] }]);

/** 当前待办（审批人 + 节点）：用来断言实例推进与否。 */
async function pendingOf(w: FlowWorld, id: string) {
  const view = await w.instance(id);
  return view.tasks
    .filter((task) => task.status === 'pending')
    .map((task) => ({ nodeKey: task.nodeKey, assigneeUserId: task.assigneeUserId }));
}

/** 编辑并同意成功：200、revision 只 + 1、实例业务版本同步、n1 结束且推进到 n2 负责人。 */
async function expectApprovedWithEdit(w: FlowWorld, id: string, revision: number, res: Response) {
  expect(res.status, await res.clone().text()).toBe(200);
  expect((await w.state(id)).revision).toBe(revision + 1);
  expect(await w.businessVersion(id)).toBe(`revision:${revision + 1}`);
  expect(await pendingOf(w, id)).toEqual([{ nodeKey: 'n2', assigneeUserId: w.head.userId }]);
}

describe('AC-OA-38 AC-OA-43 第 3 轮：编辑并同意按编辑后的完整候选态跑整单关口（§4.4）', () => {
  it('提交后新增行的上级被停用，同意时随 fields 改到启用组织 → 200，revision + 1，实例推进', async () => {
    const w = await flowWorld(testDb().db, 'oa-r3-inactive', { nodes: withApproveNodes() });
    const parent = await w.org(`上级${randomUUID()}`, w.a);
    const view = await w.created();
    const live = (await w.item(view.id, newOrg(parent))).items[0]!.id;
    await w.submitted(view.id);
    await w.disable(parent);
    const revision = (await w.state(view.id)).revision;
    const res = await w.act(view.id, w.hrbp, 'approve', {
      fields: { 'orgItems.parentOrgId': [{ itemId: live, value: w.a }] },
    });
    await expectApprovedWithEdit(w, view.id, revision, res);
    expect((await w.rows(view.id))[0]).toMatchObject({ id: live, parent_org_id: w.a });
  });

  it('行上级被改指暂存行，同意时随 fields 改回已有组织 → 200，revision + 1，实例推进', async () => {
    const w = await flowWorld(testDb().db, 'oa-r3-staged', { nodes: withApproveNodes() });
    const { id, staged, live } = await stagedPair(w);
    // 可信夹具：直接改库，模拟提交后才出现的整单问题
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`UPDATE org_adjustment_org_items SET parent_org_id = NULL, parent_item_id = ${staged}
        WHERE id = ${live}`),
    );
    const revision = (await w.state(id)).revision;
    const res = await w.act(id, w.hrbp, 'approve', {
      fields: { 'orgItems.parentOrgId': [{ itemId: live, value: w.a }] },
    });
    await expectApprovedWithEdit(w, id, revision, res);
    expect((await w.rows(id)).find((row) => row.id === live)).toMatchObject({ parent_org_id: w.a });
  });

  it('带 fields 但编辑后候选态仍非法 → 400，头 / 明细 / revision / 实例版本 / 待办都不变', async () => {
    const w = await flowWorld(testDb().db, 'oa-r3-invalid', { nodes: withApproveNodes() });
    const parent = await w.org(`上级${randomUUID()}`, w.a);
    const view = await w.created();
    const live = (await w.item(view.id, newOrg(parent))).items[0]!.id;
    await w.submitted(view.id);
    await w.disable(parent);
    const before = { ...(await snapshotOf(w, view.id)), pending: await pendingOf(w, view.id) };
    const res = await w.act(view.id, w.hrbp, 'approve', {
      fields: { subject: '只改主题', 'orgItems.name': [{ itemId: live, value: '只改名' }] },
    });
    await expectError(res, 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_ORG_INACTIVE');
    expect({ ...(await snapshotOf(w, view.id)), pending: await pendingOf(w, view.id) }).toEqual(before);
  });

  it('普通同意（不带 fields）遇整单问题仍 400 兜底，待办不变', async () => {
    const w = await flowWorld(testDb().db, 'oa-r3-plain', { nodes: withApproveNodes() });
    const parent = await w.org(`上级${randomUUID()}`, w.a);
    const view = await w.created();
    await w.item(view.id, newOrg(parent));
    await w.submitted(view.id);
    await w.disable(parent);
    const before = { ...(await snapshotOf(w, view.id)), pending: await pendingOf(w, view.id) };
    await expectError(await w.act(view.id, w.hrbp, 'approve'), 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_ORG_INACTIVE');
    expect({ ...(await snapshotOf(w, view.id)), pending: await pendingOf(w, view.id) }).toEqual(before);
  });
});
