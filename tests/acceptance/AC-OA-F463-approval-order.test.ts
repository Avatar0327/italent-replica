/**
 * F-463（B3b，BE-11b R2 审查转出）：审批通过的产品路径写入 `approved_at`；执行顺序守卫（runner-lease.pickAdjustment，
 * §7.3“相交单按审批先后执行，更早的相交单未到期时本单也等”）靠它排序，缺了它守卫形同虚设。
 * 全程走审批路径（建单 → 提交 → 两节点同意 → 排期），不直接造数。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type ExecWorld, execWorld } from './AC-OA-exec-support.js';
import { rename } from './AC-OA-items-support.js';
import { resultRows } from './AC-ORG-people-support.js';

const testDb = useTestDb();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 同一组织上的两张相交单：先审批的 first、一小时后审批的 second（审批人同意的时刻即 approved_at）。 */
async function intersecting(w: ExecWorld) {
  const x = await w.org('ZZ_相交组织', w.a);
  const first = await w.approved([w.a], [rename(x, { name: 'ZZ_先批改名' })]);
  w.setNow(new Date(w.clock().getTime() + HOUR).toISOString());
  const second = await w.approved([w.a], [rename(x, { name: 'ZZ_后批改名' })]);
  return { x, first: first.id, second: second.id };
}

const approvedAt = (w: ExecWorld, id: string) =>
  withTenant(w.db, w.tenant.id, async (tx) => {
    const [row] = resultRows<{ approved_at: string | null }>(
      await tx.execute(sql`SELECT approved_at::text FROM org_adjustments WHERE id=${id}`),
    );
    return row!.approved_at;
  });

/** 把一张单的排期推迟 days 天（模拟数据量大被排到次日，§7.1）。 */
const postpone = (w: ExecWorld, id: string, days: number) =>
  withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`UPDATE org_adjustment_executions SET run_on_date = run_on_date + ${days}::int
      WHERE adjustment_id=${id}`),
  );

const resultOf = async (w: ExecWorld, id: string) => [...(await w.outcomes(id)).values()][0]!;

describe('F-463 审批通过写入 approved_at', () => {
  it('两节点同意后 approved_at 为同意时刻；后审批的晚于先审批的', async () => {
    const w = await execWorld(testDb().db, 'oaf463-stamp');
    const approvedFirstAt = w.clock().toISOString();
    const { first, second } = await intersecting(w);

    const [a, b] = [await approvedAt(w, first), await approvedAt(w, second)];
    expect(a, '先审批单').not.toBeNull();
    expect(new Date(a!).toISOString()).toBe(approvedFirstAt);
    expect(b, '后审批单').not.toBeNull();
    expect(new Date(b!).getTime() - new Date(a!).getTime()).toBe(HOUR);
  });
});

describe('F-463 相交单执行顺序按审批先后（审批路径回归）', () => {
  it('先审批但后到期：后审批且已到期的相交单也等它，不越过', async () => {
    const w = await execWorld(testDb().db, 'oaf463-wait');
    const { first, second } = await intersecting(w);
    await postpone(w, first, 1);

    const today = await w.run();

    expect(today.completed ?? [], '今天只有后审批单到期，但更早审批的相交单未做完').toEqual([]);
    expect((await resultOf(w, second)).execution_result).toBeNull();
    w.setNow(new Date(w.clock().getTime() + DAY).toISOString());
    for (let tick = 0; tick < 4; tick++) {
      w.advance();
      await w.run();
    }
    // 先审批单先执行并改名成功；后审批单随后执行时基线已变，记失败而不是反过来
    expect((await resultOf(w, first)).execution_result).toBe(1);
    expect(await resultOf(w, second)).toMatchObject({
      execution_result: 2,
      execution_reason: 'ORG_ADJUSTMENT_BASELINE_CHANGED',
    });
  });

  it('后审批但先到期：两张都到期时仍按审批先后，先审批单先执行', async () => {
    const w = await execWorld(testDb().db, 'oaf463-order');
    const { first, second } = await intersecting(w);

    for (let tick = 0; tick < 4; tick++) {
      if (tick) w.advance();
      await w.run();
    }

    expect((await resultOf(w, first)).execution_result).toBe(1);
    expect(await resultOf(w, second)).toMatchObject({ execution_result: 2 });
  });
});
