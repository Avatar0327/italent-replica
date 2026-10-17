/**
 * AC-ORG-13（F-213，R2f3 §2.2）：停用日期必须晚于组织设立日期（首版生效日，DEC-130），整支级联时同样按各下级自己的设立日判断。
 * 拒绝一律 400 VALIDATION_FAILED、文案照原站，且整单无任何写入（版本、revision、审计、下级级联都不变）。
 * 本文件在 PGlite 与真 PostgreSQL（TEST_DATABASE_URL）下跑同一组用例。
 */
import { sql, withTenant } from '@italent/db';
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
    // 停用日 = 下级设立日
    await expectRejected(
      await world.patchOrg(a, { enabled: false, effectiveDate: '2026-10-10' }),
      rejection('较晚设立下级', '2026-10-10', '2026-10-10'),
    );
    // 停用日 < 下级设立日（下级设立日在停用日之后）
    await expectRejected(
      await world.patchOrg(a, { enabled: false, effectiveDate: '2026-10-05' }),
      rejection('较晚设立下级', '2026-10-05', '2026-10-10'),
    );
    expect(await stateOf(world, ids)).toEqual(before);
    // 停用日晚于所有下级设立日：整支照常级联停用
    const ok = await world.patchOrg(a, { enabled: false, effectiveDate: '2026-10-11' });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const after = await world.orgsAt('2026-10-11');
    for (const id of ids) expect(after.get(id)).toMatchObject({ enabled: false, startDate: '2026-10-11' });
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
