/**
 * BE-7 PT-6 继任风险计算的兼职现任端口（docs/08_设计/R2-T05_兼职设计.md §6，PB-52；R3-T05 `succession.part_time_in_risk_calc`，
 * 原站 CalculateIsIncludePartTimePerson，本租户 = 否）。端口 riskPartTimeIncumbents：asOf 当日进行中、position_id = 该职位的
 * 兼职员工；开关关时不调用（risk-people.ts 既有），所以默认关 → 上线后结果与 main 相同。
 */
import { createTestDb } from '@italent/testkit';
import { sql, withTenant, type DbHandle } from '@italent/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { riskPeople } from '../../apps/api/src/modules/succession/risk-people.js';
import { SUCCESSION_PORTS } from '../../apps/api/src/modules/succession/ports.js';
import { insertPartTimeRecord } from './AC-PT-support.js';
import { riskWorld } from './AC-SC-risk-support.js';
import { SC_TODAY } from './AC-SC-support.js';

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
}, 300000);
afterAll(async () => handle?.close());

describe('PB-52 继任端口 riskPartTimeIncumbents', () => {
  it('SUCCESSION_PORTS 里装配了兼职现任端口（常量引用，随 installSuccessionPorts 生效，不依赖 createApp 次数）', () => {
    expect(SUCCESSION_PORTS.riskPartTimeIncumbents).toBeTypeOf('function');
  });

  it('开关开：asOf 当日进行中且职位 = 该职位的兼职员工计入现任（去重，不含未开始 / 已结束 / 其他职位）；关：与 main 相同', async () => {
    const w = await riskWorld(handle.db);
    const other = await w.newPosition(w.org.id, '其他职位');
    const incumbent = await w.hire('主职现任', { departmentId: w.org.id, positionId: w.position.id });
    const hire = (name: string) => w.hire(name, { departmentId: w.org.id });
    const [ongoing, openEnd, future, ended, elsewhere] = [
      await hire('兼职进行中'),
      await hire('兼职无结束日'),
      await hire('兼职未开始'),
      await hire('兼职已结束'),
      await hire('兼职其他职位'),
    ];
    const seed = (employeeId: string, positionId: string, startDate: string, endDate: string | null) =>
      withTenant(handle.db, w.tenant.id, (tx) =>
        insertPartTimeRecord(tx, {
          tenantId: w.tenant.id,
          employeeId,
          departmentId: w.org.id,
          positionId,
          startDate,
          endDate,
        }),
      );
    await seed(ongoing.id, w.position.id, SC_TODAY, SC_TODAY);
    await seed(openEnd.id, w.position.id, SC_TODAY, null);
    // 主职现任同时兼职同一职位：只算一次
    await seed(incumbent.id, w.position.id, SC_TODAY, null);
    await seed(future.id, w.position.id, '2026-10-02', null);
    // 已结束：联动写出的空区间（开始日 − 1），人工入口写不出
    const endedRecord = await seed(ended.id, w.position.id, SC_TODAY, null);
    await w.asTenant((tx) =>
      tx.execute(sql`INSERT INTO employment_part_time_terms(tenant_id, employee_id, record_id, term_no, end_date, source,
        command_id) VALUES (${w.tenant.id}, ${ended.id}, ${endedRecord}, 2, '2026-09-30', 'exit', 'pt-succession-ended')`),
    );
    await seed(elsewhere.id, other.id, SC_TODAY, null);

    const run = (partTime: boolean) =>
      w.asTenant((tx) =>
        riskPeople(
          tx,
          {
            tenantId: w.tenant.id,
            userId: w.user.id,
            positionId: w.position.id,
            asOf: SC_TODAY,
            today: SC_TODAY,
            partTime,
          },
          [],
        ),
      );
    const ids = async (partTime: boolean) => (await run(partTime)).incumbents.map((person) => person.id).sort();
    expect(await ids(false)).toEqual([incumbent.id]);
    expect(await ids(true)).toEqual([ongoing.id, openEnd.id, incumbent.id].sort());
  });
});
