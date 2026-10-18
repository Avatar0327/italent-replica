/**
 * BE-14b3 第 1 轮审查返工 P2-1：已取消入职不得被推送任何数据（锁内核验目标后整笔不写）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { overrideSetting } from './AC-OF-BE14b1-support.js';
import { fullSocial, syncWorld } from './AC-OF-BE14b2-support.js';
import { edited, targetState } from './AC-OF-BE14b3-support.js';

const testDb = useTestDb();

describe('P2-1 已取消入职：整笔不写目标', () => {
  it('OF-R9 关、待入职已取消，改姓名 + 同步 → skipped，员工版本 / 姓名 / 审计 / 任职 / 合同都不变，Offer 编辑保留', async () => {
    const w = await syncWorld(testDb().db, 'p1-cancelled');
    expect(
      (await overrideSetting(w, 'offer.linkage', { entryCancelRejects: false, reapprovalAllowed: true })).status,
    ).toBe(200);
    const offer = await w.accepted(await fullSocial(w));
    expect((await w.entryAction(offer.pendingEntryBusinessId!, 'cancel', {})).status).toBe(200);
    const before = await targetState(w, offer.id);
    const result = await edited(w, await w.read(offer.id), {
      name: '取消后改名',
      workPlace: '杭州',
      plannedEntryDate: '2026-12-01',
      syncPendingEntry: true,
    });
    expect(result).toMatchObject({ entrySync: 'skipped', name: '取消后改名', plannedEntryDate: '2026-12-01' });
    expect(await targetState(w, offer.id)).toEqual(before);
  });
});
