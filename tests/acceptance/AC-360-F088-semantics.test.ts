/** AC-360-06 / DEC-408①：分页预判保持顺序、查重、人数上限与原子性。 */
import { sql, withTenant } from '@italent/db';
import { afterEach, describe, expect, it } from 'vitest';
import { syncProbe } from '../../apps/api/src/modules/survey360/sync.js';
import { boundedScene, useBoundedDb } from './AC-360-F088-support.js';
import { withRelease } from './support/pg-interleave.js';

const testDb = useBoundedDb();
afterEach(() => {
  syncProbe.beforeLock = undefined;
});
interface Result {
  added: { appraiserPersonId: string }[];
  skipped: { employeeId: string; reason: string }[];
}

describe('AC-360-06 / F-088 保持静态语义', () => {
  it('同一命令中新建人员占用邮箱：第二人跳过，继续找到第三人以凑够 2 名', async () => {
    const s = await boundedScene(testDb().db, 'f088email', 3);
    await withTenant(testDb().db, s.w.tenantId, async (tx) => {
      await tx.execute(sql`DELETE FROM survey360_people
        WHERE employee_id BETWEEN ${s.id(1)}::uuid AND ${s.id(3)}::uuid`);
      await tx.execute(sql`INSERT INTO personnel_employee_versions
        (tenant_id,employee_id,revision,command_id,created_by,name,email)
        SELECT ${s.w.tenantId}::uuid,e.id,1,'合成初始版本',${s.w.admin}::uuid,e.name,
          CASE WHEN e.id = ${s.id(3)}::uuid THEN 'third@example.com' ELSE 'same@example.com' END
        FROM employment_employees e WHERE e.id BETWEEN ${s.id(1)}::uuid AND ${s.id(3)}::uuid`);
    });
    const result = await s.w.ok<Result>(s.auto({ roles: ['subordinate'], limits: { subordinate: 2 } }));
    expect(result.added).toHaveLength(2);
    expect(result.skipped).toEqual([{ employeeId: s.id(2), reason: 'SYNC_CONFLICT' }]);
    expect(s.locks().flatMap((o) => o.ids)).toEqual([s.id(1), s.id(3)]);
  }, 120_000);

  it('重复角色按各次限额继续选人，已有关系不占名额，员工只锁一次且按 UUID 排序', async () => {
    const s = await boundedScene(testDb().db, 'f088duplicate', 5);
    await s.w.appraiser(s.activity.id, s.object.id, s.seedPerson.id, 'subordinate');
    s.observations.length = 0;
    const result = await s.w.ok<Result>(s.auto({ roles: ['subordinate', 'subordinate'], limits: { subordinate: 1 } }));
    expect(result.added).toHaveLength(2);
    expect(s.locks()).toHaveLength(1);
    expect(s.locks()[0]!.ids).toEqual([s.id(1), s.id(2)]);
  }, 120_000);

  it('已有 500 个评价者再添加：仍返回 400 TOO_MANY_APPRAISERS，整条回滚，只锁一个超限候选', async () => {
    const s = await boundedScene(testDb().db, 'f088overflow', 1);
    await withTenant(testDb().db, s.w.tenantId, async (tx) => {
      await tx.execute(sql`INSERT INTO survey360_people(tenant_id,name,email,source,created_by)
        SELECT ${s.w.tenantId}::uuid,'已有评价者'||g,'existing-'||g||'@example.com','manual',${s.w.admin}::uuid
        FROM generate_series(1,500) g`);
      await tx.execute(sql`INSERT INTO survey360_relations
        (tenant_id,activity_id,object_id,appraiser_person_id,role_id,source)
        SELECT ${s.w.tenantId}::uuid,${s.activity.id}::uuid,${s.object.id}::uuid,p.id,
          ${s.w.role('subordinate')}::uuid,'manual' FROM survey360_people p
        WHERE p.tenant_id = ${s.w.tenantId}::uuid AND p.email LIKE 'existing-%@example.com'`);
    });
    const before = await s.w.ok(s.w.request('GET', `/activities/${s.activity.id}/objects/${s.object.id}/appraisers`));
    s.observations.length = 0;
    const response = await s.auto({ roles: ['subordinate'] });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('TOO_MANY_APPRAISERS');
    expect(s.locks().flatMap((o) => o.ids)).toEqual([s.id(1)]);
    expect(await s.w.ok(s.w.request('GET', `/activities/${s.activity.id}/objects/${s.object.id}/appraisers`))).toEqual(
      before,
    );
  }, 120_000);

  it('人数为 0 的角色不查询候选，也不取员工锁', async () => {
    const s = await boundedScene(testDb().db, 'f088zero', 5);
    expect(await s.w.ok<Result>(s.auto({ roles: ['subordinate'], limits: { subordinate: 0 } }))).toEqual({
      added: [],
      skipped: [],
    });
    expect(s.pages()).toEqual([]);
    expect(s.locks()).toEqual([]);
  }, 120_000);

  it('预判跳过的无邮箱员工在取锁前被移出范围：不返回其 ID 或旧跳过原因', async () => {
    const s = await boundedScene(testDb().db, 'f088skipScope', 1);
    await withTenant(testDb().db, s.w.tenantId, (tx) =>
      tx.execute(sql`DELETE FROM survey360_people WHERE employee_id = ${s.id(1)}::uuid`),
    );
    syncProbe.beforeLock = async () => {
      s.access.scope = {
        ...s.access.scope,
        all: false,
        personIds: [s.manager.id],
        terms: [{ dimension: 'reporting', orgIds: [], personIds: [s.manager.id] }],
      };
    };
    expect(await s.w.ok<Result>(s.auto())).toEqual({ added: [], skipped: [] });
  }, 120_000);
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('AC-360-06 / F-088 真 PostgreSQL 并发', () => {
  it('未入选下级被另一连接写锁占用：自动添加 1 名不等其锁', async () => {
    const s = await boundedScene(testDb().db, 'f088unselected', 5);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const held = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const holder = withTenant(testDb().db, s.w.tenantId, async (tx) => {
      await tx.execute(sql`SELECT id FROM employment_employees WHERE id = ${s.id(2)}::uuid FOR UPDATE`);
      ready();
      await gate;
    });
    await held;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await withRelease(
      () => {
        clearTimeout(timer);
        release();
      },
      async (cleanup) => {
        cleanup.track(holder);
        const response = await Promise.race([
          cleanup.track(s.auto()),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('等待未入选员工锁')), 30_000);
          }),
        ]);
        expect(response.status).toBe(200);
        expect(((await response.json()) as Result).added).toHaveLength(1);
      },
      [holder],
    );
  }, 120_000);

  it('计划完成后撤空员工范围：取锁后跳过，回执不泄露员工，不中途补锁', async () => {
    const s = await boundedScene(testDb().db, 'f088recheck', 5);
    syncProbe.beforeLock = async () => {
      s.access.scope = {
        ...s.access.scope,
        all: false,
        personIds: [s.manager.id],
        terms: [{ dimension: 'reporting', orgIds: [], personIds: [s.manager.id] }],
      };
    };
    expect(await s.w.ok<Result>(s.auto())).toEqual({ added: [], skipped: [] });
    expect(s.locks()).toHaveLength(1);
    expect(s.locks()[0]!.ids).toEqual([s.id(1)]);
  }, 120_000);
});
