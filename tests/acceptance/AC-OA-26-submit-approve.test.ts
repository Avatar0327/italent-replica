/**
 * BE-10c AC-OA-26 提交 / 同意侧基线（R2-T08 §2.5）与提交关口（§5）：目标组织在加明细后被直接改过 → 提交 / 同意 409
 * `ORG_ADJUSTMENT_BASELINE_CHANGED` 并列出行；刷新基线后可提交。整单校验不通过 → 400，问题列表同 check。
 * 执行侧（该组 BASELINE_CHANGED、不覆盖）归 11b。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld } from './AC-OA-approval-support.js';
import { bodyOf, expectError } from './AC-OA-head-support.js';
import { stop } from './AC-OA-items-support.js';

const testDb = useTestDb();
const linkage = { transferOldHeadSubordinates: false, adjustNewHeadManager: false };

describe('AC-OA-26 基线冲突：提交侧', () => {
  it('目标组织被改 → 提交 409 列出行，单据仍 0、无实例；刷新基线后提交成功', async () => {
    const w = await flowWorld(testDb().db, 'oa26-submit');
    const { id, itemId } = await w.draft();
    await w.touchOrg(w.a);
    const before = await w.state(id);
    const res = await w.submit(id);
    await expectError(res, 409, 'CONFLICT', 'ORG_ADJUSTMENT_BASELINE_CHANGED');
    expect((await bodyOf(res)).error?.details?.items).toEqual([{ section: 'org', itemId }]);
    expect(await w.state(id)).toEqual(before);
    expect(await w.instances(id)).toEqual([]);
    const rebased = await w.rebaseAll(id);
    expect(rebased.status, await rebased.clone().text()).toBe(200);
    expect((await w.submitted(id)).approvalStatus).toBe(1);
  });

  it('驳回后目标组织被改 → 重提同样 409；刷新后重提回到同一实例', async () => {
    const w = await flowWorld(testDb().db, 'oa26-resubmit');
    const { id } = await w.draft();
    await w.submitted(id);
    await w.acted(id, w.hrbp, 'reject');
    await w.touchOrg(w.a);
    await expectError(await w.submit(id), 409, 'CONFLICT', 'ORG_ADJUSTMENT_BASELINE_CHANGED');
    expect((await w.state(id)).approval).toBe(6);
    await w.rebaseAll(id);
    await w.submitted(id);
    expect(await w.instances(id)).toHaveLength(1);
  });
});

describe('AC-OA-26 基线冲突：同意侧（beforeApprove）', () => {
  it('提交后目标组织被改 → 同意 409，任务不动；驳回不受基线拦截', async () => {
    const w = await flowWorld(testDb().db, 'oa26-approve');
    const { id, itemId } = await w.draft();
    await w.submitted(id);
    await w.touchOrg(w.a);
    const before = await w.state(id);
    const res = await w.act(id, w.hrbp, 'approve');
    await expectError(res, 409, 'CONFLICT', 'ORG_ADJUSTMENT_BASELINE_CHANGED');
    expect((await bodyOf(res)).error?.details?.items).toEqual([{ section: 'org', itemId }]);
    expect(await w.state(id)).toEqual(before);
    const pending = (await w.instance(id)).tasks.filter((t) => t.status === 'pending');
    expect(pending).toEqual([expect.objectContaining({ assigneeUserId: w.hrbp.userId })]);
    await w.acted(id, w.hrbp, 'reject');
    expect((await w.state(id)).approval).toBe(6);
  });

  it('不同意不受基线拦截 → 3', async () => {
    const w = await flowWorld(testDb().db, 'oa26-disagree');
    const { id } = await w.draft();
    await w.submitted(id);
    await w.touchOrg(w.a);
    await w.acted(id, w.hrbp, 'disagree');
    expect((await w.state(id)).approval).toBe(3);
  });
});

describe('AC-OA-26 提交关口复用整单校验（§5）', () => {
  it('停用整支有编制 → 提交 400 ESTABLISHMENT_END_NOT_AVAILABLE，单据不变', async () => {
    const w = await flowWorld(testDb().db, 'oa26-est');
    const child = await w.org(`下级${randomUUID()}`, w.a);
    const view = await w.created();
    await w.item(view.id, stop(w.a));
    await w.capacity(child);
    const before = await w.state(view.id);
    const res = await w.submit(view.id);
    await expectError(res, 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_ESTABLISHMENT_END_NOT_AVAILABLE');
    const items = (await bodyOf(res)).error?.details?.items as { reason: string }[];
    expect(items.map((i) => i.reason)).toContain('ORG_ADJUSTMENT_ESTABLISHMENT_END_NOT_AVAILABLE');
    expect(await w.state(view.id)).toEqual(before);
    expect(await w.instances(view.id)).toEqual([]);
  });

  it('新负责人不在本组织 → 提交 400 HEAD_NOT_IN_ORG 原文', async () => {
    const w = await flowWorld(testDb().db, 'oa26-head');
    const outside = await w.person('外部负责人', w.b);
    const view = await w.created();
    await w.item(view.id, {
      entry: 'detail.change',
      adjustType: 2,
      targetOrgId: w.a,
      personInChargeId: outside.employeeId,
      ...linkage,
    });
    const res = await w.submit(view.id);
    await expectError(res, 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_HEAD_NOT_IN_ORG');
    expect((await bodyOf(res)).error?.details?.items).toContainEqual(
      expect.objectContaining({
        reason: 'ORG_ADJUSTMENT_HEAD_NOT_IN_ORG',
        message: '请在本单为新负责人添加调动或兼职明细',
      }),
    );
    expect((await w.state(view.id)).approval).toBe(0);
  });

  it('提交缺 EditAdjustOrgDetailBtn → 403；主体组织出了申请人范围 → 与不存在同口径', async () => {
    const w = await flowWorld(testDb().db, 'oa26-gate');
    const { id } = await w.draft();
    w.access.deniedButtons.add('EditAdjustOrgDetailBtn');
    expect((await w.submit(id)).status).toBe(403);
    w.access.deniedButtons.clear();
    w.access.main = { ...w.access.main, all: false, orgIds: [w.b] };
    const outside = await w.submit(id);
    const missing = await w.submit(randomUUID(), 1);
    expect(outside.status).toBe(missing.status);
    expect((await bodyOf(outside)).error?.message).toBe((await bodyOf(missing)).error?.message);
    expect((await w.state(id)).approval).toBe(0);
  });
});
