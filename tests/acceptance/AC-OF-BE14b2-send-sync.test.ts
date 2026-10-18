/**
 * BE-14b2 合 main 收口：#406 的发送事务接入“发送时同步待入职”（OF-R8 时机 = 发送时）。
 * 业务规则拒绝（含强控超编，确认标记只管弱控）记为同步失败、发送保留；存储不可用等非业务错误让整个发送事务回滚
 * （不留已发状态、发送记录、人员或待入职）。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ESTABLISHMENT_CHECKS,
  registerEmploymentActivationChecks,
} from '../../apps/api/src/modules/employment/activation-checks.js';
import { syncWorld, type SyncOffer } from './AC-OF-BE14b2-support.js';

const testDb = useTestDb();
const rows = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
afterEach(() => registerEmploymentActivationChecks(DEFAULT_ESTABLISHMENT_CHECKS));

const body = async (response: Response) => (await response.json()) as SyncOffer & { sendRecord?: { kind: string } };

describe('发送时同步（OF-R8 时机 = 发送时）', () => {
  it('时机 = 发送时：发送成功即同步，响应带同步结果，待入职出现；重发不再生成', async () => {
    const w = await syncWorld(testDb().db, 'send-sync-on');
    await w.timing({ mode: 'on_send' });
    const offer = await w.social();
    const response = await w.send(offer);
    expect(response.status, await response.clone().text()).toBe(200);
    const sent = await body(response);
    expect(sent).toMatchObject({
      status: 'sent',
      syncStatus: 'success',
      hasPendingEntry: true,
      sendRecord: { kind: 'send' },
    });
    expect(await w.entries()).toHaveLength(1);
    const again = await w.send(sent);
    expect(again.status, await again.clone().text()).toBe(200);
    expect(await body(again)).toMatchObject({
      sendRecord: { kind: 'resend' },
      pendingEntryBusinessId: sent.pendingEntryBusinessId,
    });
    expect(await w.entries()).toHaveLength(1);
  });

  it('时机 = 接受时（出厂）：发送不同步；开关关闭也不同步', async () => {
    const w = await syncWorld(testDb().db, 'send-sync-off');
    const first = await body(await w.send(await w.social()));
    expect(first).toMatchObject({ status: 'sent', syncStatus: null, hasPendingEntry: false });
    await w.timing({ mode: 'on_send', enabled: false });
    const second = await body(await w.send(await w.social()));
    expect(second).toMatchObject({ status: 'sent', syncStatus: null, hasPendingEntry: false });
    expect(await w.entries()).toHaveLength(0);
  });

  it('强控超编：确认标记只管弱控，绕不过强控——发送成功，同步失败 ESTABLISHMENT_EXCEEDED，无人员 / 待入职', async () => {
    const w = await syncWorld(testDb().db, 'send-sync-strict');
    await w.timing({ mode: 'on_send' });
    w.strictCapacity();
    const offer = await w.social();
    const response = await w.send(offer, { confirmed: true });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await body(response)).toMatchObject({
      status: 'sent',
      syncStatus: 'failed',
      syncReason: 'ESTABLISHMENT_EXCEEDED',
      hasPendingEntry: false,
    });
    expect(await w.entries()).toHaveLength(0);
    const [created] = rows<{ n: number }>(
      await withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT count(*)::int AS n FROM employment_employees WHERE code LIKE 'OFR-%'`),
      ),
    );
    expect(created!.n).toBe(0);
  });

  it('非业务错误（存储不可用）：整个发送事务回滚——仍是待发、没有发送记录、没有人员 / 待入职', async () => {
    const w = await syncWorld(testDb().db, 'send-sync-rollback');
    await w.timing({ mode: 'on_send' });
    registerEmploymentActivationChecks({
      establishmentExceeded: async () => {
        throw new Error('storage unavailable');
      },
    });
    const offer = await w.social();
    const response = await w.send(offer, { confirmed: true });
    expect(response.status).toBeGreaterThanOrEqual(500);
    registerEmploymentActivationChecks(DEFAULT_ESTABLISHMENT_CHECKS);
    expect(await w.read(offer.id)).toMatchObject({ status: 'pending', revision: offer.revision, syncAttempts: 0 });
    const [counts] = rows<{ records: number; people: number }>(
      await withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT
          (SELECT count(*) FROM offer_send_records WHERE offer_id = ${offer.id}::uuid)::int AS records,
          (SELECT count(*) FROM employment_employees WHERE code LIKE 'OFR-%')::int AS people`),
      ),
    );
    expect(counts).toEqual({ records: 0, people: 0 });
    expect(await w.entries()).toHaveLength(0);
  });
});
