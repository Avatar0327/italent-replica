/**
 * F-309：Offer 合同日期校验与正式合同服务口径统一（DEC-667）——终止日必须晚于起始日（= 计划入职日），同日同样拒绝。
 * 失败走既有的明确业务拒绝（同步失败回执 OFFER_CONTRACT_DATE_INVALID，平台无 422，沿用 VALIDATION_FAILED 口径）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { fullSocial, syncWorld } from './AC-OF-BE14b2-support.js';
import { edited, targetState } from './AC-OF-BE14b3-support.js';

const testDb = useTestDb();

// 夹具的计划入职日为 2026-11-01
describe('F-309 Offer 合同终止日须晚于起始日', () => {
  it.each([
    ['同日', '2026-11-01'],
    ['早一日', '2026-10-31'],
  ])('编辑并同步：终止日%s → 同步失败 OFFER_CONTRACT_DATE_INVALID，目标整笔不变', async (name, contractEndDate) => {
    const w = await syncWorld(testDb().db, `f309-${contractEndDate}`);
    const offer = await w.accepted(await fullSocial(w));
    const before = await targetState(w, offer.id);
    const result = await edited(w, offer, { name: `合同冲突${name}`, contractEndDate, syncPendingEntry: true });
    expect(result.entrySync).toBe('failed');
    expect(result).toMatchObject({ syncStatus: 'failed', syncReason: 'OFFER_CONTRACT_DATE_INVALID' });
    expect(await targetState(w, offer.id)).toEqual(before);
  });

  it('晚一日（2026-11-02）→ 通过，待入职合同按新终止日推送', async () => {
    const w = await syncWorld(testDb().db, 'f309-later');
    const offer = await w.accepted(await fullSocial(w));
    const result = await edited(w, offer, { contractEndDate: '2026-11-02', syncPendingEntry: true });
    expect(result.entrySync).toBe('pushed');
    expect((await targetState(w, offer.id)).contract).toEqual([
      expect.objectContaining({ start_date: '2026-11-01', end_date: '2026-11-02' }),
    ]);
  });

  it('接受后首次同步：终止日等于计划入职日 → 同步失败（不进入合同服务才被拒）', async () => {
    const w = await syncWorld(testDb().db, 'f309-first-sync');
    const offer = await w.accepted(await fullSocial(w, { contractEndDate: '2026-11-01' }));
    expect(offer).toMatchObject({ syncStatus: 'failed', syncReason: 'OFFER_CONTRACT_DATE_INVALID' });
  });
});
