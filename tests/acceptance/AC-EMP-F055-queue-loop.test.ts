/**
 * F-055（R3-T02 拆分方案 §10.3）：真实取数循环，不直接调复核函数。
 * 探针队列严格按 §10.2 的消费方约定：recordEventReadySql 取数 → lockEmploymentEmployee → recheckRecordEvent → 更新队列行。
 * 真实消费者（C1-4、C2-1b）各自再用真实调度器重跑同一组用例。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  f055World,
  installProbeQueue,
  probeDerived,
  probeEnqueue,
  probeRound,
  probeState,
} from './AC-EMP-F055-support.js';

const database = useTestDb();

async function setup(label: string) {
  const w = await f055World(database().db, label);
  await installProbeQueue(w.db);
  const round = async (at: string) => {
    await probeEnqueue(w.db, w.tenantId);
    return probeRound(w.db, w.context(at));
  };
  return { w, round };
}

describe('F-055 状态队列取数循环', () => {
  it('① 保存未来离职 → 删除 → 跑一轮：行被取到并 skipped: RECORD_NOT_EFFECTIVE，不留 pending，无派生数据', async () => {
    const { w, round } = await setup('f055-loop-deleted');
    const id = await w.leave('2026-10-19');
    await w.remove(id);
    const picked = await round('2026-10-02T01:00:00Z');
    expect(picked.map((row) => row.recordId)).toEqual([id]);
    expect(await probeState(w.db, w.tenantId, id)).toEqual([{ state: 'skipped', reason: 'RECORD_NOT_EFFECTIVE' }]);
    expect(await probeDerived(w.db, w.tenantId, id)).toEqual([]);
    // 之后再跑也不会重复处理
    expect(await round('2026-10-25T01:00:00Z')).toEqual([]);
  });

  it('② 保存未来调动不删 → 跑一轮不取；推进到生效日再跑 → done 并写派生数据', async () => {
    const { w, round } = await setup('f055-loop-due');
    const id = await w.transfer('2026-10-05');
    expect(await round('2026-10-04T01:00:00Z')).toEqual([]);
    expect(await probeState(w.db, w.tenantId, id)).toEqual([{ state: 'pending', reason: null }]);
    expect(await probeDerived(w.db, w.tenantId, id)).toEqual([]);
    const picked = await round('2026-10-05T01:00:00Z');
    expect(picked.map((row) => row.recordId)).toEqual([id]);
    expect(await probeState(w.db, w.tenantId, id)).toEqual([{ state: 'done', reason: null }]);
    expect(await probeDerived(w.db, w.tenantId, id)).toEqual([{ effectiveDate: '2026-10-05' }]);
  });

  it('③ 改期后按新日期取：原日期到了不取，新日期到了才取', async () => {
    const { w, round } = await setup('f055-loop-moved');
    const id = await w.transfer('2026-10-05');
    await w.moveTimeline(id, '2026-10-15');
    expect(await round('2026-10-05T01:00:00Z')).toEqual([]);
    expect(await round('2026-10-14T01:00:00Z')).toEqual([]);
    expect(await probeDerived(w.db, w.tenantId, id)).toEqual([]);
    expect((await round('2026-10-15T01:00:00Z')).map((row) => row.recordId)).toEqual([id]);
    expect(await probeDerived(w.db, w.tenantId, id)).toEqual([{ effectiveDate: '2026-10-15' }]);
  });

  it('④ 取数后、持锁前被改期到未来：复核为 not_yet，回 pending，不写派生数据，之后到期再处理', async () => {
    const { w, round } = await setup('f055-loop-moved-after-pick');
    const id = await w.transfer('2026-10-03');
    await probeEnqueue(w.db, w.tenantId);
    let moved = false;
    const picked = await probeRoundWithMove(w, id, '2026-10-30', () => (moved = true));
    expect(moved).toBe(true);
    expect(picked.map((row) => row.recordId)).toEqual([id]);
    expect(await probeState(w.db, w.tenantId, id)).toEqual([{ state: 'pending', reason: null }]);
    expect(await probeDerived(w.db, w.tenantId, id)).toEqual([]);
    expect(await round('2026-10-29T01:00:00Z')).toEqual([]);
    expect((await round('2026-10-30T01:00:00Z')).map((row) => row.recordId)).toEqual([id]);
    expect(await probeState(w.db, w.tenantId, id)).toEqual([{ state: 'done', reason: null }]);
  });

  it('⑤ 重复入队只一行', async () => {
    const { w, round } = await setup('f055-loop-dedupe');
    const id = await w.transfer('2026-10-02');
    await probeEnqueue(w.db, w.tenantId);
    await round('2026-10-02T01:00:00Z');
    await probeEnqueue(w.db, w.tenantId);
    expect(await probeState(w.db, w.tenantId, id)).toHaveLength(1);
  });
});

async function probeRoundWithMove(
  w: Awaited<ReturnType<typeof setup>>['w'],
  recordId: string,
  newDate: string,
  onMoved: () => void,
) {
  return probeRound(w.db, w.context('2026-10-03T01:00:00Z'), {
    beforeLock: async () => {
      await w.moveTimeline(recordId, newDate);
      onMoved();
    },
  });
}
