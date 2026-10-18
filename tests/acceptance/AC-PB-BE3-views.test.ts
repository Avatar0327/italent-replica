/**
 * BE-3 试用期管理四个视图（docs/02_业务建模/29 PB-R1；差距表 B1 / B3 / B4 / B5，R2f B5 已转正）：
 * 即将试用到期（默认今天～30 天内到期、未发起转正申请）、转正审批中、全部试用员工、已转正。
 * “考核中”（B2）归 BE-15。今天 = 租户本地 2026-10-01。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  draftRegularization,
  hire,
  pbWorld,
  probationView,
  regularizeOk,
  transition,
  type PbWorld,
} from './AC-PB-support.js';

const testDb = useTestDb();

/** 六个人：两人 30 天内到期（其一已发起申请）、一人 31 天后到期、一人已转正、一人无试用期、一人已过期。 */
async function seed(w: PbWorld) {
  const soon = await hire(w, { date: '2026-08-01', months: 3, name: '十月底到期' }); // 10-31
  const applied = await hire(w, { date: '2026-08-15', months: 2, name: '已发起申请' }); // 10-14
  const later = await hire(w, { date: '2026-09-01', months: 3, name: '十一月底到期' }); // 11-30
  const done = await hire(w, { date: '2026-07-01', months: 3, name: '已转正' }); // 09-30
  await hire(w, { probation: false, name: '无试用期' });
  const overdue = await hire(w, { date: '2026-06-01', months: 3, name: '已过期仍试用' }); // 08-31
  const application = await draftRegularization(w, applied.employee.id, '2026-10-15');
  expect((await transition(w, application, 'submit')).status).toBe(200);
  await regularizeOk(w, { mode: 'direct', effectiveDate: '2026-09-25' }, [done.employee.id]);
  return { soon, applied, later, done, overdue, application };
}

const names = (items: readonly Record<string, unknown>[]) => items.map((item) => item.name as string).sort();

describe('试用期管理视图（PB-R1）', () => {
  it('四个视图分流', async () => {
    const w = await pbWorld(testDb().db, 'pb-views');
    await seed(w);
    expect(names(await probationView(w, 'expiring'))).toEqual(['十月底到期']);
    expect(names(await probationView(w, 'in_review'))).toEqual(['已发起申请']);
    expect(names(await probationView(w, 'all'))).toEqual(
      ['十月底到期', '已发起申请', '十一月底到期', '已过期仍试用'].sort(),
    );
    expect(names(await probationView(w, 'regularized'))).toEqual(['已转正']);
  });

  it('行内容：试用起止、月数、转正日期与审批状态、员工 revision（调整试用期的 If-Match）', async () => {
    const w = await pbWorld(testDb().db, 'pb-views-shape');
    const s = await seed(w);
    const [soon] = await probationView(w, 'expiring');
    expect(soon).toMatchObject({
      employeeId: s.soon.employee.id,
      code: s.soon.employee.code,
      departmentId: w.org.id,
      startDate: '2026-08-01',
      months: 3,
      expectedEndDate: '2026-10-31',
      employeeStatus: 2,
      revision: (await w.session.getEmployee(s.soon.employee.id)).revision,
    });
    const [reviewing] = await probationView(w, 'in_review');
    expect(reviewing).toMatchObject({ regularizationBusinessId: s.application.id, regularizationState: 'in_review' });
    const [done] = await probationView(w, 'regularized');
    expect(done).toMatchObject({
      startDate: '2026-07-01',
      regularizationDate: '2026-09-25',
      regularizationState: 'effective',
      regularizationMode: 'direct',
    });
  });

  it('即将到期可改到期范围；筛选人员 / 部门 / 职务 / 预计结束日期', async () => {
    const w = await pbWorld(testDb().db, 'pb-views-filter');
    const s = await seed(w);
    expect(names(await probationView(w, 'expiring', '&expectedEndTo=2026-11-30'))).toEqual(
      ['十月底到期', '十一月底到期'].sort(),
    );
    expect(names(await probationView(w, 'all', '&expectedEndFrom=2026-10-01&expectedEndTo=2026-10-31'))).toEqual(
      ['十月底到期', '已发起申请'].sort(),
    );
    expect(names(await probationView(w, 'all', `&employeeId=${s.later.employee.id}`))).toEqual(['十一月底到期']);
    expect(names(await probationView(w, 'all', `&keyword=${encodeURIComponent('过期')}`))).toEqual(['已过期仍试用']);
    const other = await w.session.org('另一部门', { establishedOn: '2026-01-01' });
    expect(await probationView(w, 'all', `&departmentId=${other.id}`)).toEqual([]);
    expect(await probationView(w, 'regularized', `&postId=${other.id}`)).toEqual([]);
  });

  it('转正生效后离开“全部试用员工”；未到生效日的转正申请通过后仍在试用中、同时出现在已转正', async () => {
    const w = await pbWorld(testDb().db, 'pb-views-approved');
    const s = await seed(w);
    expect((await transition(w, s.application, 'approve')).status).toBe(200);
    expect(names(await probationView(w, 'in_review'))).toEqual([]);
    expect(names(await probationView(w, 'regularized'))).toEqual(['已发起申请', '已转正']);
    expect(names(await probationView(w, 'all'))).toContain('已发起申请');
    w.session.setNow('2026-10-15T01:00:00.000Z');
    expect((await transition(w, s.application, 'activate', '2026-10-15T01:00:00Z')).status).toBe(200);
    expect(names(await probationView(w, 'all'))).not.toContain('已发起申请');
  });

  it.each(['', '?view=', '?view=unknown', '?view=all&expectedEndFrom=2026-13-01', '?view=all&departmentId=x'])(
    '参数不合法：%s → 400',
    async (query) => {
      const w = await pbWorld(testDb().db, `pb-views-bad-${query.length}`);
      const response = await w.session.request('GET', `/probation-views${query}`);
      expect(response.status).toBe(400);
    },
  );
});
