/** AC-360-06 补强（DEC-408①）：候选先筛范围再分页，锁集合不随租户规模增长。 */
import { eq, sql, survey360People, withTenant } from '@italent/db';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { boundedScene, useBoundedDb } from './AC-360-F088-support.js';
import { fullAccess } from './AC-360-support.js';

const testDb = useBoundedDb();
interface Result {
  added: { appraiserPersonId: string }[];
  skipped: { employeeId: string; reason: string }[];
}

describe('AC-360-06 / F-088 锁计划有界', () => {
  let s: Awaited<ReturnType<typeof boundedScene>>;
  // 只生成一次大租户；各用例使用不同活动 / 对象，避免把重复造数放进 CI 关键路径。
  beforeAll(async () => {
    s = await boundedScene(testDb().db, 'f088bound', 650);
  }, 300_000);
  beforeEach(() => {
    s.access.scope = fullAccess().scope;
    s.observations.length = 0;
  });
  const newObject = async () => {
    const activity = await s.w.activity();
    const object = await s.w.object(activity.id, s.managerPerson.id, [s.q.id]);
    return {
      activity,
      object,
      auto: () =>
        s.w.request('POST', `/activities/${activity.id}/objects/${object.id}/appraisers/auto`, {
          ifMatch: 0,
          body: { roles: ['subordinate'], limits: { subordinate: 1 } },
        }),
    };
  };
  it('650 名下级只添加 1 人：只锁 1 名员工及对应人员，不读取全部候选', async () => {
    const result = await s.w.ok<Result>(s.auto());
    expect(result.added).toHaveLength(1);
    expect(s.locks().flatMap((o) => o.ids)).toEqual([s.id(1)]);
    expect(s.observations.filter((o) => o.query.includes('FOR NO KEY UPDATE')).flatMap((o) => o.ids)).toEqual(
      result.added.map((r) => r.appraiserPersonId),
    );
    expect(s.pages().length).toBe(1);
    expect(s.pages().every((o) => o.ids.length <= 100)).toBe(true);
    expect(s.pages().every((o) => /LIMIT/.test(o.query))).toBe(true);
  }, 120_000);

  it('范围内合法下级排在第 650 名：范围过滤发生在 LIMIT 前，只获取范围内候选', async () => {
    const test = await newObject();
    s.access.scope = {
      ...s.access.scope,
      all: false,
      personIds: [s.manager.id, s.id(650)],
      terms: [{ dimension: 'reporting', orgIds: [], personIds: [s.manager.id, s.id(650)] }],
    };
    s.observations.length = 0;
    const result = await s.w.ok<Result>(test.auto());
    expect(result.added).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    expect(s.pages().flatMap((o) => o.ids)).toEqual([s.id(650)]);
    expect(s.locks().flatMap((o) => o.ids)).toEqual([s.id(650)]);
  }, 120_000);

  it('前 150 人无邮箱，末页才有合法候选：保留全部跳过原因并继续分页，只锁合法候选', async () => {
    const test = await newObject();
    const [first] = await withTenant(testDb().db, s.w.tenantId, (tx) =>
      tx
        .select({ id: survey360People.id })
        .from(survey360People)
        .where(eq(survey360People.employeeId, s.id(1))),
    );
    await s.w.appraiser(test.activity.id, test.object.id, first!.id, 'subordinate');
    await withTenant(testDb().db, s.w.tenantId, (tx) =>
      tx.execute(sql`DELETE FROM survey360_people
        WHERE employee_id BETWEEN ${s.id(2)}::uuid AND ${s.id(151)}::uuid`),
    );
    s.observations.length = 0;
    const result = await s.w.ok<Result>(test.auto());
    expect(result.added).toHaveLength(1);
    expect(result.skipped).toEqual(
      Array.from({ length: 150 }, (_, n) => ({ employeeId: s.id(n + 2), reason: 'NO_EMAIL' })),
    );
    expect(s.pages().length).toBe(2);
    expect(s.pages().every((o) => o.ids.length <= 100)).toBe(true);
    expect(s.locks().flatMap((o) => o.ids)).toEqual([s.id(152)]);
  }, 120_000);
});
