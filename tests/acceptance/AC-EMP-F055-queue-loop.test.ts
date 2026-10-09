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
  probeBaseline,
  probeDerived,
  probeEnqueue,
  probeRound,
  probeState,
} from './AC-EMP-F055-support.js';

const database = useTestDb();

async function setup(label: string) {
  const w = await f055World(database().db, label);
  await installProbeQueue(w.db);
  await probeBaseline(w.db, w.tenantId);
  const round = async (at: string) => {
    await probeEnqueue(w.db, w.tenantId);
    return probeRound(w.db, w.context(at));
  };
  return { w, round };
}

describe('AC-EMP-F055 状态队列取数循环', () => {
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

  it('③ 改期（删除后以新日期重存）后按新日期取：旧事件 skipped，新事件到新日期才处理', async () => {
    const { w, round } = await setup('f055-loop-moved');
    const old = await w.transfer('2026-10-05');
    const moved = await w.reschedule(old, '2026-10-15');
    expect((await round('2026-10-05T01:00:00Z')).map((row) => row.recordId)).toEqual([old]);
    expect(await probeState(w.db, w.tenantId, old)).toEqual([{ state: 'skipped', reason: 'RECORD_NOT_EFFECTIVE' }]);
    expect(await round('2026-10-14T01:00:00Z')).toEqual([]);
    expect(await probeDerived(w.db, w.tenantId, moved)).toEqual([]);
    expect((await round('2026-10-15T01:00:00Z')).map((row) => row.recordId)).toEqual([moved]);
    expect(await probeDerived(w.db, w.tenantId, moved)).toEqual([{ effectiveDate: '2026-10-15' }]);
    expect(await probeDerived(w.db, w.tenantId, old)).toEqual([]);
  });

  it('④ 取数后、持锁前被改期（删除重存）：旧事件复核 gone 不写派生数据；新事件另行入队，到期再处理', async () => {
    const { w, round } = await setup('f055-loop-moved-after-pick');
    const old = await w.transfer('2026-10-03');
    await probeEnqueue(w.db, w.tenantId);
    let moved = '';
    const picked = await probeRound(w.db, w.context('2026-10-03T01:00:00Z'), {
      beforeLock: async () => {
        if (!moved) moved = await w.reschedule(old, '2026-10-30');
      },
    });
    expect(picked.map((row) => row.recordId)).toEqual([old]);
    expect(await probeState(w.db, w.tenantId, old)).toEqual([{ state: 'skipped', reason: 'RECORD_NOT_EFFECTIVE' }]);
    expect(await probeDerived(w.db, w.tenantId, old)).toEqual([]);
    expect(await round('2026-10-29T01:00:00Z')).toEqual([]);
    expect(await probeState(w.db, w.tenantId, moved)).toEqual([{ state: 'pending', reason: null }]);
    expect((await round('2026-10-30T01:00:00Z')).map((row) => row.recordId)).toEqual([moved]);
    expect(await probeState(w.db, w.tenantId, moved)).toEqual([{ state: 'done', reason: null }]);
  });

  it('⑥ 同 ID 顺延：取数后持锁前被顺延到更晚的执行日 → not_yet，退回 pending，不写派生数据；执行日再处理', async () => {
    const { w, round } = await setup('f055-loop-postponed');
    const id = await w.transfer('2026-10-05');
    await probeEnqueue(w.db, w.tenantId);
    // 消费者按 10-09（租户当天）取数；取数之后、持员工锁之前，顺延命令在 10-10 提交
    const picked = await probeRound(w.db, w.context('2026-10-09T01:00:00Z'), {
      beforeLock: () => w.postpone(id, '2026-10-10T01:00:00Z'),
    });
    expect(picked.map((row) => row.recordId)).toEqual([id]);
    expect(await probeState(w.db, w.tenantId, id)).toEqual([{ state: 'pending', reason: null }]);
    expect(await probeDerived(w.db, w.tenantId, id)).toEqual([]);
    expect(await round('2026-10-09T10:00:00Z')).toEqual([]);
    expect((await round('2026-10-10T01:00:00Z')).map((row) => row.recordId)).toEqual([id]);
    expect(await probeState(w.db, w.tenantId, id)).toEqual([{ state: 'done', reason: null }]);
    expect(await probeDerived(w.db, w.tenantId, id)).toEqual([{ effectiveDate: '2026-10-10' }]);
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
