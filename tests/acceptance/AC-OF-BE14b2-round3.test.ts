/**
 * BE-14b2 第 2 轮审查返工（P2-1～P2-3）：
 * ① 实习 Offer 不得把在职实习生转成内部员工（IN-R3：实习转正只适用于正式 Offer）；
 * ② 夜间任务在限量之前用 SQL 排除“在职实习生且开关关闭”的不可处理项，大量跳过项不会耗尽每次运行的上限；
 * ③ 待入职列表新增的 contractCompanyId / probationMonths 按任职记录对象的字段查看权投影。
 */
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { runOfferSyncSweep } from '../../apps/api/src/modules/offer/sync-scheduler.js';
import { loginEmailOf } from './AC-EMP-support.js';
import { errorOf, offerRealWorld } from './AC-OF-BE14a-support.js';
import { syncWorld } from './AC-OF-BE14b2-support.js';

const testDb = useTestDb();
const at = (day: string) => ({ clock: () => new Date(`${day}T04:00:00.000Z`) });

describe('P2-1 实习 Offer 不得生成实习转正记录 / 改雇佣类型', () => {
  it('实习 Offer 不能关联在职实习生（400 OFFER_LINK_TYPE_INVALID），关联列保持为空', async () => {
    const w = await syncWorld(testDb().db, 'r3-intern-link');
    const intern = await w.internEmployee('在职实习生');
    const offer = await w.intern({ personalEmail: loginEmailOf(intern.id) });
    const response = await w.request('POST', `/${offer.id}/link-employee`, {
      ifMatch: 1,
      body: { employeeId: intern.id },
    });
    expect(response.status, await response.clone().text()).toBe(400);
    expect((await errorOf(response)).details).toMatchObject({ reason: 'OFFER_LINK_TYPE_INVALID' });
    expect(await w.read(offer.id)).toMatchObject({ linkedEmployeeId: null });
  });

  it('即使关联列被旁路写入：接受后同步失败（OFFER_INTERN_OFFER_CONVERSION），不追加实习转正、雇佣类型仍是实习生', async () => {
    const w = await syncWorld(testDb().db, 'r3-intern-bypass');
    const intern = await w.internEmployee('在职实习生');
    const offer = await w.intern({ personalEmail: loginEmailOf(intern.id) });
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.execute(sql`UPDATE offers SET linked_employee_id = ${intern.id}::uuid WHERE id = ${offer.id}`),
    );
    const done = await w.accepted({ id: offer.id, revision: offer.revision });
    expect(done).toMatchObject({
      status: 'accepted',
      syncStatus: 'failed',
      syncReason: 'OFFER_INTERN_OFFER_CONVERSION',
      hasPendingEntry: false,
    });
    const records = await w.recordsOf(intern.id);
    expect(records.map((record) => record.kind)).toEqual(['hire']);
    expect(records[0]!.fields.employType).toBe('intern');
  });
});

describe('P2-2 夜间任务：大量不可处理项不耗尽上限', () => {
  it('3 条“在职实习生且开关关闭”的早期 Offer + 1 条正常 Offer：上限 2、每页 1 条，仍同步正常项且只扫描 1 条', async () => {
    const w = await syncWorld(testDb().db, 'r3-sweep-cap');
    await w.timing({ enabled: false });
    for (const [index, name] of ['甲', '乙', '丙'].entries()) {
      const intern = await w.internEmployee(`在职实习生${name}`);
      const offer = await w.social({
        plannedEntryDate: `2026-10-2${index}`,
        personalEmail: loginEmailOf(intern.id),
      });
      await w.request('POST', `/${offer.id}/link-employee`, { ifMatch: 1, body: { employeeId: intern.id } });
      await w.accepted({ id: offer.id, revision: 2 });
    }
    const normal = await w.accepted(await w.social({ plannedEntryDate: '2026-11-01' }));
    await w.timing({ enabled: true, internConversion: false });
    const run = await runOfferSyncSweep(w.db, { ...at('2026-10-18'), limit: 1, maxPerTenant: 2 });
    expect(run).toMatchObject({ synced: [normal.id], errors: [], scanned: 1 });
    // 连续运行：没有可处理项，不重复、不报错
    expect(await runOfferSyncSweep(w.db, { ...at('2026-10-19'), limit: 1, maxPerTenant: 2 })).toMatchObject({
      synced: [],
      scanned: 0,
    });
  });
});

describe('P2-3 待入职列表新增字段按查看权投影', () => {
  it('有查看权看得到合同公司 / 试用期月数；任职记录对象上撤掉这两个字段的查看权后不再返回', async () => {
    const w = await syncWorld(testDb().db, 'r3-fields', await offerRealWorld(testDb().db, 'r3-fields'));
    await w.timing({ enabled: false });
    const offer = await w.accepted(await w.social({ hasProbation: true, probationMonths: 3 }));
    expect((await w.synced(offer)).hasPendingEntry).toBe(true);
    const list = async () => {
      const response = await w.realApi('GET', '/api/tenant/employment/pending-entries?view=all');
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { items: Record<string, unknown>[] }).items;
    };
    await w.permitObject(MODULE_OBJECTS.employmentRecord);
    expect((await list())[0]).toMatchObject({ contractCompanyId: w.company.id, probationMonths: 3 });
    await w.permitObject(MODULE_OBJECTS.employmentRecord, ['contractCompanyId', 'probationMonths']);
    const restricted = (await list())[0]!;
    expect(restricted).not.toHaveProperty('contractCompanyId');
    expect(restricted).not.toHaveProperty('probationMonths');
  });
});
