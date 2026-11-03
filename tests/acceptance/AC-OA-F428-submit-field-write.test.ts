/**
 * F-428（R2-T08 §6.3）：提交（路由 10）与审批中心重提须复核组织明细字段的写权限——
 * 保存明细时有权的字段，提交 / 重提时被收回，则按既有字段写权错误码 403 拒绝，单据与实例都不动；
 * 权限在时同一单据照常提交 / 重提（正向对照）。字段集取库里明细行实际有值的 `orgItems.*`。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld } from './AC-OA-approval-support.js';
import { expectError } from './AC-OA-head-support.js';
import { rename } from './AC-OA-items-support.js';

const testDb = useTestDb();

describe('F-428 提交复核组织明细字段写权', () => {
  it('保存后 orgItems.name 的写权被收回 → 提交 403，单据 / 实例不动；恢复后同一单据提交成功', async () => {
    const w = await flowWorld(testDb().db, 'f428-submit');
    const { id } = await w.draft();
    const before = await w.state(id);

    w.access.deniedFields.add('orgItems.name');
    const denied = await w.submit(id);
    await expectError(denied, 403, 'FORBIDDEN');
    expect(await w.state(id)).toEqual(before);
    expect(await w.instances(id)).toEqual([]);

    w.access.deniedFields.clear();
    expect((await w.submitted(id)).approvalStatus).toBe(1);
  });

  it('只判明细里实际有值的字段：被收回的字段该单没填 → 提交照常通过', async () => {
    const w = await flowWorld(testDb().db, 'f428-unused');
    const { id } = await w.draft(rename(w.a));
    w.access.deniedFields.add('orgItems.shortName');
    expect((await w.submitted(id)).approvalStatus).toBe(1);
  });
});

describe('F-428 审批中心重提复核组织明细字段写权', () => {
  it('驳回后 orgItems.name 的写权被收回 → 重提 403，单据仍 6；恢复后重提回到同一实例', async () => {
    const w = await flowWorld(testDb().db, 'f428-resubmit');
    const { id } = await w.draft();
    await w.submitted(id);
    await w.acted(id, w.hrbp, 'reject');
    const before = await w.state(id);
    expect(before.approval).toBe(6);

    w.access.deniedFields.add('orgItems.name');
    await expectError(await w.instanceAction(id, 'resubmit'), 403, 'FORBIDDEN');
    expect(await w.state(id)).toEqual(before);

    w.access.deniedFields.clear();
    const ok = await w.instanceAction(id, 'resubmit');
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await w.state(id)).approval).toBe(1);
    expect(await w.instances(id)).toHaveLength(1);
  });
});
