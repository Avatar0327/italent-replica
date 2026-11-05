/**
 * F-428（R2-T08 §6.3）：提交（路由 10）与审批中心重提须复核组织明细字段的写权限——
 * 保存明细时有权的字段，提交 / 重提时被收回，则按既有字段写权错误码 403 拒绝，单据与实例都不动；
 * 权限在时同一单据照常提交 / 重提（正向对照）。字段集 = 本单明细行用户实际写过的 `orgItems.*`，
 * 含写过又清为 null 的字段（取审计 before / after 有变的键，不看终态是否为空）；从未填写的字段不判。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld } from './AC-OA-approval-support.js';
import { expectError } from './AC-OA-head-support.js';
import { rename } from './AC-OA-items-support.js';
import { uniqueSuffix } from './support/unique.js';

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

describe('F-428 写过又清空的字段仍要复核写权（P2-2）', () => {
  it('提交：shortName 有权时填入再清为 null，随后写权被收回 → 提交 403 且全不动；恢复后提交成功', async () => {
    const w = await flowWorld(testDb().db, 'f428-clear-submit');
    const { id, itemId } = await w.draft(rename(w.a, { shortName: '简称原值' }));
    const cleared = await w.patchItem(id, itemId, { shortName: null });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    const before = await w.state(id);

    w.access.deniedFields.add('orgItems.shortName');
    await expectError(await w.submit(id), 403, 'FORBIDDEN');
    expect(await w.state(id)).toEqual(before);
    expect(await w.instances(id)).toEqual([]);

    w.access.deniedFields.clear();
    expect((await w.submitted(id)).approvalStatus).toBe(1);
  });

  it('重提：驳回后把 shortName 清为 null，写权被收回 → 重提 403 且全不动；恢复后重提成功', async () => {
    const w = await flowWorld(testDb().db, 'f428-clear-resubmit');
    const { id, itemId } = await w.draft(rename(w.a, { shortName: '简称原值' }));
    await w.submitted(id);
    await w.acted(id, w.hrbp, 'reject');
    const cleared = await w.patchItem(id, itemId, { shortName: null });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    const before = await w.state(id);
    const version = await w.businessVersion(id);

    w.access.deniedFields.add('orgItems.shortName');
    await expectError(await w.instanceAction(id, 'resubmit'), 403, 'FORBIDDEN');
    expect(await w.state(id)).toEqual(before);
    expect(await w.businessVersion(id)).toBe(version);
    expect((await w.instance(id)).status).not.toBe('running');

    w.access.deniedFields.clear();
    const ok = await w.instanceAction(id, 'resubmit');
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await w.state(id)).approval).toBe(1);
  });

  it('引用型字段同口径：上级写过又清为 null → 按 orgItems.parentOrgId 复核，撤权后提交 403', async () => {
    const w = await flowWorld(testDb().db, 'f428-clear-parent');
    const child = await w.org(`丙${uniqueSuffix()}`, w.a);
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    const added = await w.item(view.id, rename(child, { parent: { orgId: w.b } }));
    const [id, itemId] = [view.id, added.items[0]!.id];
    const cleared = await w.patchItem(id, itemId, { parent: null });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    const before = await w.state(id);

    w.access.deniedFields.add('orgItems.parentOrgId');
    await expectError(await w.submit(id), 403, 'FORBIDDEN');
    expect(await w.state(id)).toEqual(before);
    expect(await w.instances(id)).toEqual([]);
  });

  it('从未填写的字段不误拒：shortName 一直为空，撤权后提交照常通过', async () => {
    const w = await flowWorld(testDb().db, 'f428-never-written');
    const { id, itemId } = await w.draft(rename(w.a));
    const same = await w.patchItem(id, itemId, { name: `改名${id}` });
    expect(same.status, await same.clone().text()).toBe(200);
    w.access.deniedFields.add('orgItems.shortName');
    expect((await w.submitted(id)).approvalStatus).toBe(1);
  });
});
