/**
 * AC-OA-38（执行侧，DEC-644 A-8，R2-T08 §3 / §7.1 / §7.6 / §7.8）：暂存行（含其连带行）不执行、不进数据量与暂停，
 * 执行结果为空、不计入 N / M；详情标“暂存（未执行）”，其余行照常执行。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { execWorld } from './AC-OA-exec-support.js';
import { BASE } from './AC-OA-head-support.js';
import { rename, stop } from './AC-OA-items-support.js';
import { executionAudits } from './support/org-adjustment-execution.js';

const testDb = useTestDb();

describe('AC-OA-38 暂存行执行侧', () => {
  it('暂存停用整支不执行、结果为空、不暂停不计数；非暂存改名照常；详情标暂存（未执行）', async () => {
    const w = await execWorld(testDb().db, 'oa38-exec');
    const parked = await w.org('ZZ_暂存停用', w.a);
    const child = await w.org('ZZ_暂存下级', parked);
    const live = await w.org('ZZ_照常改名', w.a);
    const adjustment = await w.approved([w.a], [stop(parked, { isStaged: true }), rename(live, { name: 'ZZ_已改名' })]);
    expect(adjustment.rows).toHaveLength(3);
    expect((await w.headRow(adjustment.id)).data_volume).toBe(1);

    await w.run();

    const rows = [...(await w.outcomes(adjustment.id)).values()];
    expect(rows.map((r) => [r.is_staged, r.execution_result, r.exec_phase])).toEqual([
      [true, null, 0],
      [true, null, 0],
      [false, 1, 2],
    ]);
    for (const orgId of [parked, child]) expect((await w.orgAt(orgId))!.enabled).toBe(true);
    expect((await w.orgAt(live))!.name).toBe('ZZ_已改名');
    expect(await w.headRow(adjustment.id)).toMatchObject({
      execution_status: 2,
      success_count: 1,
      failure_count: 0,
      execution_note: '成功执行1个调整，失败0个调整',
    });
    const started = (await executionAudits(w.db, w.tenant.id, adjustment.id)).find((r) => r.action.endsWith('started'));
    expect(started!.after.pausedOrgIds).toEqual([live]);

    const res = await w.call('GET', `${BASE}/${adjustment.id}/items/org`);
    expect(res.status, await res.clone().text()).toBe(200);
    const items = ((await res.json()) as { items: Record<string, unknown>[] }).items;
    expect(items.map((i) => [i.stagedLabel, i.executionResult])).toEqual([
      ['暂存（未执行）', null],
      ['暂存（未执行）', null],
      [null, 1],
    ]);
  });
});
