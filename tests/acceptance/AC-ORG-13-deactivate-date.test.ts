/**
 * AC-ORG-13（F-213，R2f3 §2.2）：停用日期必须晚于组织设立日期（首版生效日，DEC-130），整支级联时同样按各下级自己的设立日判断。
 * 拒绝一律 400 VALIDATION_FAILED、文案照原站，且整单无任何写入（版本、revision、审计、下级级联都不变）。
 * 本文件在 PGlite 与真 PostgreSQL（TEST_DATABASE_URL）下跑同一组用例。
 */
import { type Db, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { orgPeopleWorld } from './AC-ORG-people-support.js';
import { resultRows } from './AC-ORG-support.js';

const testDb = useTestDb();

type World = Awaited<ReturnType<typeof orgPeopleWorld>>;

const rejection = (name: string, stopOn: string, establishedOn: string) =>
  `组织【${name}】的停用日期（${stopOn}）不能早于等于该组织的设立日期（${establishedOn}）`;

/** 与写入有关的全部可观察状态：版本条数、对象 revision、审计动作。 */
async function stateOf(world: World, orgIds: readonly string[]) {
  const db = testDb().db;
  return withTenant(db, world.tenant.id, async (tx) => {
    const out: Record<string, unknown> = {};
    for (const id of orgIds) {
      const versions = resultRows<{ count: number }>(
        await tx.execute(sql`SELECT count(*)::int AS count FROM org_versions WHERE org_id = ${id}`),
      );
      const objects = resultRows<{ revision: number }>(
        await tx.execute(sql`SELECT revision FROM org_objects WHERE id = ${id}`),
      );
      out[id] = {
        versions: versions[0]?.count,
        revision: objects[0]?.revision,
        audit: resultRows<{ action: string }>(
          await tx.execute(sql`SELECT action FROM audit_events WHERE object_id = ${id} ORDER BY occurred_at, id`),
        ).map((row) => row.action),
      };
    }
    return out;
  });
}

const PROBED_TABLES = ['org_objects', 'org_versions', 'org_hierarchy_links', 'org_code_reservations'] as const;

/**
 * 写探针：在组织写入相关表上装“任何 INSERT / UPDATE / DELETE 都报错”的触发器。非法请求若在校验前执行了
 * revision 更新、版本追加或编码占用，会在写入当下报错（响应不再是 400），不靠事务回滚后的状态掩盖。
 * 夹具数据须在装探针之前建好。
 */
async function withWriteProbe<T>(db: Db, run: () => Promise<T>): Promise<T> {
  await db.execute(sql`CREATE OR REPLACE FUNCTION f213_write_probe() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'F213 写探针：校验前发生了写入 %.%', TG_TABLE_NAME, TG_OP; END $$`);
  for (const table of PROBED_TABLES) {
    await db.execute(
      sql.raw(`CREATE TRIGGER f213_write_probe BEFORE INSERT OR UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION f213_write_probe()`),
    );
  }
  try {
    return await run();
  } finally {
    for (const table of PROBED_TABLES) await db.execute(sql.raw(`DROP TRIGGER IF EXISTS f213_write_probe ON ${table}`));
    await db.execute(sql`DROP FUNCTION IF EXISTS f213_write_probe()`);
  }
}

async function expectRejected(response: Response, message: string) {
  expect(response.status, await response.clone().text()).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED', message } });
}

describe('AC-ORG-13 F-213 停用日期不得早于或等于设立日期', () => {
  it('停用日 = 设立日：400，文案照原站，组织与审计都不变；设立日改为前一天后同日停用成功', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org13f213eq');
    const a = await world.org('当天设立部门', undefined, { establishedOn: '2026-10-16' });
    const before = await stateOf(world, [a.id]);
    await expectRejected(
      await world.patchOrg(a, { enabled: false, effectiveDate: '2026-10-16' }),
      rejection('当天设立部门', '2026-10-16', '2026-10-16'),
    );
    expect(await stateOf(world, [a.id])).toEqual(before);
    expect((await world.orgsAt('2026-10-16')).get(a.id)).toMatchObject({ enabled: true, revision: 1 });
    const fixed = await world.call('PATCH', `org/organizations/${a.id}/correction`, {
      ifMatch: a.revision,
      body: { establishedOn: '2026-10-15' },
    });
    expect(fixed.status, await fixed.clone().text()).toBe(200);
    const latest = ((await fixed.json()) as { revision: number }).revision;
    const stopped = await world.patchOrg(
      { id: a.id, revision: latest },
      { enabled: false, effectiveDate: '2026-10-16' },
    );
    expect(stopped.status, await stopped.clone().text()).toBe(200);
    expect((await world.orgsAt('2026-10-16')).get(a.id)).toMatchObject({ enabled: false });
  });

  it('停用日 < 设立日：同一文案、同一错误码，无任何写入', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org13f213lt');
    const a = await world.org('未来设立部门', undefined, { establishedOn: '2026-10-20' });
    const before = await stateOf(world, [a.id]);
    await expectRejected(
      await world.patchOrg(a, { enabled: false, effectiveDate: '2026-10-18' }),
      rejection('未来设立部门', '2026-10-18', '2026-10-20'),
    );
    expect(await stateOf(world, [a.id])).toEqual(before);
  });

  it('停用日 = 设立日 + 1 天照常成功', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org13f213ok');
    const a = await world.org('次日停用部门', undefined, { establishedOn: '2026-10-16' });
    const response = await world.patchOrg(a, { enabled: false, effectiveDate: '2026-10-17' });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: false, revision: 2 });
    expect((await world.orgsAt('2026-10-16')).get(a.id)).toMatchObject({ enabled: true });
    expect((await world.orgsAt('2026-10-17')).get(a.id)).toMatchObject({ enabled: false, startDate: '2026-10-17' });
  });

  it('级联：任一下级的设立日 ≥ 停用日即整单拒绝，文案写该下级名称，上级与各下级都不变', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org13f213cascade');
    const a = await world.org('级联上级F213', undefined, { establishedOn: '2026-10-01' });
    const early = await world.org('较早设立下级', a.id, { establishedOn: '2026-10-02' });
    const late = await world.org('较晚设立下级', early.id, { establishedOn: '2026-10-10' });
    const ids = [a.id, early.id, late.id];
    const before = await stateOf(world, ids);
    // 停用日 = 下级设立日；停用日 < 下级设立日。上级自己的设立日合法，校验必须在上级写入之前整支完成（写探针）。
    await withWriteProbe(testDb().db, async () => {
      await expectRejected(
        await world.patchOrg(a, { enabled: false, effectiveDate: '2026-10-10' }),
        rejection('较晚设立下级', '2026-10-10', '2026-10-10'),
      );
      await expectRejected(
        await world.patchOrg(a, { enabled: false, effectiveDate: '2026-10-05' }),
        rejection('较晚设立下级', '2026-10-05', '2026-10-10'),
      );
    });
    expect(await stateOf(world, ids)).toEqual(before);
    // 停用日晚于所有下级设立日：整支照常级联停用
    const ok = await world.patchOrg(a, { enabled: false, effectiveDate: '2026-10-11' });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const after = await world.orgsAt('2026-10-11');
    for (const id of ids) expect(after.get(id)).toMatchObject({ enabled: false, startDate: '2026-10-11' });
  });

  it('新建接口：enabled:false 的首版即“设立当天停用”，400 同一文案，不占编码、不写组织', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org13f213create');
    const reservation = await world.call('POST', 'org/code-reservations', { ifMatch: 0, body: {} });
    expect(reservation.status).toBe(201);
    const held = (await reservation.json()) as { id: string };
    const create = (body: Record<string, unknown>) =>
      world.call('POST', 'org/organizations', {
        ifMatch: 0,
        body: { parents: { admin: { parentId: world.tenant.id } }, ...body },
      });
    await withWriteProbe(testDb().db, async () => {
      await expectRejected(
        await create({ name: '建即停用部门', establishedOn: '2026-10-16', enabled: false, reservationId: held.id }),
        rejection('建即停用部门', '2026-10-16', '2026-10-16'),
      );
      // 不传设立日期时取租户当天（2026-10-01）
      await expectRejected(
        await create({ name: '建即停用部门', enabled: false }),
        rejection('建即停用部门', '2026-10-01', '2026-10-01'),
      );
    });
    const list = await world.call('GET', 'org/organizations?asOf=2026-10-16&includeDisabled=true&name=建即停用部门');
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
    // 预占仍可用：同一预占随后正常启用新建成功
    const ok = await create({ name: '建即停用部门', establishedOn: '2026-10-16', reservationId: held.id });
    expect(ok.status, await ok.clone().text()).toBe(201);
  });

  it('带真实任职并选择“新增任职”联动：拒绝后任职链与员工 revision 不变', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org13f213linkage');
    const dept = await world.org('联动部门', undefined, { establishedOn: '2026-10-01' });
    const employee = await world.hire('联动员工', { departmentId: dept.id });
    const recordsBefore = await world.employmentRecords(employee.id);
    const employeeBefore = await world.getEmployee(employee.id);
    expect(recordsBefore.length).toBeGreaterThan(0);
    const before = await stateOf(world, [dept.id]);
    await withWriteProbe(testDb().db, async () => {
      await expectRejected(
        await world.patchOrg(dept, {
          enabled: false,
          name: '联动改名',
          addEmployment: true,
          effectiveDate: '2026-10-01',
        }),
        rejection('联动部门', '2026-10-01', '2026-10-01'),
      );
    });
    expect(await world.employmentRecords(employee.id)).toEqual(recordsBefore);
    expect((await world.getEmployee(employee.id)).revision).toBe(employeeBefore.revision);
    expect(await stateOf(world, [dept.id])).toEqual(before);
    // 对照：同一联动选项在合法的改名上确实会新增任职，说明上面的“不变”不是夹具没触发联动
    const renamed = await world.patchOrg(dept, { name: '联动改名', addEmployment: true, effectiveDate: '2026-10-02' });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    expect(await world.employmentRecords(employee.id, '2026-10-02')).not.toEqual(
      await world.employmentRecords(employee.id, '2026-10-01'),
    );
  });

  it('下级本就已停用（不会被级联追加版本）时，不因其设立日拦截', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org13f213disabled');
    const a = await world.org('已停下级的上级', undefined, { establishedOn: '2026-10-01' });
    const b = await world.org('已先停用下级', a.id, { establishedOn: '2026-10-02' });
    expect((await world.patchOrg(b, { enabled: false, effectiveDate: '2026-10-03' })).status).toBe(200);
    const response = await world.patchOrg(a, { enabled: false, effectiveDate: '2026-10-04' });
    expect(response.status, await response.clone().text()).toBe(200);
  });
});
