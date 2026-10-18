/**
 * BE-14b3 第 1 轮审查返工 P2-3：合同日期冲突是明确的业务拒绝（同步失败回执），不是 500。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { fullSocial, syncWorld } from './AC-OF-BE14b2-support.js';
import { edited, targetState, type Edited } from './AC-OF-BE14b3-support.js';

const testDb = useTestDb();

describe('P2-3 合同日期预校验', () => {
  const failedWithReason = (result: Edited) => {
    expect(result.entrySync).toBe('failed');
    expect(result).toMatchObject({ syncStatus: 'failed', syncReason: 'OFFER_CONTRACT_DATE_INVALID' });
    expect(result.syncMessage).toEqual(expect.any(String));
  };

  it('编辑入职日跨过合同终止日：HTTP 200 + 同步失败（带原因），Offer 编辑保留，员工 / 任职 / 合同整笔回滚', async () => {
    const w = await syncWorld(testDb().db, 'p3-start-after-end');
    const offer = await w.accepted(await fullSocial(w, { contractEndDate: '2027-10-31' }));
    const before = await targetState(w, offer.id);
    const result = await edited(w, offer, { name: '合同冲突', plannedEntryDate: '2028-01-01', syncPendingEntry: true });
    failedWithReason(result);
    expect(result).toMatchObject({ plannedEntryDate: '2028-01-01', name: '合同冲突' });
    expect(await targetState(w, offer.id)).toEqual(before);
  });

  it('反向：编辑合同终止日早于入职日 → 同样是明确的同步失败，目标不变', async () => {
    const w = await syncWorld(testDb().db, 'p3-end-before-start');
    const offer = await w.accepted(await fullSocial(w));
    const before = await targetState(w, offer.id);
    const result = await edited(w, offer, {
      name: '合同冲突二',
      contractEndDate: '2026-10-01',
      syncPendingEntry: true,
    });
    failedWithReason(result);
    expect(await targetState(w, offer.id)).toEqual(before);
  });
});
