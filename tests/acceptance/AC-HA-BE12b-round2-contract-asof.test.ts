/**
 * BE-12b 返工第 1 轮（#475 审查 P2-2）：合同到期 / 过期的“已有后续合同”按 asOf 判定，不按当前。
 * 夹具：旧合同 9-30 到期，续签合同 10-01 生效；租户今天 2026-10-06，asOf 显式给出。
 * 续签生效前（asOf ≤ 9-30）续签还没接上：旧合同计入“未来 30 天合同到期”；生效当天及以后（asOf ≥ 10-01）已续上，两个指标都不计。
 * 没有后续合同的对照合同：9-30 当天计入“未来 30 天到期”，10-01 起计入“已过期”。合同列表（当前口径）的视图结果不变。
 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { dayAt } from './AC-EXIT-activation-support.js';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { dashboardClient, type DashboardClient } from './AC-HA-BE12b-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';

async function buildWorld() {
  const x = await downstreamWorld(database().db, 'ha-12b-r2-contract', TODAY);
  const type = await x.contractType('劳动合同');
  const company = (await (
    await x.contracts('POST', '/master-data/companies', { ifMatch: 0, body: { code: randomUUID(), name: '合成法人' } })
  ).json()) as { id: string };
  const create = async (employeeId: string, fields: Record<string, unknown>) => {
    const response = await x.contracts('POST', '/commands', {
      ifMatch: 0,
      body: {
        operation: 'create',
        mode: 'direct',
        employeeId,
        fields: {
          typeId: type,
          companyId: company.id,
          effectiveDate: '2025-10-01',
          endDate: '2026-09-30',
          termType: 'fixed',
          termMonths: 12,
          signingDate: '2025-09-20',
          ...fields,
        },
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  };
  const renewed = (await x.hired('续签员工')).employee;
  const plain = (await x.hired('未续签员工')).employee;
  const old = await create(renewed.id, {});
  await create(renewed.id, { effectiveDate: '2026-10-01', endDate: '2027-09-30', signingDate: '2026-09-20' });
  const noSuccessor = await create(plain.id, {});
  return { x, old, noSuccessor };
}
type World = Awaited<ReturnType<typeof buildWorld>>;

describe('BE-12b 返工 P2-2 合同到期按 asOf 判定后续合同', () => {
  let w: World;
  let board: DashboardClient;
  beforeAll(async () => {
    w = await buildWorld();
    board = dashboardClient(
      database().db,
      { tenant: w.x.session.tenant.id, user: w.x.session.user.id },
      { now: () => dayAt(TODAY) },
    );
  }, 300_000);

  it('续签生效前一天 / 到期当天（asOf = 9-29、9-30）：旧合同还没续上，计入未来 30 天到期，不计已过期', async () => {
    for (const asOf of ['2026-09-29', '2026-09-30']) {
      await board.expectIndicator('contractExpiring30', [w.old.id, w.noSuccessor.id], asOf);
      await board.expectIndicator('contractOverdue', [], asOf);
    }
  });

  it('续签生效当天（asOf = 10-01）及以后：已续上，旧合同不计到期也不计过期；没有后续合同的计入已过期', async () => {
    for (const asOf of ['2026-10-01', TODAY]) {
      await board.expectIndicator('contractExpiring30', [], asOf);
      await board.expectIndicator('contractOverdue', [w.noSuccessor.id], asOf);
    }
  });

  it('合同列表“即将到期 / 过期未续签”仍按当前口径（今天 10-06 起旧合同已续上）', async () => {
    const view = async (name: string, extra = '') => {
      const response = await w.x.contracts('GET', `?view=${name}${extra}`);
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { items: { id: string }[] }).items.map((item) => item.id);
    };
    expect(await view('expired_unrenewed')).toEqual([w.noSuccessor.id]);
  });
});
