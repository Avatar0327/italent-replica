/**
 * BE-11c-b 调动明细写入（R2-T08 §6.1 路由 16～18）：新增 / 修改 / 删除、基线、审计、幂等、
 * AC-OA-05（第 501 条 413）、AC-OA-42（调动部分，来源 / 目标部门受调整范围约束）、同日入职与重复员工的拒绝。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { transferWorld } from './AC-OA-11cb-support.js';
import { BASE, bodyOf, expectError } from './AC-OA-head-support.js';

const testDb = useTestDb();

interface Written {
  revision: number;
  items: { id: string; seq: number; employeeId: string; departmentId: string | null; baseRecordId: string }[];
}

describe('调动明细新增 / 修改 / 删除', () => {
  it('新增：201，取生效日现行任职为基线，revision + 1，写一条审计；响应不带执行期内部列', async () => {
    const w = await transferWorld(testDb().db, 'oa11cb-add');
    const mover = await w.staff(w.a);
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));

    const res = await w.addTransfer(view.id, w.transferBody(mover, { orgId: w.b }));

    expect(res.status, await res.clone().text()).toBe(201);
    const written = (await res.json()) as Written;
    expect(written.revision).toBe(view.revision + 1);
    const [row] = await w.transferRows(view.id);
    expect(row).toMatchObject({ seq: 1, employee_id: mover, department_id: w.b, exec_phase: 0 });
    expect(row!.base_record_id).toBe((await w.currentRecord(mover, '2026-11-01'))!.id);
    expect(written.items[0]).not.toHaveProperty('execPhase');
    expect(await w.transferAudits(view.id)).toEqual(['org-adjustment.transfer-item.create']);
  });

  it('修改目标部门、删除：revision 逐次 + 1，各写一条审计；删除后行不在库', async () => {
    const w = await transferWorld(testDb().db, 'oa11cb-patch-delete');
    const mover = await w.staff(w.a);
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    const added = await w.transfer(view.id, w.transferBody(mover, { orgId: w.b }));
    const itemId = added.items[0]!.id;

    const patched = await w.patchTransfer(view.id, itemId, { department: { orgId: w.a } });
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect((await w.transferRows(view.id))[0]).toMatchObject({ department_id: w.a });

    const removed = await w.deleteTransfer(view.id, itemId);
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await w.transferRows(view.id)).toEqual([]);
    expect(await w.transferAudits(view.id)).toEqual([
      'org-adjustment.transfer-item.create',
      'org-adjustment.transfer-item.update',
      'org-adjustment.transfer-item.delete',
    ]);
  });

  it('同键同内容重放：回放首次结果，不再多写一行', async () => {
    const w = await transferWorld(testDb().db, 'oa11cb-replay');
    const mover = await w.staff(w.a);
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    const idempotencyKey = randomUUID();
    const send = () =>
      w.call('POST', `${BASE}/${view.id}/transfer-items`, {
        ifMatch: view.revision,
        body: w.transferBody(mover, { orgId: w.b }),
        idempotencyKey,
      });

    const first = await send();
    const second = await send();

    expect(first.status, await first.clone().text()).toBe(201);
    expect(second.status).toBe(201);
    expect(await bodyOf(second)).toEqual(await bodyOf(first));
    expect(await w.transferRows(view.id)).toHaveLength(1);
  });

  it('同单同一员工只能一行：409 ORG_ADJUSTMENT_ITEM_DUPLICATE，不新增', async () => {
    const w = await transferWorld(testDb().db, 'oa11cb-duplicate');
    const mover = await w.staff(w.a);
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    await w.transfer(view.id, w.transferBody(mover, { orgId: w.b }));

    const res = await w.addTransfer(view.id, w.transferBody(mover, { orgId: w.a }));

    await expectError(res, 409, 'CONFLICT', 'ORG_ADJUSTMENT_ITEM_DUPLICATE');
    expect(await w.transferRows(view.id)).toHaveLength(1);
  });

  it('生效日当天入职的员工：409 ORG_ADJUSTMENT_SAME_DAY_ENTRY_NOT_AVAILABLE（11c2 开放），不新增', async () => {
    const w = await transferWorld(testDb().db, 'oa11cb-same-day');
    const mover = await w.staffHiredOnEffectiveDate(w.a);
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));

    const res = await w.addTransfer(view.id, w.transferBody(mover, { orgId: w.b }));

    await expectError(res, 409, 'CONFLICT', 'ORG_ADJUSTMENT_SAME_DAY_ENTRY_NOT_AVAILABLE');
    expect(await w.transferRows(view.id)).toEqual([]);
  });
});

describe('AC-OA-05 调动明细上限', () => {
  it('第 501 条：413 ORG_ADJUSTMENT_LIMIT_EXCEEDED，details 带 section / limit / count，库里仍 500 行', async () => {
    const w = await transferWorld(testDb().db, 'oa05-limit');
    const filler = await w.staff(w.a);
    const mover = await w.staff(w.a);
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    await w.seedMany(view.id, filler, 500);

    const res = await w.addTransfer(view.id, w.transferBody(mover, { orgId: w.b }));

    const body = await bodyOf(res);
    expect(res.status, JSON.stringify(body)).toBe(413);
    expect(body.error?.details).toMatchObject({
      reason: 'ORG_ADJUSTMENT_LIMIT_EXCEEDED',
      section: 'transfer',
      limit: 500,
      count: 501,
    });
    expect(await w.transferRows(view.id)).toHaveLength(500);
  });
});

describe('AC-OA-42 调动部分：来源与目标部门受调整范围约束', () => {
  it('目标部门不在调整范围：400 ORG_ADJUSTMENT_OUT_OF_RANGE（section transfer），不新增', async () => {
    const w = await transferWorld(testDb().db, 'oa42-target');
    const mover = await w.staff(w.a);
    const view = await w.created(w.headBody({ adjustmentRange: [w.a] }));

    const res = await w.addTransfer(view.id, w.transferBody(mover, { orgId: w.b }));

    await expectError(res, 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_OUT_OF_RANGE');
    expect(await w.transferRows(view.id)).toEqual([]);
  });

  it('来源部门（员工现部门）不在调整范围：400 ORG_ADJUSTMENT_OUT_OF_RANGE，不新增', async () => {
    const w = await transferWorld(testDb().db, 'oa42-source');
    const mover = await w.staff(w.b);
    const view = await w.created(w.headBody({ adjustmentRange: [w.a] }));

    const res = await w.addTransfer(view.id, w.transferBody(mover, { orgId: w.a }));

    await expectError(res, 400, 'VALIDATION_FAILED', 'ORG_ADJUSTMENT_OUT_OF_RANGE');
    expect(await w.transferRows(view.id)).toEqual([]);
  });

  it('改头收窄范围后已有调动行落到范围外：400 ORG_ADJUSTMENT_OUT_OF_RANGE，items 带 section transfer', async () => {
    const w = await transferWorld(testDb().db, 'oa42-narrow');
    const mover = await w.staff(w.a);
    const view = await w.created(w.headBody({ adjustmentRange: [w.a, w.b] }));
    await w.transfer(view.id, w.transferBody(mover, { orgId: w.b }));

    const res = await w.patch(view.id, { adjustmentRange: [w.a] }, 2);

    const body = await bodyOf(res);
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error?.details?.items).toEqual([expect.objectContaining({ section: 'transfer' })]);
  });
});

describe('关闭项保持关闭', () => {
  it('职位 / 编制 / 兼职明细路由仍未注册', async () => {
    const w = await transferWorld(testDb().db, 'oa11cb-closed-routes');
    const view = await w.created();
    for (const path of ['position-items', 'establishment-items', 'part-time-items']) {
      const res = await w.call('POST', `${BASE}/${view.id}/${path}`, { ifMatch: view.revision, body: {} });
      expect(res.status, path).toBe(404);
    }
  });
});
