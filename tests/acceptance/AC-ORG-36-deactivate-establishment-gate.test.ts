/**
 * AC-ORG-36（F-296，R2-T08 §5.7）：11e 之前的临时关口——直接停用组织时，被停用组织及其连带下级自停用日 E 起
 * 仍有编制对象（覆盖 E 的当期编制，或 period_start > E 的后续周期）则整次拒绝 409，不落库。
 * 本文件在 PGlite 与真 PostgreSQL（TEST_DATABASE_URL）下跑同一组用例。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { orgPeopleWorld, resultRows, type Organization } from './AC-ORG-people-support.js';

const testDb = useTestDb();
type World = Awaited<ReturnType<typeof orgPeopleWorld>>;

const MESSAGE = '该组织（或其下级）仍有编制，暂不支持直接停用，请先处理编制';
const CODE = 'ORG_DEACTIVATE_ESTABLISHMENT_END_NOT_AVAILABLE';

async function scheme(world: World): Promise<string> {
  const response = await world.call('POST', 'establishment/schemes', {
    ifMatch: 0,
    body: {
      name: '停用关口编制',
      periodType: 'annual',
      maintenanceMode: 'local',
      startDate: '2025-01-01',
      occupancyRanges: [{ employmentType: 'internal' }],
    },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function capacity(world: World, schemeId: string, org: Organization, periodStart: string) {
  const response = await world.call('POST', 'establishment/capacities', {
    ifMatch: 0,
    body: { orgId: org.id, schemeId, periodStart, localCapacity: 3 },
  });
  expect(response.status, await response.clone().text()).toBe(201);
}

/** 拒绝后可观察的写入：组织版本数、revision、审计动作；编制版本数。 */
async function stateOf(world: World, orgIds: readonly string[]) {
  return withTenant(testDb().db, world.tenant.id, async (tx) => {
    const out: Record<string, unknown> = {};
    for (const id of orgIds) {
      out[id] = {
        versions: resultRows<{ count: number }>(
          await tx.execute(sql`SELECT count(*)::int AS count FROM org_versions WHERE org_id = ${id}`),
        )[0]?.count,
        revision: resultRows<{ revision: number }>(
          await tx.execute(sql`SELECT revision FROM org_objects WHERE id = ${id}`),
        )[0]?.revision,
        audit: resultRows<{ action: string }>(
          await tx.execute(sql`SELECT action FROM audit_events WHERE object_id = ${id} ORDER BY occurred_at, id`),
        ).map((row) => row.action),
      };
    }
    out.establishmentVersions = resultRows<{ count: number }>(
      await tx.execute(sql`SELECT count(*)::int AS count FROM establishment_versions`),
    )[0]?.count;
    return out;
  });
}

async function expectGate(
  world: World,
  root: Organization,
  ids: readonly string[],
  effectiveDate: string,
  alreadyDisabled: readonly string[] = [],
) {
  const before = await stateOf(world, ids);
  const response = await world.patchOrg(root, { enabled: false, effectiveDate });
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: CODE, message: MESSAGE } });
  expect(await stateOf(world, ids)).toEqual(before);
  const after = await world.orgsAt(effectiveDate);
  for (const id of ids) expect(after.get(id)).toMatchObject({ enabled: !alreadyDisabled.includes(id) });
}

async function tree(world: World) {
  const root = await world.org('关口上级', undefined, { establishedOn: '2025-06-01' });
  const child = await world.org('关口下级', root.id, { establishedOn: '2025-06-01' });
  const grandchild = await world.org('关口孙级', child.id, { establishedOn: '2025-06-01' });
  return { root, child, grandchild, ids: [root.id, child.id, grandchild.id] };
}

describe('AC-ORG-36 F-296 直接停用含编制组织的临时关口', () => {
  it('①本组织有覆盖停用日的当期编制：409，错误文案不列组织名，组织不变', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org36own');
    const t = await tree(world);
    await capacity(world, await scheme(world), t.root, '2026-01-01');
    await expectGate(world, t.root, t.ids, '2026-12-01');
  });

  it('②仅某下级（孙级）有编制：整支 409', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org36desc');
    const t = await tree(world);
    await capacity(world, await scheme(world), t.grandchild, '2026-01-01');
    await expectGate(world, t.root, t.ids, '2026-12-01');
  });

  it('③仅有停用日之后的后续周期编制：409', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org36future');
    const t = await tree(world);
    await capacity(world, await scheme(world), t.child, '2027-01-01');
    await expectGate(world, t.root, t.ids, '2026-12-01');
  });

  it('④整支无编制（范围外组织有编制不拦）：照常级联停用', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org36none');
    const t = await tree(world);
    const other = await world.org('无关组织', undefined, { establishedOn: '2025-06-01' });
    await capacity(world, await scheme(world), other, '2026-01-01');
    const response = await world.patchOrg(t.root, { enabled: false, effectiveDate: '2026-12-01' });
    expect(response.status, await response.clone().text()).toBe(200);
    const after = await world.orgsAt('2026-12-01');
    for (const id of t.ids) expect(after.get(id)).toMatchObject({ enabled: false });
    expect(after.get(other.id)).toMatchObject({ enabled: true });
  });

  it('⑤停用日之前已结束的周期编制不拦', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org36ended');
    const t = await tree(world);
    await capacity(world, await scheme(world), t.child, '2026-01-01');
    const response = await world.patchOrg(t.root, { enabled: false, effectiveDate: '2027-02-01' });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await world.orgsAt('2027-02-01')).get(t.child.id)).toMatchObject({ enabled: false });
  });

  it('⑦E 当日已停用 / 已排定停用的下级有编制：同样 409（检查范围是完整的已授权子树）', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org36scheduled');
    const t = await tree(world);
    // 下级（连同孙级）先排定 11-01 停用（此时无编制，放行）；它仍启用的 10-01 建当年编制；再停用上级，E=12-01 时下级已停用但编制仍在。
    const stopped = await world.patchOrg(t.child, { enabled: false, effectiveDate: '2026-11-01' });
    expect(stopped.status, await stopped.clone().text()).toBe(200);
    const stoppedChild = (await world.orgsAt('2026-11-01')).get(t.child.id)!;
    await capacity(world, await scheme(world), stoppedChild, '2026-01-01');
    await expectGate(world, t.root, t.ids, '2026-12-01', [t.child.id, t.grandchild.id]);
  });

  it('⑥拒绝后整支仍启用、无任何写入；对照：停用日晚于该周期结束日后可正常停用', async () => {
    const world = await orgPeopleWorld(testDb().db, 'org36reject');
    const t = await tree(world);
    await capacity(world, await scheme(world), t.child, '2026-01-01');
    await expectGate(world, t.root, t.ids, '2026-12-01');
    const latest = (await world.orgsAt('2026-12-01')).get(t.root.id)!;
    const later = await world.patchOrg(latest, { enabled: false, effectiveDate: '2027-01-01' });
    expect(later.status, await later.clone().text()).toBe(200);
  });
});
