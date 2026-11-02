/**
 * AC-OA-36（R2-T08 §7.6A，11b 用真执行器端到端）：审批后涉及集合漂移。扩大 → 该组 SCOPE_CHANGED、移入的 X 不处理不暂停；
 * 更早涉及 X 子树的单不被越序；缩小 → 按 S′ 执行与暂停；设立日期更正先于执行开始 → SCOPE_CHANGED，暂停后更正 → 409。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { E, type ExecWorld, execWorld } from './AC-OA-exec-support.js';
import { rename } from './AC-OA-items-support.js';
import { executionAudits } from './support/org-adjustment-execution.js';

const testDb = useTestDb();
const MOVED_ON = '2026-10-15';

const move = async (w: ExecWorld, orgId: string, parentId: string) => {
  const body = { effectiveDate: MOVED_ON, parents: { admin: { parentId } }, addEmployment: false };
  const res = await w.patchOrg(orgId, body);
  expect(res.status, await res.clone().text()).toBe(200);
};

/** 执行开始审计记下的暂停组织（§7.6A 第 3 步）。 */
const pausedAtStart = async (w: ExecWorld, adjustmentId: string) => {
  const audits = await executionAudits(w.db, w.tenant.id, adjustmentId);
  const started = audits.find((row) => row.action === 'org-adjustment.execution.started');
  return [...(started!.after.pausedOrgIds as string[])].sort();
};

const orgAdjusted = async (w: ExecWorld, employeeId: string) =>
  (await w.records(employeeId)).some((r) => r.kind === 'org_adjustment');

describe('AC-OA-36 涉及集合扩大', () => {
  it('审批后把 X 移到 A 下：A 组 SCOPE_CHANGED、X 员工无记录、X 不暂停；更早改 X 下级的单先执行；其余组照常', async () => {
    const w = await execWorld(testDb().db, 'oa36-wide');
    const big = await w.org('ZZ_扩大A', w.a);
    const x = await w.org('ZZ_移入X', w.b);
    const x1 = await w.org('ZZ_移入X下级', x);
    const ex = await w.staff(x);
    const other = await w.org('ZZ_扩大其他', w.a);
    const earlier = await w.approved([w.b], [rename(x1, { name: 'ZZ_更早单改名' })]);
    const later = await w.approved([w.a], [rename(big, { addEmployment: true }), rename(other)]);
    await move(w, x, big);

    const result = await w.run();

    expect(result.completed).toEqual([earlier.id, later.id]);
    expect([...(await w.outcomes(earlier.id)).values()].map((o) => o.execution_result)).toEqual([1]);
    expect((await w.orgAt(x1))!.name).toBe('ZZ_更早单改名');
    const [widened, kept] = [...(await w.outcomes(later.id)).values()];
    expect(widened).toMatchObject({
      execution_result: 2,
      execution_reason: 'SCOPE_CHANGED',
      executed_version_id: null,
    });
    expect(kept).toMatchObject({ execution_result: 1 });
    expect(await orgAdjusted(w, ex)).toBe(false);
    expect(await pausedAtStart(w, later.id)).toEqual([other]);
    expect(await w.headRow(later.id)).toMatchObject({ success_count: 1, failure_count: 1, pauses: 0 });
  });
});

describe('AC-OA-36 涉及集合缩小', () => {
  it('审批后下级 C 移出：按 S′ 执行，C 员工不追加、暂停只覆盖 S′', async () => {
    const w = await execWorld(testDb().db, 'oa36-shrink');
    const big = await w.org('ZZ_缩小A', w.a);
    const c = await w.org('ZZ_移出C', big);
    const [ea, ec] = [await w.staff(big), await w.staff(c)];
    const adjustment = await w.approved([w.a], [rename(big, { addEmployment: true })]);
    await move(w, c, w.b);

    await w.run();

    const [row] = [...(await w.outcomes(adjustment.id)).values()];
    expect(row).toMatchObject({ execution_result: 1, employment_done: 1, employment_failed: 0 });
    expect(await orgAdjusted(w, ea)).toBe(true);
    expect(await orgAdjusted(w, ec)).toBe(false);
    expect(await pausedAtStart(w, adjustment.id)).toEqual([big]);
  });
});

describe('AC-OA-36 设立日期更正两种先后', () => {
  const correct = async (w: ExecWorld, orgId: string) =>
    w.call('PATCH', `/api/tenant/org/organizations/${orgId}/correction`, {
      ifMatch: await w.orgRevision(orgId),
      body: { establishedOn: E },
    });

  it('更正先于执行开始：X 首版提前到 E，开始时 S′ 含 X → A 组 SCOPE_CHANGED', async () => {
    const w = await execWorld(testDb().db, 'oa36-corr-first');
    const big = await w.org('ZZ_更正A', w.a);
    const adjustment = await w.approved([w.a], [rename(big, { addEmployment: true })]);
    const x = await w.orgOn('ZZ_次日X', big, '2026-11-02');
    const res = await correct(w, x);
    expect(res.status, await res.clone().text()).toBe(200);

    await w.run();

    const [row] = [...(await w.outcomes(adjustment.id)).values()];
    expect(row).toMatchObject({ execution_result: 2, execution_reason: 'SCOPE_CHANGED' });
  });

  it('暂停建立后更正 X → 409，X 首版日期与 revision 不变，A 组照常', async () => {
    const w = await execWorld(testDb().db, 'oa36-corr-late');
    const big = await w.org('ZZ_暂停A', w.a);
    const other = await w.org('ZZ_暂停其他', w.a);
    const adjustment = await w.approved([w.a], [rename(other), rename(big, { name: 'ZZ_暂停A新名' })]);
    const x = await w.orgOn('ZZ_暂停后X', big, '2026-11-02');
    const revision = await w.orgRevision(x);
    const statuses: number[] = [];

    await w.run({
      hooks: {
        afterGroup: async () => {
          if (!statuses.length) statuses.push((await correct(w, x)).status);
        },
      },
    });

    expect(statuses).toEqual([409]);
    expect(await w.orgRevision(x)).toBe(revision);
    expect(await w.orgAt(x)).toBeUndefined();
    expect([...(await w.outcomes(adjustment.id)).values()].map((o) => o.execution_result)).toEqual([1, 1]);
    expect((await w.orgAt(big))!.name).toBe('ZZ_暂停A新名');
  });
});
