/**
 * AC-SC-01（R3-T05 A1，设计 §1.1 准备度行、§12）：准备度引用守卫——被继任记录引用的准备度不可删（409
 * READINESS_IN_USE，引用方 SUCCESSION_RECORD，同 #106 做法），含已结束记录；已删除记录不占用；可以停用。
 * 走 T04 的准备度字典接口，守卫由继任模块在装配时登记。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { successionWorld } from './AC-SC-support.js';

const testDb = useTestDb();

describe('AC-SC-01 准备度引用守卫', () => {
  it('被继任记录引用不可删；未引用可删；已结束 / 已删除记录的口径', async () => {
    const w = await successionWorld(testDb().db, 'sc-guard');
    const std = await w.standard();
    const used = await w.readiness('被引用');
    const free = await w.readiness('未引用');
    const viaEnded = await w.readiness('仅被已结束引用');
    const viaDeleted = await w.readiness('仅被已删除引用');
    await w.insertRecord({ type: 'org', targetId: std.orgA.id, successorId: std.successor1.id, readinessId: used.id });
    await w.insertRecord({
      type: 'org',
      targetId: std.orgB.id,
      successorId: std.successor1.id,
      readinessId: viaEnded.id,
      startDate: '2026-01-01',
      endDate: '2026-02-01',
    });
    await w.insertRecord({
      type: 'org',
      targetId: std.orgB.id,
      successorId: std.successor2.id,
      readinessId: viaDeleted.id,
      deleted: true,
    });

    const remove = (id: string) => w.call('DELETE', `talent-review/readiness-levels/${id}`, { ifMatch: 1 });
    const read = async (id: string) => (await w.call('GET', `talent-review/readiness-levels/${id}`)).status;

    for (const id of [used.id, viaEnded.id]) {
      const response = await remove(id);
      const body = (await response.json()) as {
        error: { code: string; details?: { reason?: string; referrer?: string } };
      };
      expect([response.status, body.error.code, body.error.details?.reason, body.error.details?.referrer]).toEqual([
        409,
        'CONFLICT',
        'READINESS_IN_USE',
        'SUCCESSION_RECORD',
      ]);
      expect(await read(id), '被拒删除后仍在').toBe(200);
    }
    // 已删除记录不占用；未引用的直接可删
    expect((await remove(viaDeleted.id)).status).toBe(200);
    expect((await remove(free.id)).status).toBe(200);
    expect(await read(free.id)).toBe(404);
    // 引用中的准备度可以停用（已有引用保留）
    const patch = await w.call('PATCH', `talent-review/readiness-levels/${used.id}`, {
      ifMatch: 1,
      body: { enabled: false },
    });
    expect(patch.status, await patch.clone().text()).toBe(200);
  });
});
