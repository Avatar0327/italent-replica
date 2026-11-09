/**
 * AC-F476-11（P3 部分）：任务很多时（超出展示窗口最新 200 条）内容选择仍按完整任务 / 日志定位，
 * 不因窗口截断把已办人退回现值，也不选到别人的份（设计 §1.2、§4「不用展示窗口的最新 200 条」）。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { flowWorld } from './AC-OA-approval-support.js';
import { rename } from './AC-OA-items-support.js';
import { NAME_A, type Scenario, copiesOf, seenBy } from './AC-F476-support.js';

const testDb = useTestDb();
const FILLERS = 205;

describe('AC-F476-11 超过展示窗口的任务数', () => {
  it('HRBP 的办理任务被挤出最新 200 条之外：已办仍读冻结份（taskId 指向原任务），负责人仍读现值', async () => {
    const w = await flowWorld(testDb().db, 'f476-11p3-window');
    const { id, itemId } = await w.draft(rename(w.a, { name: NAME_A }));
    await w.submitted(id);
    const scenario: Scenario = { id, itemId, instanceId: (await w.instance(id)).id };
    await w.acted(id, w.hrbp, 'approve');
    const before = await w.instance(id);
    const handled = before.tasks.find((t) => t.nodeKey === 'n1')!;
    await withTenant(w.db, w.tenant.id, async (tx) => {
      await tx.execute(sql`INSERT INTO approval_tasks (tenant_id, instance_id, seq, round, node_key, origin, status,
          created_at)
        SELECT i.tenant_id, i.id, (SELECT max(seq) FROM approval_tasks WHERE instance_id = i.id) + g, 1, 'n2',
          'same_skip', 'skipped', now() + (g || ' seconds')::interval
        FROM approval_instances i, generate_series(1, ${FILLERS}) g WHERE i.id = ${scenario.instanceId}`);
    });
    const view = await w.detail(scenario.instanceId, w.hrbp.userId);
    expect(
      view.tasks.some((t) => t.id === handled.id),
      '前提：原任务已在展示窗口之外',
    ).toBe(false);
    const hrbp = (view as unknown as { contentView: { mode: string; taskId: string } }).contentView;
    expect(hrbp).toMatchObject({ mode: 'frozen', taskId: handled.id });
    const seen = await seenBy(w, scenario, w.hrbp.userId);
    expect(seen.orgStatus).toBe(200);
    expect(seen.centerNames).toEqual([NAME_A]);
    expect((await seenBy(w, scenario, w.head.userId)).mode).toBe('live');
    expect((await copiesOf(w, scenario.instanceId)).map((c) => c.actor_user_id)).toEqual([w.hrbp.userId]);
  });
});
