/** F-128 BE-1：续签默认值（A11）与无固定期限统一口径（A16）。差距表 docs/09_派发/R2-员工异动差距表与拆分.md §2.1。 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { contractWorld, type ContractView } from './AC-CT-support.js';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { allowAll } from './support/tenant-api.js';
import { runContractJobs } from '../../apps/api/src/modules/contracts/scheduler.js';

const testDb = useTestDb();
type World = Awaited<ReturnType<typeof contractWorld>>;
const clock = () => new Date('2026-10-01T01:00:00Z');

async function renew(w: World, source: ContractView, fields: Record<string, unknown> = {}) {
  return w.change(source, 'renew', fields);
}

describe('AC-CT F-128 A11 手工续签默认值', () => {
  it('不传生效日 → 原终止日次日；终止日按原合同期限月数', async () => {
    const w = await contractWorld(testDb().db, 'f128-renew-default');
    const original = await w.create(); // 2025-01-01 ~ 2026-09-30，期限 21 个月
    const response = await renew(w, original);
    expect(response.status, await response.clone().text()).toBe(201);
    expect(await response.json()).toMatchObject({
      effectiveDate: '2026-10-01',
      endDate: '2028-06-30',
      termMonths: 21,
      signingCount: 2,
    });
  });

  it('原合同没有期限月数 → 按原生效日到终止日的整月数', async () => {
    const w = await contractWorld(testDb().db, 'f128-renew-months');
    const original = await w.create({ termMonths: null, endDate: '2026-09-15' }); // 整月数 20
    const response = await renew(w, original);
    expect(response.status, await response.clone().text()).toBe(201);
    expect(await response.json()).toMatchObject({ effectiveDate: '2026-09-16', endDate: '2028-05-15' });
  });

  it('显式传入的生效日 / 终止日一律优先；只传生效日时终止日按期限月数顺延', async () => {
    const w = await contractWorld(testDb().db, 'f128-renew-explicit');
    const original = await w.create();
    const only = await renew(w, original, { effectiveDate: '2026-10-01' });
    expect(only.status, await only.clone().text()).toBe(201);
    expect(await only.json()).toMatchObject({ effectiveDate: '2026-10-01', endDate: '2028-06-30' });
    const w2 = await contractWorld(testDb().db, 'f128-renew-explicit2');
    const second = await w2.create();
    const both = await renew(w2, second, { effectiveDate: '2026-10-01', endDate: '2027-09-30' });
    expect(both.status, await both.clone().text()).toBe(201);
    expect(await both.json()).toMatchObject({ effectiveDate: '2026-10-01', endDate: '2027-09-30' });
  });

  it('原合同无固定期限且未给生效日 / 终止日 → 仍报必填', async () => {
    const w = await contractWorld(testDb().db, 'f128-renew-required');
    const indefinite = await w.create({ termType: 'indefinite', termMonths: null, endDate: null });
    expect((await renew(w, indefinite)).status).toBe(400);
    const fixedWithoutEnd = await renew(w, indefinite, { effectiveDate: '2026-10-01', termType: 'fixed' });
    expect(fixedWithoutEnd.status).toBe(400);
  });
});

/** 三次签订：2023、2024、2025 各一年；前两次都在过去，直接生效。 */
async function thirdSigning(w: World) {
  const first = await w.create({
    effectiveDate: '2023-01-01',
    endDate: '2023-12-31',
    termMonths: 12,
    signingDate: '2022-12-20',
  });
  const secondResponse = await renew(w, first);
  expect(secondResponse.status, await secondResponse.clone().text()).toBe(201);
  const second = (await secondResponse.json()) as ContractView;
  const thirdResponse = await renew(w, second);
  expect(thirdResponse.status, await thirdResponse.clone().text()).toBe(201);
  return (await thirdResponse.json()) as ContractView & { endDate: string | null };
}

describe('AC-CT F-128 A16 无固定期限统一按 indefiniteTypeIds 判定', () => {
  it('手工续签第 3 次：类型未列入 → 仍为固定期限', async () => {
    const w = await contractWorld(testDb().db, 'f128-manual-fixed');
    const third = await thirdSigning(w);
    expect(third).toMatchObject({ signingCount: 3, termType: 'fixed', endDate: '2025-12-31' });
  });

  it('手工续签第 3 次：类型列入 → 无固定期限', async () => {
    const w = await contractWorld(testDb().db, 'f128-manual-indefinite');
    const first = await w.create({
      effectiveDate: '2023-01-01',
      endDate: '2023-12-31',
      termMonths: 12,
      signingDate: '2022-12-20',
    });
    await w.settings({ indefiniteTypeIds: [w.type.id] });
    const second = (await (await renew(w, first)).json()) as ContractView;
    expect(second).toMatchObject({ signingCount: 2, termType: 'fixed' });
    const third = await renew(w, second);
    expect(third.status, await third.clone().text()).toBe(201);
    expect(await third.json()).toMatchObject({ signingCount: 3, termType: 'indefinite', endDate: null });
  });

  async function autoRenew(label: string, indefinite: boolean) {
    const w = await contractWorld(testDb().db, label);
    await installApprovalFallbacks(w.db, w.session.tenant.id, w.session.user.id);
    await w.create({ effectiveDate: '2026-01-01', endDate: '2026-10-02' });
    await w.create({ effectiveDate: '2025-01-01', endDate: '2025-12-31' });
    await w.settings({ autoRenew: true, ...(indefinite ? { indefiniteTypeIds: [w.type.id] } : {}) });
    const created = await w.request('POST', '/rules', {
      ifMatch: 0,
      body: {
        name: '续签',
        priority: 1,
        orgIds: [w.org.id],
        personIds: [],
        details: [{ typeId: w.type.id, months: 12, initiatorId: w.session.user.id, daysBefore: 10, skipTypeIds: [] }],
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    await runContractJobs(w.db, { tenantId: w.session.tenant.id }, { clock, authorize: allowAll });
    return w.list('in_review');
  }

  it('自动续签第 3 次：类型未列入 → 固定期限，按规则月数算终止日', async () => {
    expect(await autoRenew('f128-auto-fixed', false)).toEqual([
      expect.objectContaining({ signingCount: 3, termType: 'fixed', endDate: '2027-10-02' }),
    ]);
  });

  it('自动续签第 3 次：类型列入 → 无固定期限（与手工同一口径）', async () => {
    expect(await autoRenew('f128-auto-indefinite', true)).toEqual([
      expect.objectContaining({ signingCount: 3, termType: 'indefinite', endDate: null }),
    ]);
  });
});
