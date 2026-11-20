/**
 * AC-ESIGN-F505-18（S1 部分）写入口接线：Offer 与待入职记录的每个写入口都经来源事件端口通知订阅方
 * （端口只发事件，S1 没有业务订阅方；这里登记一个记录型订阅方，经真实 HTTP 路由验证事件种类与来源 ID）。
 * 覆盖：Offer 删除 / 失效（离开可签）/ 字段修改（变更）/ 仅关联同步（不发）；
 * 待入职取消（离开可签）/ 改期（旧记录被替换删除）/ 删除。
 */
import type { ESignSourceEvent } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerEntrySourceEvents,
  resetEntrySourceEventsForTest,
} from '../../apps/api/src/modules/employment/entry-source-events.js';
import {
  registerOfferSourceEvents,
  resetOfferSourceEventsForTest,
} from '../../apps/api/src/modules/offer/source-events.js';
import { fullSocial, syncWorld } from './AC-OF-BE14b2-support.js';

const db = useTestDb();
const seen: ESignSourceEvent[] = [];
const brief = () => seen.map(({ source, sourceId, change }) => ({ source, sourceId, change }));

afterEach(() => {
  seen.length = 0;
  resetOfferSourceEventsForTest();
  resetEntrySourceEventsForTest();
});
function record() {
  registerOfferSourceEvents('recorder', async (_tx, _ctx, event) => void seen.push(event));
  registerEntrySourceEvents('recorder', async (_tx, _ctx, event) => void seen.push(event));
}

describe('AC-ESIGN-F505-18 Offer 写入口接线', () => {
  it('进入可签（待发 → 已接受）与仅关联同步不发事件；字段修改发 changed；失效发 left_signable；删除发 deleted', async () => {
    const w = await syncWorld(db().db, 'wire-offer');
    record();
    const offer = await fullSocial(w);
    const accepted = await w.accepted(offer);
    expect(seen, '进入可签不发事件').toEqual([]);
    const synced = await w.synced(accepted);
    expect(seen, '同步只回写关联列，不发事件').toEqual([]);

    const edited = await w.request('PUT', `/${synced.id}`, {
      ifMatch: synced.revision,
      body: { name: '合成候选人改名' },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(brief()).toEqual([{ source: 'offer', sourceId: synced.id, change: 'changed' }]);

    seen.length = 0;
    const current = await w.get(synced.id);
    const invalid = await w.invalidate(current, { reasonCode: 'candidate_gave_up' });
    expect(invalid.status, await invalid.clone().text()).toBe(200);
    expect(brief()).toContainEqual({ source: 'offer', sourceId: synced.id, change: 'left_signable' });

    seen.length = 0;
    const draft = await w.social();
    const removed = await w.request('DELETE', `/${draft.id}`, { ifMatch: draft.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(brief()).toEqual([{ source: 'offer', sourceId: draft.id, change: 'deleted' }]);
  });
});

describe('AC-ESIGN-F505-18 待入职写入口接线', () => {
  it('取消发 left_signable；改期替换旧记录发 deleted（旧 ID）；删除发 deleted', async () => {
    const w = await syncWorld(db().db, 'wire-entry');
    const entryOfNewOffer = async () => w.entryOf(await w.accepted(await fullSocial(w)));
    const first = await entryOfNewOffer();
    const second = await entryOfNewOffer();
    const third = await entryOfNewOffer();
    record();

    const cancelled = await w.entryAction(first.id, 'cancel', { reason: 'personal' });
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    expect(brief()).toContainEqual({ source: 'entry', sourceId: first.id, change: 'left_signable' });

    seen.length = 0;
    const postponed = await w.entryAction(second.id, 'postpone', { effectiveDate: '2026-11-10' });
    expect(postponed.status, await postponed.clone().text()).toBe(200);
    expect(brief()).toContainEqual({ source: 'entry', sourceId: second.id, change: 'deleted' });

    seen.length = 0;
    const deleted = await w.employment('DELETE', `/pending-entries/${third.id}`, {
      ifMatch: await w.businessRevision(third.id),
    });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(brief()).toContainEqual({ source: 'entry', sourceId: third.id, change: 'deleted' });
  });
});
