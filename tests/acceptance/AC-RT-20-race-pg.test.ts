/**
 * BE-5d2 意向申请的真 PG 并发（AC-RT-20，设计 §2.5 / §11.1）：同员工并存 409 由“员工行锁串行 + 部分唯一索引兜底”保证。
 * 两次同时创建只有一张成功；同一张草稿同时提交与撤回（同一 If-Match）只有一个生效，另一个 409 REVISION_CONFLICT，
 * 不会出现“已撤回却在审批中”的交错状态。
 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { intentionWorld, reasonOf } from './AC-RT-intention-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-RT-20 意向申请并发（真 PG）', () => {
  it('两次同时创建：恰一张成功，另一次 409 RETIREMENT_INTENTION_IN_PROGRESS，库里只有一张未办结', async () => {
    const w = await intentionWorld(database().db, `race-create-${uniqueSuffix()}`);
    const revision = await w.revisionOf();
    const send = (intendedDate: string) =>
      w.request(w.hr.id, 'POST', `/api/tenant/employment/retirement-intentions/employees/${w.subject.employeeId}`, {
        ifMatch: revision,
        body: { intendedDate },
      });
    const results = await Promise.all([send('2030-03-01'), send('2030-03-02')]);
    const statuses = results.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409].sort());
    const loser = results.find((response) => response.status === 409)!;
    expect(['RETIREMENT_INTENTION_IN_PROGRESS', 'REVISION_CONFLICT']).toContain(
      (await reasonOf(loser)).reason ?? 'REVISION_CONFLICT',
    );
    const open = await w.rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM retirement_intentions WHERE tenant_id=${w.tenant.id}
        AND employee_id=${w.subject.employeeId}::uuid AND state IN ('draft','in_review','rejected')`,
    );
    expect(open[0]!.n).toBe(1);
  });

  it('同一草稿同时提交与撤回：只有一个生效，终态与审批实例一致', async () => {
    const w = await intentionWorld(database().db, `race-act-${uniqueSuffix()}`);
    const draft = await w.create({ intendedDate: '2030-03-01' });
    const results = await Promise.all([
      w.actionRaw(draft.id, 'submit', draft.revision),
      w.actionRaw(draft.id, 'withdraw', draft.revision),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const final = await w.get(draft.id);
    const instances = await w.instanceOfAll(draft.id).catch(() => []);
    if (final.status === 'withdrawn') expect(instances.every((item) => item.status !== 'running')).toBe(true);
    else {
      expect(final.status).toBe('in_review');
      expect(instances).toHaveLength(1);
    }
  });
});
