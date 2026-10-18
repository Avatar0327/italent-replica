/**
 * BE-14b2 第 1 轮审查返工（P2-1～P2-4）：
 * ① 合同法人 / 试用期月数随待入职保存（OF-R1 映射），改期 / 编辑后仍保留；
 * ② OF-R8 在职实习生开关：开启成功（走实习转正任职记录）、关闭跳过、已离职不受开关限制（rehire 待入职）；
 * ③ 夜间任务限量前先筛出可处理项，并分页扫完（不被前面的不可处理项饿死）；
 * ④ 同步记录 A → 普通改期 B → 取消 B → 改期恢复 C：关联改为 C 并写关联审计。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ESTABLISHMENT_CHECKS,
  registerEmploymentActivationChecks,
} from '../../apps/api/src/modules/employment/activation-checks.js';
import { runOfferSyncSweep } from '../../apps/api/src/modules/offer/sync-scheduler.js';
import { loginEmailOf } from './AC-EMP-support.js';
import { overrideSetting } from './AC-OF-BE14b1-support.js';
import { fullSocial, syncWorld, type SyncWorld } from './AC-OF-BE14b2-support.js';

const testDb = useTestDb();
const rows = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
afterEach(() => registerEmploymentActivationChecks(DEFAULT_ESTABLISHMENT_CHECKS));
const at = (day: string) => ({ clock: () => new Date(`${day}T04:00:00.000Z`) });

async function idOf(response: Response): Promise<string> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

describe('P2-1 合同法人、试用期月数随待入职保存（OF-R1 映射）', () => {
  it('同步后待入职带合同法人与试用期月数；改期、换日期编辑后仍保留；之后 Offer 侧的改动不回写', async () => {
    const w = await syncWorld(testDb().db, 'r2-company');
    const offer = await fullSocial(w);
    const done = await w.accepted(offer);
    const entry = await w.entryOf(done);
    expect(entry).toMatchObject({ contractCompanyId: w.company.id, probationMonths: 3, probation: true });

    const postponed = await idOf(await w.entryAction(entry.id, 'postpone', { effectiveDate: '2026-11-10' }));
    const afterPostpone = (await w.entries()).find((item) => item.id === postponed)!;
    expect(afterPostpone).toMatchObject({ contractCompanyId: w.company.id, probationMonths: 3, probation: true });

    const edited = await w.employment('PATCH', `/pending-entries/${postponed}`, {
      ifMatch: await w.businessRevision(postponed),
      body: { effectiveDate: '2026-11-12', probation: true },
    });
    const editedId = await idOf(edited);
    expect((await w.entries()).find((item) => item.id === editedId)).toMatchObject({
      contractCompanyId: w.company.id,
      probationMonths: 3,
    });

    // 同步是一次性复制：Offer 侧值被改（模拟只改 Offer、不选同步）后，待入职保持原值
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`UPDATE offers SET probation_months = 6, contract_company_id = NULL WHERE id = ${offer.id}`),
    );
    expect((await w.entries()).find((item) => item.id === editedId)).toMatchObject({
      contractCompanyId: w.company.id,
      probationMonths: 3,
    });
  });

  it('没有试用期的 Offer：月数为空；没填合同法人（实习）时合同法人为空', async () => {
    const w = await syncWorld(testDb().db, 'r2-company-none');
    const social = await w.accepted(await w.social({ hasProbation: false }));
    expect(await w.entryOf(social)).toMatchObject({ probation: false, probationMonths: null });
    const intern = await w.accepted(await w.intern());
    expect(await w.entryOf(intern)).toMatchObject({ contractCompanyId: null });
  });
});

describe('P2-2 OF-R8 在职实习生 Offer 同步开关', () => {
  const linkTo = (w: SyncWorld, offerId: string, employeeId: string, ifMatch = 1) =>
    w.request('POST', `/${offerId}/link-employee`, { ifMatch, body: { employeeId } });

  it('开关开启（默认）：关联的在职实习生接受正式 Offer → 同步成功，任职版本链追加“实习转正”，账号绑定不变', async () => {
    const w = await syncWorld(testDb().db, 'r2-intern-on');
    const intern = await w.internEmployee('在职实习生');
    const offer = await w.social({ personalEmail: loginEmailOf(intern.id), source: 'intern_conversion' });
    expect((await linkTo(w, offer.id, intern.id)).status).toBe(200);
    const done = await w.accepted({ id: offer.id, revision: 2 });
    expect(done).toMatchObject({ syncStatus: 'success', syncReason: null, syncTarget: 'intern_regularization' });
    const records = await w.recordsOf(intern.id);
    expect(records.map((record) => record.kind)).toEqual(['hire', 'intern_regularization']);
    expect(records[1]).toMatchObject({ effectiveDate: '2026-11-01', fields: { employType: 'internal' } });
    expect(await w.entries()).toHaveLength(0); // 没有另起待入职人员
    const [bound] = rows<{ n: number }>(
      await withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(
          sql`SELECT count(*)::int AS n FROM permission_user_person_links WHERE employee_id = ${intern.id}::uuid`,
        ),
      ),
    );
    expect(bound!.n).toBe(1);
  });

  it('开关关闭：在职实习生的正式 Offer 不同步（改走实习转正），任职记录不变', async () => {
    const w = await syncWorld(testDb().db, 'r2-intern-off');
    await w.timing({ internConversion: false });
    const intern = await w.internEmployee('在职实习生');
    const offer = await w.social({ personalEmail: loginEmailOf(intern.id) });
    expect((await linkTo(w, offer.id, intern.id)).status).toBe(200);
    const done = await w.accepted({ id: offer.id, revision: 2 });
    expect(done).toMatchObject({ syncStatus: null, hasPendingEntry: false });
    expect((await w.recordsOf(intern.id)).map((record) => record.kind)).toEqual(['hire']);
  });

  it.each([true, false])(
    '已离职实习生不受开关限制（internConversion = %s）：重聘待入职，版本链追加 rehire',
    async (on) => {
      const w = await syncWorld(testDb().db, `r2-intern-left-${on}`);
      await w.timing({ internConversion: on });
      const intern = await w.departedIntern('已离职实习生');
      const offer = await w.social({ personalEmail: loginEmailOf(intern.id) });
      expect((await linkTo(w, offer.id, intern.id)).status).toBe(200);
      const done = await w.accepted({ id: offer.id, revision: 2 });
      expect(done).toMatchObject({ syncStatus: 'success', hasPendingEntry: true, syncTarget: 'pending_entry' });
      expect(await w.entryOf(done)).toMatchObject({
        employeeId: intern.id,
        employeeStatus: 1,
        effectiveDate: '2026-11-01',
      });
      expect((await w.recordsOf(intern.id)).map((record) => record.kind)).toEqual(['hire', 'leave', 'rehire']);
    },
  );
});

describe('P2-3 夜间任务限量前先筛出可处理项并分页扫完', () => {
  it('limit = 1：前面的已发 Offer（接受时才同步）不挡住后面已接受的 Offer', async () => {
    const w = await syncWorld(testDb().db, 'r2-sweep-sent');
    const sent = await w.social({ plannedEntryDate: '2026-10-20' });
    await w.force(sent.id, 'status', 'sent');
    await w.timing({ enabled: false });
    const later = await w.accepted(await w.social({ plannedEntryDate: '2026-11-01' }));
    await w.timing({ enabled: true });
    const run = await runOfferSyncSweep(w.db, { ...at('2026-10-18'), limit: 1 });
    expect(run.synced).toEqual([later.id]);
    expect(await w.read(sent.id)).toMatchObject({ syncStatus: null, hasPendingEntry: false });
  });

  it('limit = 1：前面不可处理的（在职实习生且开关关闭）不挡住后面的，分页扫完', async () => {
    const w = await syncWorld(testDb().db, 'r2-sweep-skip');
    const intern = await w.internEmployee('在职实习生');
    await w.timing({ enabled: false });
    const skipped = await w.social({ plannedEntryDate: '2026-10-20', personalEmail: loginEmailOf(intern.id) });
    expect(
      (await w.request('POST', `/${skipped.id}/link-employee`, { ifMatch: 1, body: { employeeId: intern.id } })).status,
    ).toBe(200);
    await w.accepted({ id: skipped.id, revision: 2 });
    const later = await w.accepted(await w.social({ plannedEntryDate: '2026-11-01' }));
    await w.timing({ enabled: true, internConversion: false });
    const run = await runOfferSyncSweep(w.db, { ...at('2026-10-18'), limit: 1 });
    expect(run.synced).toEqual([later.id]);
    expect(await w.read(skipped.id)).toMatchObject({ syncStatus: null });
  });
});

describe('P2-4 混合改期路径：关联随恢复更新并写审计（F-201①）', () => {
  it('同步 A → 普通改期 B → 取消 B → 改期恢复 C：库里的关联是 C，offer.entry_relink 审计 1 条，revision +1', async () => {
    const w = await syncWorld(testDb().db, 'r2-relink');
    // OF-R9 联动另见 AC-OF-BE14b3-linkage；这里关掉，只验证换 ID 时的关联更新
    await overrideSetting(w, 'offer.linkage', { entryCancelRejects: false, reapprovalAllowed: true });
    const synced = await w.accepted(await w.social());
    const a = synced.pendingEntryBusinessId!;
    const b = await idOf(await w.entryAction(a, 'postpone', { effectiveDate: '2026-11-05' }));
    expect(b).not.toBe(a);
    expect((await w.entryAction(b, 'cancel', {})).status).toBe(200);
    const c = await idOf(await w.entryAction(b, 'postpone', { effectiveDate: '2026-11-15' }));
    const [stored] = rows<{ pending_entry_business_id: string; revision: number }>(
      await withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT pending_entry_business_id, revision FROM offers WHERE id = ${synced.id}`),
      ),
    );
    expect(stored).toMatchObject({ pending_entry_business_id: c, revision: synced.revision + 1 });
    const [audit] = rows<{ n: number }>(
      await withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT count(*)::int AS n FROM audit_events WHERE object_id = ${synced.id}
          AND action = 'offer.entry_relink'`),
      ),
    );
    expect(audit!.n).toBe(1);
    expect(await w.read(synced.id)).toMatchObject({ pendingEntryBusinessId: c });
  });
});
