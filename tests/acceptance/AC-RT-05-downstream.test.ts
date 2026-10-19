/**
 * R2-T04 BE-5a 第 1 轮返工 P2-1：退休生效与离职一样触发“人退出”下游（评审组退组、职位继任结束），
 * 终止业务的判定只有一份（domain isTerminatingRecord）。两条回归都从真实退休入口 POST retirements/employees/:id 走到底。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exitWorld as reviewExitWorld } from './AC-EV-F092-support.js';
import { exitWorld as successionExitWorld } from './AC-SC-02-support.js';

const database = useTestDb();
const EMP = '/api/tenant/employment';

describe('AC-RT-05 P2-1 退休生效触发评审组退组', () => {
  it('退休生效日当天：退出全部评审组（启用 / 停用都退），保留其他成员并写审计；未到期不退', async () => {
    const w = await reviewExitWorld(database().db);
    const retiring = await w.hire('退休组长', w.orgA);
    const kept = await w.hire('留任评委', w.orgB);
    const waiting = await w.hire('未到期退休评委', w.orgA);
    const groups = [await w.createGroup([retiring, kept, waiting]), await w.createGroup([retiring], false, w.orgB)];
    const retire = async (person: { id: string }, lastWorkDate: string) => {
      const { revision } = await w.employee(person.id);
      return w.request('POST', `${EMP}/retirements/employees/${person.id}`, {
        ifMatch: revision,
        body: { mode: 'direct', lastWorkDate },
      });
    };
    // 上海 10-11 零点：L = 10-10 → E = 今天，保存当场生效；L = 10-11 → E 在明天，停在 approved
    const done = await retire(retiring, '2026-10-10');
    expect(done.status, await done.clone().text()).toBe(201);
    expect(((await done.json()) as { status: string }).status).toBe('effective');
    const pending = await retire(waiting, '2026-10-11');
    expect(((await pending.json()) as { status: string }).status).toBe('approved');

    await w.expectMembers(groups[0]!.id, [kept, waiting]);
    await w.expectMembers(groups[1]!.id, []);
    expect(await w.audits(groups[0]!.id)).toHaveLength(1);
    expect((await w.audits(groups[0]!.id))[0]!.before.members[0]).toMatchObject({
      employeeId: retiring.id,
      isLeader: true,
    });
    expect((await w.candidates()).items.map((p) => p.id)).not.toContain(retiring.id);
  });
});

describe('AC-RT-05 P2-1 退休生效触发职位继任按退休日结束', () => {
  it('职位继任：结束日期 = 退休生效日，结束来源 exit，原因“退休”，指向退休记录', async () => {
    const x = await successionExitWorld(database().db, 'rt-succession');
    const employee = await x.hire();
    const id = await x.seedRecord(employee.id, 'position');
    x.setNow('2026-10-02T01:00:00Z');
    const { revision } = (await (await x.requestEmployment('GET', `/employees/${employee.id}`)).json()) as {
      revision: number;
    };
    const response = await x.requestEmployment('POST', `/retirements/employees/${employee.id}`, {
      ifMatch: revision,
      body: { mode: 'direct', lastWorkDate: '2026-10-01' },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const retirement = (await response.json()) as { id: string; effectiveDate: string };
    expect(retirement.effectiveDate).toBe('2026-10-02');
    expect(await x.read(id)).toMatchObject({
      end_date: '2026-10-02',
      end_source: 'exit',
      end_reason: '退休',
      exit_record_id: retirement.id,
      revision: 2,
    });
  });
});
