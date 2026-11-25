/**
 * BE-11c-b 第 2 轮 P1-1 ～ P1-3（R2-T08 §6.3 / §8.3）：调动行的跨对象写授权在五个入口（保存、审批中编辑、提交、重提、重放）
 * 都按“事务内、锁后、当前行、旧值与新值两侧”判；业务红测，调动行用可信夹具（seed）放进库里，再经公开入口断言业务结果。
 *  - P1-1 提交 / 重提复核 `transferItems.*` 字段写权与合同“变更”按钮；重放按当前权限再判；
 *  - P1-2 目标部门按组织对象范围判；删除带合同联动的行要“变更”按钮；职责转交旧值一侧同样要字段权；
 *  - P1-3 带编（withEstablishment）按编制对象范围判，保存 / 勾选 / 取消 / 删除 / 提交 / 重放都不能越过。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { transferWorld } from './AC-OA-11cb-support.js';
import { expectError, only } from './AC-OA-head-support.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const NONE = { ...EMPTY_SCOPE, hasDataPermission: true };

async function setup(label: string) {
  const w = await transferWorld(testDb().db, label);
  const mover = await w.staff(w.a);
  const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
  return { w, mover, view };
}

describe('P1-1 提交与重提复核调动行字段写权', () => {
  it('保存后 transferItems.departmentId 写权被收回 → 提交 403，单据仍为草稿；恢复后提交成功', async () => {
    const { w, mover, view } = await setup('r2-submit-field');
    await w.transfer(view.id, w.transferBody(mover, { orgId: w.b }));
    const before = await w.state(view.id);

    w.access.deniedFields.add('transferItems.departmentId');
    await expectError(await w.submit(view.id), 403, 'FORBIDDEN');
    expect(await w.state(view.id)).toEqual(before);

    w.access.deniedFields.clear();
    expect((await w.submitted(view.id)).approvalStatus).toBe(1);
  });

  it('驳回后合同“变更”按钮被收回 → 审批中心重提 403，单据仍为 6；恢复后重提成功', async () => {
    const { w, mover, view } = await setup('r2-resubmit-contract');
    const contractId = await w.contractOf(mover);
    await w.seed(view.id, mover, {
      linkageInput: { contract: { targetId: contractId, fields: { endDate: '2029-10-09' } } },
    });
    await w.submitted(view.id);
    await w.acted(view.id, w.hrbp, 'reject');
    const before = await w.state(view.id);
    expect(before.approval).toBe(6);

    w.access.deniedButtons.add('change');
    await expectError(await w.instanceAction(view.id, 'resubmit'), 403, 'FORBIDDEN');
    expect(await w.state(view.id)).toEqual(before);

    w.access.deniedButtons.clear();
    const ok = await w.instanceAction(view.id, 'resubmit');
    expect(ok.status, await ok.clone().text()).toBe(200);
  });

  it('驳回后 transferItems.departmentId 写权被收回 → 审批中心重提 403', async () => {
    const { w, mover, view } = await setup('r2-resubmit-field');
    await w.transfer(view.id, w.transferBody(mover, { orgId: w.b }));
    await w.submitted(view.id);
    await w.acted(view.id, w.hrbp, 'reject');

    w.access.deniedFields.add('transferItems.departmentId');

    await expectError(await w.instanceAction(view.id, 'resubmit'), 403, 'FORBIDDEN');
    expect((await w.state(view.id)).approval).toBe(6);
  });

  it('同键重放：保存后目标部门移出组织对象范围 → 重放 404，不再回放旧结果', async () => {
    const { w, mover, view } = await setup('r2-replay-scope');
    const key = randomUUID();
    const body = w.transferBody(mover, { orgId: w.b });
    const first = await w.call('POST', `/api/tenant/org-adjustment/adjustments/${view.id}/transfer-items`, {
      ifMatch: (await w.stored(view.id))!.revision,
      body,
      idempotencyKey: key,
    });
    expect(first.status, await first.clone().text()).toBe(201);

    w.access.org = only(w.a);
    const replay = await w.call('POST', `/api/tenant/org-adjustment/adjustments/${view.id}/transfer-items`, {
      ifMatch: (await w.stored(view.id))!.revision - 1,
      body,
      idempotencyKey: key,
    });

    await expectError(replay, 404, 'NOT_FOUND');
  });
});

describe('P1-2 旧值一侧与目标部门的授权', () => {
  it('目标部门不在组织对象范围 → 新增 404，不留明细', async () => {
    const { w, mover, view } = await setup('r2-target-scope');
    w.access.org = only(w.a);

    await expectError(await w.addTransfer(view.id, w.transferBody(mover, { orgId: w.b })), 404, 'NOT_FOUND');

    expect(await w.transferRows(view.id)).toEqual([]);
  });

  it('删除带合同联动的行：没有合同“变更”按钮 → 403，行与联动原样保留', async () => {
    const { w, mover, view } = await setup('r2-delete-contract');
    const contractId = await w.contractOf(mover);
    const itemId = await w.seed(view.id, mover, {
      linkageInput: { contract: { targetId: contractId, fields: { endDate: '2029-10-09' } } },
    });
    w.access.deniedButtons.add('change');

    await expectError(await w.deleteTransfer(view.id, itemId), 403, 'FORBIDDEN');

    expect(await w.transferRows(view.id)).toHaveLength(1);
  });

  it('删除带职责转交的行：旧值里的下属经理字段没有编辑权 → 403，行原样保留', async () => {
    const { w, mover, view } = await setup('r2-delete-duty');
    const subordinate = await w.employee(`ZZ_下属${uniqueSuffix()}`);
    await w.hire(subordinate.id, { departmentId: w.a, directManagerId: mover });
    const receiver = await w.staff(w.b);
    const itemId = await w.seed(view.id, mover, {
      linkageInput: {
        dutyTransfer: {
          subordinates: [{ employeeId: subordinate.id, receiverId: receiver, relation: 'direct' }],
          orgRoles: [],
        },
      },
    });
    w.access.deniedFields.add('directManagerId');

    await expectError(await w.deleteTransfer(view.id, itemId), 403, 'FORBIDDEN');

    expect(await w.transferRows(view.id)).toHaveLength(1);
  });

  it('同键重放删除：合同“变更”按钮在首次删除后被收回 → 重放 403', async () => {
    const { w, mover, view } = await setup('r2-replay-delete');
    const contractId = await w.contractOf(mover);
    const itemId = await w.seed(view.id, mover, {
      linkageInput: { contract: { targetId: contractId, fields: { endDate: '2029-10-09' } } },
    });
    const key = randomUUID();
    const path = `/api/tenant/org-adjustment/adjustments/${view.id}/transfer-items/${itemId}`;
    const first = await w.call('DELETE', path, { ifMatch: (await w.stored(view.id))!.revision, idempotencyKey: key });
    expect(first.status, await first.clone().text()).toBe(200);

    w.access.deniedButtons.add('change');
    const replay = await w.call('DELETE', path, {
      ifMatch: (await w.stored(view.id))!.revision - 1,
      idempotencyKey: key,
    });

    await expectError(replay, 403, 'FORBIDDEN');
  });
});

describe('P1-3 带编按编制对象权限判', () => {
  it('没有编制对象范围：勾选带编新增 → 404，不留明细', async () => {
    const { w, mover, view } = await setup('r2-est-add');
    w.access.establishment = NONE;

    const res = await w.addTransfer(view.id, w.transferBody(mover, { orgId: w.b }, { withEstablishment: true }));

    await expectError(res, 404, 'NOT_FOUND');
    expect(await w.transferRows(view.id)).toEqual([]);
  });

  it('没有编制对象范围：已存带编的行不能提交，单据仍为草稿', async () => {
    const { w, mover, view } = await setup('r2-est-submit');
    await w.seed(view.id, mover, { withEstablishment: true });
    w.access.establishment = NONE;

    const res = await w.submit(view.id);

    await expectError(res, 404, 'NOT_FOUND');
    expect((await w.state(view.id)).approval).toBe(0);
  });

  it('没有编制对象范围：取消勾选与删除带编的行同样被拒（旧值一侧也要判）', async () => {
    const { w, mover, view } = await setup('r2-est-uncheck');
    const itemId = await w.seed(view.id, mover, { withEstablishment: true });
    w.access.establishment = NONE;

    await expectError(await w.patchTransfer(view.id, itemId, { withEstablishment: false }), 404, 'NOT_FOUND');
    await expectError(await w.deleteTransfer(view.id, itemId), 404, 'NOT_FOUND');

    expect(await w.transferRows(view.id)).toHaveLength(1);
  });
});

describe('调动明细写路由：头“编辑”按钮是功能权，缺则 403', () => {
  it('没有 EditAdjustOrgDetailBtn：新增 / 修改 / 删除 / 单行刷新都 403，行与 revision 原样', async () => {
    const { w, mover, view } = await setup('r2-head-button');
    const itemId = await w.seed(view.id, mover);
    const before = await w.state(view.id);
    w.access.deniedButtons.add('EditAdjustOrgDetailBtn');

    const other = await w.staff(w.b);
    await expectError(await w.addTransfer(view.id, w.transferBody(other, { orgId: w.a })), 403, 'FORBIDDEN');
    await expectError(await w.patchTransfer(view.id, itemId, { department: { orgId: w.a } }), 403, 'FORBIDDEN');
    await expectError(await w.deleteTransfer(view.id, itemId), 403, 'FORBIDDEN');
    await expectError(await w.rebaseItem(view.id, itemId, undefined, 'transfer'), 403, 'FORBIDDEN');

    expect(await w.transferRows(view.id)).toHaveLength(1);
    expect(await w.state(view.id)).toEqual(before);
  });
});
