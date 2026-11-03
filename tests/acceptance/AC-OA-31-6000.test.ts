/**
 * AC-OA-31（R2-T08 §7.5，第 2 轮 P2-R2-02）：单个组织 6000 名主职员工改名选“是”→ 排到次日 03:00（租户时区），
 * T1 / T2（每页 500）/ T3 分事务推进；分别在 T1 提交后首页前、第一页后、最后一页后 T3 前杀进程，
 * 接管后组织只有本单一版（executed_version_id 不变）、6000 人各一条无重复，结果、备注、暂停解除都正确。
 * 人数不缩（派单要求），耗时按 DEC-471 记在结果文件。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { ExecutionGroup } from '../../apps/api/src/modules/org-adjustment/execution-groups.js';
import { E, cloneStaff, execWorld } from './AC-OA-exec-support.js';
import { rename } from './AC-OA-items-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { adjustmentState } from './support/org-adjustment-execution.js';

const testDb = useTestDb();
const PEOPLE = 6000;

class Killed extends Error {}

describe('AC-OA-31 6000 人分批与三处崩溃恢复', () => {
  it('次日 03:00 排期；T1 后 / 第一页后 / 最后一页后各杀一次，接管后一版组织、6000 条无重复', async () => {
    const w = await execWorld(testDb().db, 'oa31-6000');
    const x = await w.org('ZZ_六千人部门', w.a);
    const seed = await w.staff(x);
    await cloneStaff(w.db, w.tenant.id, seed, PEOPLE - 1);
    const versionsBefore = await w.versionCount(x);
    const adjustment = await w.approved([w.a], [rename(x, { name: 'ZZ_六千人新名', addEmployment: true })]);
    const itemId = adjustment.itemIds[0]!;

    expect(await adjustmentState(w.db, w.tenant.id, adjustment.id)).toMatchObject({
      data_volume: PEOPLE + 1,
      run_on_date: '2026-10-02',
      run_from_hour: 3,
    });
    w.setNow('2026-10-01T18:59:00.000Z');
    expect((await w.run()).completed, '上海次日 02:59 尚未到点').toEqual([]);
    w.setNow('2026-10-01T19:00:00.000Z');

    const progress = async () => (await w.outcomes(adjustment.id)).get(itemId)!;
    // 杀点按 §7.5 表：T1 提交后（phase 1、0 人）、第一页后（500 人）、最后一页后（6000 人、T3 未写）。
    const kills = [0, 500, PEOPLE];
    const seen: number[] = [];
    const afterStep = async (group: ExecutionGroup) => {
      expect(group.id).toBe(itemId);
      const row = await progress();
      seen.push(row.employment_done);
      if (row.exec_phase === 1 && row.employment_done === kills[0]) {
        kills.shift();
        throw new Killed(`杀进程于 ${row.employment_done} 人`);
      }
    };
    let executedVersion: string | null = null;
    for (let round = 0; round < 3; round += 1) {
      await expect(w.run({ hooks: { afterStep } })).rejects.toBeInstanceOf(Killed);
      const row = await progress();
      expect(row).toMatchObject({ exec_phase: 1, execution_result: null });
      executedVersion ??= row.executed_version_id;
      expect(row.executed_version_id, '接管不重写组织').toBe(executedVersion);
      expect(await w.versionCount(x)).toBe(versionsBefore + 1);
      w.advance();
    }
    expect(kills).toEqual([]);

    const finished = await w.run({ hooks: { afterStep } });

    expect(finished.completed).toEqual([adjustment.id]);
    expect(await progress()).toMatchObject({
      execution_result: 1,
      exec_phase: 2,
      employment_done: PEOPLE,
      employment_failed: 0,
      executed_version_id: executedVersion,
    });
    expect(await w.versionCount(x)).toBe(versionsBefore + 1);
    expect((await w.orgAt(x))!).toMatchObject({ name: 'ZZ_六千人新名', version_id: executedVersion });
    const [counts] = await withTenant(w.db, w.tenant.id, async (tx) =>
      resultRows<{ total: number; people: number }>(
        await tx.execute(sql`SELECT count(*)::int AS total, count(DISTINCT employee_id)::int AS people
          FROM employment_records WHERE kind='org_adjustment' AND change_type='org_adjustment' AND start_date=${E}`),
      ),
    );
    expect(counts).toEqual({ total: PEOPLE, people: PEOPLE });
    expect(seen.filter((done) => done > 0 && done % 500 === 0).length).toBeGreaterThanOrEqual(PEOPLE / 500);
    expect(await w.headRow(adjustment.id)).toMatchObject({
      execution_status: 2,
      success_count: 1,
      failure_count: 0,
      execution_note: '成功执行1个调整，失败0个调整',
      pauses: 0,
    });
  }, 1_800_000);
});
