/**
 * AC-SC-01 写侧权限（R3-T05 A2，设计 §8.3；DEC-043 / 080 / 308 / 406）：真实授权器下的继任记录写入口——
 * 对象数据操作权与按钮（create / update / end / delete）、载荷字段编辑权（含置空）、目标范围（范围外与不存在同一个 404）、
 * 继任者不受操作人范围限制（DEC-308）、返回前复核（首次响应与同键重放都按当前范围）。
 * DEC-406：权限类问题不挡合并（转 F-087），但写入口从一开始就接 guard / ledgerExit，这里验证主路径。
 */
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { permissionWorldOf, recordOperator } from './AC-SC-permission-support.js';
import { type RecordView, type SuccessionWorld, successionWorld } from './AC-SC-support.js';
import type { PermissionWorld } from './AC-PRM-support.js';

const testDb = useTestDb();
const reasonOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; details?: { reason?: string } } }).error;

describe('AC-SC-01 继任记录写侧权限（真实授权器）', () => {
  let w: SuccessionWorld;
  let world: PermissionWorld;
  let std: Awaited<ReturnType<SuccessionWorld['standard']>>;
  let seq = 0;

  beforeAll(async () => {
    w = await successionWorld(testDb().db, 'sc-write-guard');
    std = await w.standard();
    world = await permissionWorldOf(w);
  });

  const successor = () => w.hire(`权限继任${++seq}`, { departmentId: std.orgB.id });
  const body = (employeeId: string, targetOrgId: string, extra: object = {}) => ({
    successionType: 'org',
    targetOrgId,
    successorEmployeeId: employeeId,
    startDate: '2026-09-01',
    ...extra,
  });
  const ALL = { create: true, update: true, delete: true };

  it('没有对应按钮 / 数据操作权：新增、编辑、结束、删除、候选下拉各自 403 FORBIDDEN', async () => {
    const reader = await recordOperator(world, { seeAll: true });
    const s = await successor();
    const seeded = await w.insertRecord({ type: 'org', targetId: std.orgA.id, successorId: s.id });
    const attempts = [
      reader.request('POST', '/records', { body: body((await successor()).id, std.orgA.id) }),
      reader.request('PUT', `/records/${seeded}`, { ifMatch: 1, body: { backupType: 'deputy' } }),
      reader.request('POST', '/records/end', {
        body: { items: [{ id: seeded, expectedRevision: 1 }], endDate: '2026-09-30' },
      }),
      reader.request('DELETE', `/records/${seeded}`, { ifMatch: 1 }),
      reader.request('GET', '/successor-candidates?q=权限'),
    ];
    for (const response of await Promise.all(attempts)) {
      expect([response.status, (await reasonOf(response)).code]).toEqual([403, 'FORBIDDEN']);
    }
  });

  it('只有数据操作权没有按钮：新增 403（按钮与数据操作权两层都要）', async () => {
    const op = await recordOperator(world, { seeAll: true, writer: { operations: ALL, buttons: [] } });
    const response = await op.request('POST', '/records', { body: body((await successor()).id, std.orgA.id) });
    expect([response.status, (await reasonOf(response)).code]).toEqual([403, 'FORBIDDEN']);
  });

  it('目标范围：范围内新增 201；范围外的目标与不存在同一个 404；继任者不受操作人范围限制（DEC-308）', async () => {
    const op = await recordOperator(world, {
      orgIds: [std.orgA.id],
      writer: { operations: ALL, buttons: ['create', 'update', 'end', 'delete'] },
    });
    const outside = await successor(); // 继任者在 B 部，不在操作人范围内
    const inside = await op.request('POST', '/records', { body: body(outside.id, std.orgA.id) });
    expect(inside.status, await inside.clone().text()).toBe(201);
    const view = (await inside.json()) as RecordView;
    // 嵌套继任者照原站显示，不按操作人数据范围隐藏（DEC-311③）
    expect(view.successor?.employeeId).toBe(outside.id);
    const out = await op.request('POST', '/records', { body: body((await successor()).id, std.orgB.id) });
    expect([out.status, (await reasonOf(out)).code]).toEqual([404, 'NOT_FOUND']);
    // 范围外记录：编辑 / 结束 / 删除一律 404
    const foreign = await w.insertRecord({ type: 'org', targetId: std.orgB.id, successorId: (await successor()).id });
    expect(
      (await op.request('PUT', `/records/${foreign}`, { ifMatch: 1, body: { backupType: 'deputy' } })).status,
    ).toBe(404);
    expect((await op.request('DELETE', `/records/${foreign}`, { ifMatch: 1 })).status).toBe(404);
    const end = await op.request('POST', '/records/end', {
      body: {
        items: [
          { id: view.id, expectedRevision: 1 },
          { id: foreign, expectedRevision: 1 },
        ],
        endDate: '2026-09-30',
      },
    });
    expect(end.status).toBe(404);
    expect((await w.request('GET', `/records/${view.id}`)).status).toBe(200); // 整批 404：范围内那条没被结束
    expect(((await (await w.request('GET', `/records/${view.id}`)).json()) as RecordView).status).toBe('active');
  });

  it('候选下拉：持 create 或 update 任一按钮即可，不受 HR 数据范围限制', async () => {
    for (const button of ['create', 'update']) {
      const op = await recordOperator(world, {
        orgIds: [std.orgA.id],
        writer: { operations: { create: button === 'create', update: button === 'update' }, buttons: [button] },
      });
      const response = await op.request('GET', `/successor-candidates?q=${encodeURIComponent('继任丙')}`);
      expect(response.status, button).toBe(200);
      const found = (await response.json()) as { items: { employeeId: string }[] };
      expect(
        found.items.map((item) => item.employeeId),
        button,
      ).toContain(std.successor1.id);
    }
  });

  it('载荷字段编辑权：无 readinessId 编辑权的人带 readinessId 新增 403；显式置空同样要编辑权', async () => {
    const op = await recordOperator(world, {
      seeAll: true,
      writer: { operations: ALL, buttons: ['create', 'update'], noEdit: ['readinessId'] },
    });
    const level = await w.readiness('权限级');
    const denied = await op.request('POST', '/records', {
      body: body((await successor()).id, std.orgA.id, { readinessId: level.id }),
    });
    expect(denied.status).toBe(403);
    const ok = await op.request('POST', '/records', { body: body((await successor()).id, std.orgA.id) });
    expect(ok.status, await ok.clone().text()).toBe(201);
    const created = (await ok.json()) as RecordView;
    const clear = await op.request('PUT', `/records/${created.id}`, { ifMatch: 1, body: { readinessId: null } });
    expect(clear.status).toBe(403);
  });

  it('返回前复核：同键重放时目标已出范围 → 404，不返回首次结果', async () => {
    const op = await recordOperator(world, {
      orgIds: [std.orgA.id],
      writer: { operations: ALL, buttons: ['create'] },
    });
    const s = await successor();
    const key = `sc-guard-replay-${s.id}`;
    const payload = body(s.id, std.orgA.id);
    const first = await op.request('POST', '/records', { body: payload, idempotencyKey: key });
    expect(first.status).toBe(201);
    // 把该记录的目标改到范围外的组织（直接改库模拟“撤权 / 范围变化”），同键重放必须 404
    await w.asTenant(async (tx) => {
      const { sql } = await import('@italent/db');
      await tx.execute(sql`UPDATE succession_records SET target_org_id = ${std.orgB.id}::uuid
        WHERE id = ${((await first.clone().json()) as RecordView).id}::uuid`);
    });
    const replay = await op.request('POST', '/records', { body: payload, idempotencyKey: key });
    expect([replay.status, (await reasonOf(replay)).code]).toEqual([404, 'NOT_FOUND']);
  });
});
