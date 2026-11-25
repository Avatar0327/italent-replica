/**
 * BE-11c-b 第 3 轮 P1-1 ～ P1-3 与 P2-1（R2-T08 §6.3 / §8.3）：调动行的跨对象写授权不能只在“有差异”时才复核，
 * 也不能只核范围不核对象写权；同键重放必须按当前授权重判原始新旧两侧。业务红测：夹具走公开写入口或可信夹具，
 * 断言的是业务结果（状态码、业务码、单据状态、行内容），不是函数是否存在。
 *  - P1-1 显式清空虚线经理（dottedManagerId: null）同样是对 transferItems.directManagerId 的写，提交 / 重提 / 刷新都要复核；
 *  - P1-2a 保留合同联动只改目标部门：新旧合同目标范围与“变更”按钮各自独立复核；
 *  - P1-2b 职责转交下属须在申请人的任职范围内（新旧两侧），范围外 404 LINKED_RECORD_OUT_OF_SCOPE；
 *  - P1-3 带编按编制对象 update + 实际写入字段（localCapacity 等）复核，勾选 / 取消 / 删除 / 提交 / 重放都不能越过；
 *  - P2-1 PATCH 清空合同联动后撤“变更”按钮重放、审批人编辑后撤 EditApprovalIngApply 重放都按当前授权重判。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { oaNodes } from './AC-OA-approval-support.js';
import { transferWorld } from './AC-OA-11cb-support.js';
import { expectError, onlyPeople } from './AC-OA-head-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const ITEMS = (id: string) => `/api/tenant/org-adjustment/adjustments/${id}/transfer-items`;

async function setup(label: string, options: Parameters<typeof transferWorld>[2] = {}) {
  const w = await transferWorld(testDb().db, label, options);
  const c = await w.org(`范围丙${uniqueSuffix()}`);
  const mover = await w.staff(w.a);
  const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b, c] }));
  return { w, c, mover, view };
}

describe('P1-1 显式清空虚线经理要复核 transferItems.directManagerId 写权', () => {
  const clearing = (w: Awaited<ReturnType<typeof setup>>['w'], mover: string) =>
    w.transferBody(mover, { orgId: w.b }, { dottedManagerId: null });

  it('保存清空后撤该字段写权：提交 403，单据仍为草稿；恢复后提交成功', async () => {
    const { w, mover, view } = await setup('r3-clear-submit');
    await w.transfer(view.id, clearing(w, mover));
    const before = await w.state(view.id);

    w.access.deniedFields.add('transferItems.directManagerId');
    await expectError(await w.submit(view.id), 403, 'FORBIDDEN');
    expect(await w.state(view.id)).toEqual(before);

    w.access.deniedFields.clear();
    expect((await w.submitted(view.id)).approvalStatus).toBe(1);
  });

  it('驳回后撤该字段写权：审批中心重提 403，单据仍为 6', async () => {
    const { w, mover, view } = await setup('r3-clear-resubmit');
    await w.transfer(view.id, clearing(w, mover));
    await w.submitted(view.id);
    await w.acted(view.id, w.hrbp, 'reject');

    w.access.deniedFields.add('transferItems.directManagerId');

    await expectError(await w.instanceAction(view.id, 'resubmit'), 403, 'FORBIDDEN');
    expect((await w.state(view.id)).approval).toBe(6);
  });

  it('单行刷新基线：撤该字段写权 → 403，行与 revision 不变', async () => {
    const { w, mover, view } = await setup('r3-clear-rebase');
    const added = await w.transfer(view.id, clearing(w, mover));
    const before = { state: await w.state(view.id), rows: await w.transferRows(view.id) };

    w.access.deniedFields.add('transferItems.directManagerId');
    const res = await w.rebaseItem(view.id, added.items[0]!.id, undefined, 'transfer');

    await expectError(res, 403, 'FORBIDDEN');
    expect({ state: await w.state(view.id), rows: await w.transferRows(view.id) }).toEqual(before);
  });
});

describe('P1-2a 保留合同联动只改目标部门：新旧合同目标范围与按钮独立复核', () => {
  async function withContract(label: string) {
    const ctx = await setup(label);
    const contractId = await ctx.w.contractOf(ctx.mover);
    const itemId = await ctx.w.seed(ctx.view.id, ctx.mover, {
      linkageInput: { contract: { targetId: contractId, fields: { endDate: '2029-10-09' } } },
    });
    return { ...ctx, itemId };
  }

  it('没有合同“变更”按钮：PATCH 只改目标部门 → 403，行原样', async () => {
    const { w, c, view, itemId } = await withContract('r3-keep-contract-button');
    const before = await w.transferRows(view.id);
    w.access.deniedButtons.add('change');

    const res = await w.patchTransfer(view.id, itemId, { department: { orgId: c } });

    await expectError(res, 403, 'FORBIDDEN');
    expect(await w.transferRows(view.id)).toEqual(before);
  });

  it('合同目标已不在合同对象范围：PATCH 只改目标部门 → 404，行原样', async () => {
    const { w, c, view, itemId } = await withContract('r3-keep-contract-scope');
    const before = await w.transferRows(view.id);
    w.access.contract = onlyPeople(w.a, await w.staff(w.a)); // 范围里没有该合同所属员工

    const res = await w.patchTransfer(view.id, itemId, { department: { orgId: c } });

    await expectError(res, 404, 'NOT_FOUND');
    expect(await w.transferRows(view.id)).toEqual(before);
  });

  it('提交：合同“变更”按钮被收回 → 403（保留合同的行也复核按钮），单据仍为草稿', async () => {
    const { w, view } = await withContract('r3-keep-contract-submit');
    const before = await w.state(view.id);
    w.access.deniedButtons.add('change');

    await expectError(await w.submit(view.id), 403, 'FORBIDDEN');

    expect(await w.state(view.id)).toEqual(before);
  });
});

describe('P1-2b 职责转交下属要在申请人任职范围内（新旧两侧）', () => {
  async function dutyWorld(label: string) {
    const ctx = await setup(label);
    const { w, mover } = ctx;
    const subordinate = await w.employee(`ZZ_下属${uniqueSuffix()}`);
    await w.hire(subordinate.id, { departmentId: w.a, directManagerId: mover });
    const receiver = await w.staff(w.b);
    const linkage = {
      dutyTransfer: {
        subordinates: [{ employeeId: subordinate.id, receiverId: receiver, relation: 'direct' }],
        orgRoles: [],
      },
    };
    // 申请人的任职范围只含调动人与接收人，不含下属
    w.access.employment = onlyPeople(w.a, mover, receiver);
    return { ...ctx, linkage };
  }

  it('新增带范围外下属的职责转交 → 404 LINKED_RECORD_OUT_OF_SCOPE，不留明细', async () => {
    const { w, mover, view, linkage } = await dutyWorld('r3-duty-add');

    const res = await w.addTransfer(view.id, w.transferBody(mover, { orgId: w.b }, { linkage }));

    await expectError(res, 404, 'LINKED_RECORD_OUT_OF_SCOPE');
    expect(await w.transferRows(view.id)).toEqual([]);
  });

  it('已存的范围外下属职责转交（旧值一侧）：提交 404，单据仍为草稿；删除该行同样 404，行保留', async () => {
    const { w, mover, view, linkage } = await dutyWorld('r3-duty-old');
    const itemId = await w.seed(view.id, mover, { linkageInput: linkage });
    const before = await w.state(view.id);

    await expectError(await w.submit(view.id), 404, 'LINKED_RECORD_OUT_OF_SCOPE');
    expect(await w.state(view.id)).toEqual(before);

    await expectError(await w.deleteTransfer(view.id, itemId), 404, 'LINKED_RECORD_OUT_OF_SCOPE');
    expect(await w.transferRows(view.id)).toHaveLength(1);
  });
});

describe('P1-3 带编复核编制对象写权（字段权），不只是范围', () => {
  async function establishmentWorld(label: string) {
    const ctx = await setup(label);
    const { w } = ctx;
    const post = async (path: string, body: object) => {
      const res = await w.call('POST', `/api/tenant/${path}`, { ifMatch: 0, body });
      expect(res.status, await res.clone().text()).toBe(201);
      return (await res.json()) as { id: string };
    };
    const scheme = await post('establishment/schemes', {
      name: `ZZ_编制方案${uniqueSuffix()}`,
      periodType: 'annual',
      maintenanceMode: 'both',
      startDate: '2026-01-01',
    });
    for (const orgId of [w.a, w.b])
      await post('establishment/capacities', {
        orgId,
        schemeId: scheme.id,
        periodStart: '2026-01-01',
        effectiveDate: '2026-01-01',
        localCapacity: 5,
        inclusiveCapacity: 10,
        strictControl: false,
      });
    return ctx;
  }

  it('保留编制范围、撤 localCapacity 写权：勾选带编新增 → 403，不留明细', async () => {
    const { w, mover, view } = await establishmentWorld('r3-est-add');
    w.access.deniedFields.add('localCapacity');

    const res = await w.addTransfer(view.id, w.transferBody(mover, { orgId: w.b }, { withEstablishment: true }));

    await expectError(res, 403, 'FORBIDDEN');
    expect(await w.transferRows(view.id)).toEqual([]);
  });

  it('已存带编的行：撤 localCapacity 写权后提交 403，单据仍为草稿', async () => {
    const { w, mover, view } = await establishmentWorld('r3-est-submit');
    await w.seed(view.id, mover, { withEstablishment: true });
    const before = await w.state(view.id);
    w.access.deniedFields.add('localCapacity');

    await expectError(await w.submit(view.id), 403, 'FORBIDDEN');

    expect(await w.state(view.id)).toEqual(before);
  });

  it('取消勾选与删除带编的行同样要编制写权（旧值一侧），行原样保留', async () => {
    const { w, mover, view } = await establishmentWorld('r3-est-uncheck');
    const itemId = await w.seed(view.id, mover, { withEstablishment: true });
    w.access.deniedFields.add('localCapacity');

    await expectError(await w.patchTransfer(view.id, itemId, { withEstablishment: false }), 403, 'FORBIDDEN');
    await expectError(await w.deleteTransfer(view.id, itemId), 403, 'FORBIDDEN');

    expect(await w.transferRows(view.id)).toHaveLength(1);
  });

  it('同键重放新增：首次后撤 localCapacity 写权 → 重放 403，不再回放旧结果', async () => {
    const { w, mover, view } = await establishmentWorld('r3-est-replay');
    const key = randomUUID();
    const body = w.transferBody(mover, { orgId: w.b }, { withEstablishment: true });
    const ifMatch = (await w.stored(view.id))!.revision;
    const first = await w.call('POST', ITEMS(view.id), { ifMatch, body, idempotencyKey: key });
    expect(first.status, await first.clone().text()).toBe(201);

    w.access.deniedFields.add('localCapacity');
    const replay = await w.call('POST', ITEMS(view.id), { ifMatch, body, idempotencyKey: key });

    await expectError(replay, 403, 'FORBIDDEN');
  });
});

describe('P2-1 同键重放按当前授权重判原始新旧两侧', () => {
  it('PATCH 清空合同联动成功后撤“变更”按钮：原键重放 403', async () => {
    const { w, mover, view } = await setup('r3-replay-clear-contract');
    const contractId = await w.contractOf(mover);
    const itemId = await w.seed(view.id, mover, {
      linkageInput: { contract: { targetId: contractId, fields: { endDate: '2029-10-09' } } },
    });
    const key = randomUUID();
    const path = `${ITEMS(view.id)}/${itemId}`;
    const ifMatch = (await w.stored(view.id))!.revision;
    const first = await w.call('PATCH', path, { ifMatch, body: { linkage: null }, idempotencyKey: key });
    expect(first.status, await first.clone().text()).toBe(200);

    w.access.deniedButtons.add('change');
    const replay = await w.call('PATCH', path, { ifMatch, body: { linkage: null }, idempotencyKey: key });

    await expectError(replay, 403, 'FORBIDDEN');
  });

  it('审批人编辑调动行成功后撤 EditApprovalIngApply：原键重放 403', async () => {
    const w = await transferWorld(testDb().db, 'r3-replay-approval-edit', {
      nodes: oaNodes([{ editableFields: ['subject', 'transferItems.departmentId'] }]),
    });
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    const itemId = await w.seed(view.id, await w.staff(w.a));
    await w.submitted(view.id);
    const instance = await w.instance(view.id);
    const task = instance.tasks.find((t) => t.status === 'pending' && t.assigneeUserId === w.hrbp.userId)!;
    const request = {
      ifMatch: instance.revision,
      body: { fields: { 'transferItems.departmentId': [{ itemId, value: w.a }] } },
      idempotencyKey: randomUUID(),
    };
    const path = `/api/tenant/approval/tasks/${task.id}/edit`;
    const first = await w.call('POST', path, request, w.hrbp.userId);
    expect(first.status, await first.clone().text()).toBe(200);

    w.access.deniedButtons.add('EditApprovalIngApply');
    const replay = await w.call('POST', path, request, w.hrbp.userId);

    await expectError(replay, 403, 'FORBIDDEN');
  });
});
