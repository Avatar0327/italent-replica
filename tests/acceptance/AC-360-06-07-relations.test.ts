/**
 * AC-360-06 按组织架构自动添加评价者（E3-R18）；AC-360-07 请上级确认评价关系，确认后前台不可再改（E3-R19）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type PersonView, type RelationView, world360, type World360 } from './AC-360-support.js';

const testDb = useTestDb();

interface SyncResult {
  created: { personId: string; employeeId: string }[];
  updated: { personId: string; employeeId: string }[];
  conflicts: string[];
}

/** 组织架构：M、Y 无上级；E、P1、P2 的直线经理是 M；S1 的是 E；X 的是 Y。 */
async function orgWorld(w: World360) {
  const org = await w.session.org('评估部', { establishedOn: '2025-01-01' });
  const hire = async (name: string, managerId?: string) => {
    const employee = await w.session.employee(name);
    await w.session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2025-01-01',
        fields: { departmentId: org.id, ...(managerId ? { directManagerId: managerId } : {}) },
      },
      employee.revision,
    );
    return employee.id;
  };
  const M = await hire('经理M');
  const Y = await hire('经理Y');
  const E = await hire('员工E', M);
  const P1 = await hire('同事P1', M);
  const P2 = await hire('同事P2', M);
  const S1 = await hire('下属S1', E);
  const X = await hire('无关X', Y);
  const sync = await w.ok<SyncResult>(w.request('POST', '/people/sync', { body: {} }));
  const personOf = (employeeId: string) => sync.created.find((c) => c.employeeId === employeeId)!.personId;
  return { org, sync, ids: { M, Y, E, P1, P2, S1, X }, personOf };
}

async function setup(w: World360) {
  const o = await orgWorld(w);
  const q = await w.enableQuestionnaire(
    await w.keyBehavior({ self: 0, superior: 5, peer: 3, subordinate: 2, customer: 1 }),
  );
  const activity = await w.activity();
  const object = await w.object(activity.id, o.personOf(o.ids.E), [q.id]);
  return { ...o, q, activity, object };
}

async function appraisers(w: World360, activityId: string, objectId: string) {
  return w.ok<{ items: (RelationView & { appraiser: { name: string } })[]; hint: string }>(
    w.request('GET', `/activities/${activityId}/objects/${objectId}/appraisers`),
  );
}

describe('AC-360-06 按组织架构自动添加', () => {
  it('上级 = 直线经理，同事 = 同一直线经理的人，下级 = 直接下属', async () => {
    const w = await world360(testDb().db, 'r06');
    const s = await setup(w);
    expect(s.sync.created).toHaveLength(7);
    await w.ok(
      w.request('POST', `/activities/${s.activity.id}/objects/${s.object.id}/appraisers/auto`, {
        ifMatch: 0,
        body: { roles: ['superior', 'peer', 'subordinate'] },
      }),
    );
    const list = await appraisers(w, s.activity.id, s.object.id);
    const byRole = (code: string) =>
      list.items
        .filter((r) => r.roleId === w.role(code))
        .map((r) => r.appraiserPersonId)
        .sort();
    expect(byRole('superior')).toEqual([s.personOf(s.ids.M)]);
    expect(byRole('peer')).toEqual([s.personOf(s.ids.P1), s.personOf(s.ids.P2)].sort());
    expect(byRole('subordinate')).toEqual([s.personOf(s.ids.S1)]);
    expect(list.items.map((r) => r.appraiserPersonId)).not.toContain(s.personOf(s.ids.X));
    expect(list.items.map((r) => r.appraiserPersonId)).not.toContain(s.personOf(s.ids.E));
  });

  it('可设各角色人数上限', async () => {
    const w = await world360(testDb().db, 'r06b');
    const s = await setup(w);
    await w.ok(
      w.request('POST', `/activities/${s.activity.id}/objects/${s.object.id}/appraisers/auto`, {
        ifMatch: 0,
        body: { roles: ['peer'], limits: { peer: 1 } },
      }),
    );
    const list = await appraisers(w, s.activity.id, s.object.id);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.roleId).toBe(w.role('peer'));
  });
});

describe('AC-360-07 请上级确认评价关系', () => {
  it('上级确认后前台不可再改（409），管理员后台仍可调整', async () => {
    const w = await world360(testDb().db, 'r07');
    const s = await setup(w);
    const target = await w.ok<PersonView>(w.request('GET', `/people/${s.personOf(s.ids.E)}`));
    expect(target.superiorPersonId).toBe(s.personOf(s.ids.M));
    const invited = await w.ok<{ id: string; confirmerPersonId: string; status: string }>(
      w.request('POST', `/activities/${s.activity.id}/objects/${s.object.id}/confirmation`, { ifMatch: 0, body: {} }),
      201,
    );
    expect(invited).toMatchObject({ confirmerPersonId: s.personOf(s.ids.M), status: 'pending' });
    const confirm = w.link(await w.token(s.activity.id, s.personOf(s.ids.M), 'survey360.confirm_invitation'));
    const view = async () =>
      w.ok<{ status: string; revision: number; appraisers: { id: string; appraiserPersonId: string }[] }>(
        confirm('GET', ''),
      );
    let current = await view();
    const added = await confirm('POST', '/confirmation/appraisers', {
      ifMatch: current.revision,
      body: { personId: s.personOf(s.ids.P1), roleId: w.role('peer') },
    });
    expect(added.status, await added.clone().text()).toBe(201);
    // 同事只能从内部员工中选；客户可手工录入（E3-R19）
    current = await view();
    const external = await w.person('外部顾问');
    const peerExternal = await confirm('POST', '/confirmation/appraisers', {
      ifMatch: current.revision,
      body: { personId: external.id, roleId: w.role('peer') },
    });
    expect(peerExternal.status).toBe(400);
    const customer = await confirm('POST', '/confirmation/appraisers', {
      ifMatch: current.revision,
      body: { person: { name: '客户甲', email: 'customer-r07@example.com' }, roleId: w.role('customer') },
    });
    expect(customer.status, await customer.clone().text()).toBe(201);
    current = await view();
    const done = await confirm('POST', '/confirmation/submit', { ifMatch: current.revision, body: {} });
    expect(done.status).toBe(200);
    const before = await view();
    expect(before.status).toBe('confirmed');
    const again = await confirm('POST', '/confirmation/appraisers', {
      ifMatch: before.revision,
      body: { personId: s.personOf(s.ids.P2), roleId: w.role('peer') },
    });
    expect(again.status).toBe(409);
    const removal = await confirm('DELETE', `/confirmation/appraisers/${before.appraisers[0]!.id}`, {
      ifMatch: before.revision,
    });
    expect(removal.status).toBe(409);
    expect(await view()).toEqual(before);
    // 管理员后台仍可调整
    await w.appraiser(s.activity.id, s.object.id, s.personOf(s.ids.P2), 'peer');
    const list = await appraisers(w, s.activity.id, s.object.id);
    expect(list.items.map((r) => r.appraiserPersonId)).toContain(s.personOf(s.ids.P2));
  });

  it('没有上级的评价对象不能邀请上级确认', async () => {
    const w = await world360(testDb().db, 'r07b');
    const q = await w.enableQuestionnaire(await w.keyBehavior());
    const activity = await w.activity();
    const object = await w.object(activity.id, (await w.person('无上级')).id, [q.id]);
    const res = await w.request('POST', `/activities/${activity.id}/objects/${object.id}/confirmation`, {
      ifMatch: 0,
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it('伪造或缺少令牌一律 404，不泄露活动信息', async () => {
    const w = await world360(testDb().db, 'r07c');
    expect((await w.link('not-a-token')('GET', '')).status).toBe(404);
    const missing = await w.api.request('GET', '/api/survey360/link', { tenant: w.tenantId });
    expect(missing.status).toBe(404);
  });
});
