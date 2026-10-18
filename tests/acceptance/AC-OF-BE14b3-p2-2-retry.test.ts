/**
 * BE-14b3 第 1 轮审查返工 P2-2：失败重试 / “否 → 是”以目标当前数据算差异，不遗漏。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { fullSocial, syncWorld } from './AC-OF-BE14b2-support.js';
import { edited, expectMirrors, targetState } from './AC-OF-BE14b3-support.js';

const testDb = useTestDb();

describe('P2-2 失败重试 / 否 → 是：与目标当前数据比较', () => {
  it('同次改姓名 + 非法入职日（早于部门设立日）选同步 → failed、目标不变；改正日期原姓名重提 → pushed 且姓名同步', async () => {
    const w = await syncWorld(testDb().db, 'p2-retry');
    const offer = await w.accepted(await fullSocial(w));
    const before = await targetState(w, offer.id);
    const failed = await edited(w, offer, { name: '重试姓名', plannedEntryDate: '2025-12-01', syncPendingEntry: true });
    expect(failed.entrySync).toBe('failed');
    expect(await targetState(w, offer.id)).toEqual(before);
    const retried = await edited(w, failed, {
      name: '重试姓名',
      plannedEntryDate: '2026-12-01',
      syncPendingEntry: true,
    });
    expect(retried).toMatchObject({ entrySync: 'pushed', syncStatus: 'success' });
    await expectMirrors(w, offer.id);
  });

  it('先选“否”保存新姓名 / 地点 / 合同终止日，下一次选“是” → 目标各类映射都补齐', async () => {
    const w = await syncWorld(testDb().db, 'p2-no-then-yes');
    const offer = await w.accepted(await fullSocial(w));
    const no = await edited(w, offer, {
      name: '先否后是',
      workPlace: '成都',
      contractEndDate: '2029-10-31',
      syncPendingEntry: false,
    });
    expect((await w.entryOf(no)).name).not.toBe('先否后是');
    const yes = await edited(w, no, { plannedEntryDate: '2026-12-01', syncPendingEntry: true });
    expect(yes.entrySync).toBe('pushed');
    await expectMirrors(w, offer.id);
  });

  it('员工资料已一致、只差入职日：只推任职 / 合同，不白追加员工版本；全都一致 → unchanged', async () => {
    const w = await syncWorld(testDb().db, 'p2-diff-only');
    const offer = await w.accepted(await fullSocial(w));
    const before = await targetState(w, offer.id);
    const same = await edited(w, offer, { costCenter: 'CC-NEW', syncPendingEntry: true });
    expect(same.entrySync).toBe('unchanged');
    expect(await targetState(w, offer.id)).toEqual(before);
    const dated = await edited(w, same, { plannedEntryDate: '2026-12-01', syncPendingEntry: true });
    expect(dated.entrySync).toBe('pushed');
    const after = await targetState(w, offer.id);
    expect(after.profile).toEqual(before.profile);
  });
});
