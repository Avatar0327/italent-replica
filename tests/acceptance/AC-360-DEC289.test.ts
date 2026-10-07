/**
 * DEC-289（用户 2026-10-07 定，补充 DEC-280）：
 * ① 开启“精细化权限”后，非系统管理员在活动内看到的评价对象 / 评价者也按数据权限裁剪，与人员表同口径（有意收紧，
 *   取证 Q-M0-112 并行）；读、写、审计都覆盖，范围外按不存在处理。
 * ③ 存量租户回补 360 标准身份：平台回补命令幂等，执行两次结果不变；租户手工建过同编码身份时保留不动并标 CODE_TAKEN。
 */
import { bootstrapTenantAdmin } from '@italent/api';
import { createUser, grantMembership } from '@italent/db';
import { survey360 } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { BASE, type PersonView, world360, type World360 } from './AC-360-support.js';
import { PLATFORM, seedOperator } from './support/platform-api.js';
import { cmd, seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

interface ObjectItem {
  id: string;
  personId: string;
}

interface AppraiserList {
  items: { id: string; appraiserPersonId: string; roleId: string }[];
  roleCounts: Record<string, number>;
  hint: string;
}

/** 两个部门：范围内（甲、乙两名员工）与范围外（丙）；另有一名外部人员。一般管理员的 360 数据范围只含范围内部门。 */
async function fineWorld(label: string) {
  const w = await world360(testDb().db, label);
  const general = await w.member('一般管理员');
  await w.appoint(general, 'general');
  const insideOrg = await w.session.org('范围内部门', { establishedOn: '2025-01-01' });
  const outsideOrg = await w.session.org('范围外部门', { establishedOn: '2025-01-01' });
  const hire = async (name: string, orgId: string) => {
    const employee = await w.session.employee(name);
    await w.session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2025-01-01', fields: { departmentId: orgId } },
      employee.revision,
    );
    return employee;
  };
  const [a, b, c] = [
    await hire('员工甲', insideOrg.id),
    await hire('员工乙', insideOrg.id),
    await hire('员工丙', outsideOrg.id),
  ];
  await w.ok(w.request('POST', '/people/sync', { body: {} }));
  const people = (await w.ok<{ items: PersonView[] }>(w.request('GET', '/people?pageSize=200'))).items;
  const of = (employeeId: string) => people.find((p) => p.employeeId === employeeId)!;
  const external = await w.person('外部客户');

  const q = await w.enableQuestionnaire(await w.keyBehavior({ self: 0, peer: 1, customer: 1 }));
  const activity = await w.activity({ name: '精细化活动' });
  const objIn = await w.object(activity.id, of(a.id).id, [q.id]);
  const objOut = await w.object(activity.id, of(c.id).id, [q.id]);
  const objExt = await w.object(activity.id, external.id, [q.id]);
  const peerIn = await w.appraiser(activity.id, objIn.id, of(b.id).id, 'peer');
  const customer = await w.appraiser(activity.id, objIn.id, external.id, 'customer');
  const current = await w.getActivity(activity.id);
  await w.ok(
    w.request('POST', `/activities/${activity.id}/grants`, { ifMatch: current.revision, body: { userIds: [general] } }),
  );

  const mou = await w.ok<{ id: string }>(
    w.enterprise('POST', '/mous', {
      ifMatch: 0,
      body: { code: 'mou289', name: '360范围', orgRanges: [{ orgId: insideOrg.id, includeDescendants: true }] },
    }),
    201,
  );
  await w.ok(
    w.enterprise('PUT', `/scopes/${general}/${survey360.SURVEY360_APP}`, {
      ifMatch: 0,
      body: { kind: 'mou', mouId: mou.id },
    }),
  );
  return { w, general, q, activity, objIn, objOut, objExt, peerIn, customer, external, people: { a, b, c }, of };
}

async function setFine(w: World360, on: boolean) {
  const settings = await w.ok<{ revision: number }>(w.request('GET', '/settings'));
  await w.ok(w.request('PUT', '/settings', { ifMatch: settings.revision, body: { finePermission: on } }));
}

describe('DEC-289① 精细化权限下活动内人员同口径裁剪', () => {
  it('读：评价对象列表只列范围内；范围外对象的评价者与得分 404；评价者与各角色人数只按范围内计', async () => {
    const s = await fineWorld('d289a');
    const { w, general, activity } = s;
    const g = w.as(general);
    const base = `/activities/${activity.id}/objects`;
    // 精细化关：活动内全部可见
    expect((await w.ok<{ items: ObjectItem[] }>(g('GET', base))).items).toHaveLength(3);

    await setFine(w, true);
    expect((await w.ok<{ items: ObjectItem[] }>(g('GET', base))).items.map((o) => o.id)).toEqual([s.objIn.id]);
    for (const hidden of [s.objOut.id, s.objExt.id]) {
      expect((await g('GET', `${base}/${hidden}/appraisers`)).status).toBe(404);
      expect((await g('GET', `${base}/${hidden}/scores`)).status).toBe(404);
    }
    const list = await w.ok<AppraiserList>(g('GET', `${base}/${s.objIn.id}/appraisers`));
    expect(list.items.map((i) => i.id)).toEqual([s.peerIn.id]);
    expect(list.roleCounts).toEqual({ [w.role('peer')]: 1 });
    expect(list.hint).toBe(survey360.ANONYMITY_HINT);
    expect((await g('GET', `${base}/${s.objIn.id}/scores`)).status).toBe(200);
    // 活动本身照常可见；系统管理员不受影响
    expect((await g('GET', `/activities/${activity.id}`)).status).toBe(200);
    expect((await w.ok<{ items: ObjectItem[] }>(w.request('GET', base))).items).toHaveLength(3);
    const all = await w.ok<AppraiserList>(w.request('GET', `${base}/${s.objIn.id}/appraisers`));
    expect(all.items).toHaveLength(2);
  });

  it('写：范围外的对象 / 评价者 / 人员一律 404 且数据不变；导入按整批失败', async () => {
    const s = await fineWorld('d289b');
    const { w, general, activity } = s;
    await setFine(w, true);
    const g = w.as(general);
    const base = `/activities/${activity.id}/objects`;
    const snapshot = async () => ({
      objects: (await w.ok<{ items: ObjectItem[] }>(w.request('GET', base))).items,
      appraisers: (await w.ok<AppraiserList>(w.request('GET', `${base}/${s.objIn.id}/appraisers`))).items,
      activity: await w.getActivity(activity.id),
    });
    const before = await snapshot();
    const outObject = before.objects.find((o) => o.id === s.objOut.id)!;
    const revisionOf = (id: string) =>
      (before.objects.find((o) => o.id === id) as unknown as { revision: number }).revision;

    expect((await g('DELETE', `${base}/${s.objOut.id}`, { ifMatch: revisionOf(outObject.id) })).status).toBe(404);
    expect(
      (
        await g('PUT', `${base}/${s.objOut.id}/questionnaires`, {
          ifMatch: revisionOf(outObject.id),
          body: { questionnaireIds: [s.q.id] },
        })
      ).status,
    ).toBe(404);
    const peerC = s.of(s.people.c.id).id;
    expect(
      (
        await g('POST', `${base}/${s.objOut.id}/appraisers`, {
          ifMatch: 0,
          body: { personId: peerC, roleId: w.role('peer') },
        })
      ).status,
    ).toBe(404);
    // 范围内对象上按 personId 选范围外人员、或录入邮箱命中范围外已有人员 → 404
    expect(
      (
        await g('POST', `${base}/${s.objIn.id}/appraisers`, {
          ifMatch: 0,
          body: { personId: peerC, roleId: w.role('peer') },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await g('POST', `${base}/${s.objIn.id}/appraisers`, {
          ifMatch: 0,
          body: { person: { name: '同名', email: s.external.email }, roleId: w.role('customer') },
        })
      ).status,
    ).toBe(404);
    expect(
      (await g('DELETE', `${base}/${s.objIn.id}/appraisers/${s.customer.id}`, { ifMatch: s.customer.revision })).status,
    ).toBe(404);
    expect((await g('POST', `${base}/${s.objOut.id}/confirmation`, { ifMatch: 0, body: {} })).status).toBe(404);
    expect(
      (await g('POST', `${base}/${s.objOut.id}/appraisers/auto`, { ifMatch: 0, body: { roles: ['peer'] } })).status,
    ).toBe(404);

    const importOf = (rows: Record<string, unknown>[]) =>
      g('POST', `/activities/${activity.id}/appraisers/import`, { ifMatch: 0, body: { sync: false, rows } });
    const outPerson = (await w.ok<PersonView>(w.request('GET', `/people/${s.objOut.personId}`))).email;
    const badObject = await importOf([
      { objectEmail: outPerson, roleId: w.role('customer'), name: '新客户', email: 'new-289@example.com' },
    ]);
    expect(badObject.status).toBe(400);
    expect(JSON.stringify(await badObject.json())).toContain('OBJECT_NOT_FOUND');
    const inPerson = (await w.ok<PersonView>(w.request('GET', `/people/${s.objIn.personId}`))).email;
    const badPerson = await importOf([
      { objectEmail: inPerson, roleId: w.role('customer'), name: '改名', email: s.external.email },
    ]);
    expect(badPerson.status).toBe(400);
    expect(JSON.stringify(await badPerson.json())).toContain('PERSON_NOT_VISIBLE');

    expect(await snapshot()).toEqual(before);
    expect((await w.ok<PersonView>(w.request('GET', `/people/${s.external.id}`))).name).toBe('外部客户');
  });

  it('审计：精细化开时活动内对象的日志对非系统管理员不可见，活动记录照常；关闭后恢复', async () => {
    const s = await fineWorld('d289c');
    const { w, general } = s;
    const audit = auditApi(testDb().db, '2026-10-01T02:00:00Z', { authorize: w.authorize });
    const types = async (user: string) =>
      new Set(
        (await audit.dataChanges({ user, tenant: w.tenantId }, { limit: '100' })).items
          .filter((i) => i.objectType.startsWith('survey360'))
          .map((i) => i.objectType),
      );
    const before = await types(general);
    expect(before.has('survey360-object')).toBe(true);
    expect(before.has('survey360-relation')).toBe(true);
    await setFine(w, true);
    const fine = await types(general);
    expect(fine.has('survey360-activity')).toBe(true);
    expect(fine.has('survey360-object')).toBe(false);
    expect(fine.has('survey360-relation')).toBe(false);
    expect((await types(w.admin)).has('survey360-object')).toBe(true);
  });
});

describe('DEC-289③ 存量租户回补 360 标准身份', () => {
  it('补装缺失的标准身份；执行两次结果不变；手工同编码身份保留并标 CODE_TAKEN；回补后可授出并生效', async () => {
    const { db } = testDb();
    const api = tenantApi(db, { authorize: undefined });
    const operator = await seedOperator(db, 'ops-289');
    // 存量租户：开通早于 360 标准身份（这里直接建租户，不经平台开通，库里没有任何标准身份）
    const { tenant, user: admin } = await seedTenantWithMember(db, 'd289d');
    await bootstrapTenantAdmin(db, { tenantId: tenant.id, userId: admin.id }, cmd());
    const asAdmin = { user: admin.id, tenant: tenant.id };
    const manual = await api.request('POST', '/api/tenant/permission/profiles', {
      ...asAdmin,
      body: { code: 'standard_360_general_admin', name: '租户手工建的同编码', apps: ['Survey360'], licenseType: null },
    });
    expect(manual.status).toBe(201);
    const manualProfile = (await manual.json()) as { id: string; revision: number };

    const backfill = () =>
      api.request('POST', `${PLATFORM}/tenants/${tenant.id}/standard-profiles/backfill`, {
        user: operator.id,
        body: {},
      });
    const denied = await api.request('POST', `${PLATFORM}/tenants/${tenant.id}/standard-profiles/backfill`, {
      user: admin.id,
      body: {},
    });
    expect(denied.status).toBe(403);

    const first = await backfill();
    expect(first.status, await first.clone().text()).toBe(200);
    const result = (await first.json()) as { installed: string[]; skipped: { code: string; reason: string }[] };
    expect(result.installed).toEqual(
      expect.arrayContaining(['standard_360_system_admin', 'standard_360_advanced_admin', 'standard_org_system_admin']),
    );
    expect(result.installed).not.toContain('standard_360_general_admin');
    expect(result.skipped).toEqual([{ code: 'standard_360_general_admin', reason: 'CODE_TAKEN' }]);

    const state = async () => {
      const listed = await api.request('GET', '/api/tenant/permission/profiles', asAdmin);
      const { items } = (await listed.json()) as { items: { id: string; code: string }[] };
      const details = [];
      for (const p of items)
        details.push(await (await api.request('GET', `/api/tenant/permission/profiles/${p.id}`, asAdmin)).json());
      return details;
    };
    const afterFirst = await state();

    const second = await backfill();
    expect(second.status).toBe(200);
    const again = (await second.json()) as { installed: string[]; skipped: { code: string; reason: string }[] };
    expect(again.installed).toEqual([]);
    expect(again.skipped).toContainEqual({ code: 'standard_360_general_admin', reason: 'CODE_TAKEN' });
    expect(
      again.skipped
        .filter((x) => x.reason === 'ALREADY_INSTALLED')
        .map((x) => x.code)
        .sort(),
    ).toEqual([...result.installed].sort());
    expect(await state()).toEqual(afterFirst);
    const kept = (await (
      await api.request('GET', `/api/tenant/permission/profiles/${manualProfile.id}`, asAdmin)
    ).json()) as {
      source: string;
      revision: number;
      objects: unknown[];
    };
    expect(kept).toMatchObject({ source: 'custom', revision: manualProfile.revision, objects: [] });

    // 回补的身份已在租户管理员的可授权范围内：企业管理员在“用户授权”里授出后即生效
    const listed = (await (await api.request('GET', '/api/tenant/permission/profiles', asAdmin)).json()) as {
      items: { id: string; code: string }[];
    };
    const advanced = listed.items.find((p) => p.code === 'standard_360_advanced_admin')!;
    const member = await createUser(db, { email: 'adv-289@example.com', displayName: '高级' }, cmd());
    await grantMembership(db, { tenantId: tenant.id, userId: member.id, expectedRevision: 0 }, cmd());
    const granted = await api.request('POST', '/api/tenant/permission/grants', {
      ...asAdmin,
      body: { userId: member.id, profileId: advanced.id },
    });
    expect(granted.status, await granted.clone().text()).toBe(201);
    expect((await api.request('GET', `${BASE}/activities`, { user: member.id, tenant: tenant.id })).status).toBe(200);
  });
});
