/**
 * DEC-280（Q-M0-106 结案，docs/02_业务建模/25 §8）：360 管理员与授权照原站。
 * ① 系统管理员看全部活动；高级 / 一般管理员只看自己创建的和被授权的；不能编辑非本人创建的套卷；一般管理员没有
 *   “从系统管理中同步人员信息”；租户可自定义 360 身份。
 * ② 360 内没有管理员设置，身份由企业管理员在“用户授权”里授予。
 * ③ 活动授权是“未授权 / 已授权”穿梭框，只有添加 / 移除；只能选 360 身份持有人；创建者与系统管理员默认已授权；
 *   能编辑活动的人就能改授权。
 * ④ 作答页默认显示评价者姓名、默认显示评价角色名称。
 * ⑤ 人员表默认对 360 管理员全部可见、不单独脱敏手机号；开启“精细化权限”后非系统管理员按数据权限裁剪。
 */
import { createUser, grantMembership } from '@italent/db';
import { survey360 } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { newUser, provisioned, seedOperator } from './support/platform-api.js';
import { cmd, errorCode, tenantApi } from './support/tenant-api.js';
import {
  type ActivityView,
  BASE,
  type PersonView,
  type QuestionnaireView,
  world360,
  type World360,
} from './AC-360-support.js';

const testDb = useTestDb();
const ACTIVITY = survey360.SURVEY360_OBJECTS.activity;

interface GrantsView {
  authorized: { userId: string; creator: boolean; systemAdmin: boolean; explicit: boolean }[];
  unauthorized: { userId: string }[];
}

interface MyObject {
  dataOperations: { create: boolean; update: boolean; delete: boolean };
  buttons: { buttonCode: string; level: string }[];
}

async function grants(w: World360, activityId: string, by = w.admin) {
  return w.ok<GrantsView>(w.as(by)('GET', `/activities/${activityId}/grants`));
}

async function addGrant(w: World360, activityId: string, userIds: string[], by = w.admin) {
  const current = await w.getActivity(activityId, by);
  return w.as(by)('POST', `/activities/${activityId}/grants`, { ifMatch: current.revision, body: { userIds } });
}

async function removeGrant(w: World360, activityId: string, userId: string, by = w.admin) {
  const current = await w.getActivity(activityId, by);
  return w.as(by)('DELETE', `/activities/${activityId}/grants/${userId}`, { ifMatch: current.revision });
}

async function team(w: World360) {
  const advanced = await w.member('高级管理员');
  const general = await w.member('一般管理员');
  const advancedGrant = await w.appoint(advanced, 'advanced');
  const generalGrant = await w.appoint(general, 'general');
  return { advanced, general, advancedGrant, generalGrant };
}

describe('DEC-280① 三类内置身份由平台下发，企业管理员在用户授权里授予', () => {
  it('开通租户即有三个 360 标准身份；授予高级管理员后只见自己创建的活动，按钮与系统管理员不同', async () => {
    const { db } = testDb();
    const api = tenantApi(db, { authorize: undefined });
    const operator = await seedOperator(db, 'ops-360');
    const admin = await newUser(db, 'first-admin-360');
    const exception = await newUser(db, 'exception-admin-360');
    const result = await provisioned(api, operator, {
      firstAdminUserId: admin.id,
      exceptionAdminUserId: exception.id,
      licenses: [{ licenseType: 'core_hr', quota: 10 }],
    });
    const tenant = result.tenant.id;
    const asAdmin = { user: admin.id, tenant };
    const listed = await api.request('GET', '/api/tenant/permission/profiles', asAdmin);
    const { items } = (await listed.json()) as { items: { id: string; code: string; apps: string[] }[] };
    const of = (code: string) => items.find((p) => p.code === code)!;
    for (const code of ['standard_360_system_admin', 'standard_360_advanced_admin', 'standard_360_general_admin'])
      expect(of(code).apps).toEqual([survey360.SURVEY360_APP]);

    const user = await createUser(db, { email: 'adv-360@example.com', displayName: '高级' }, cmd());
    await grantMembership(db, { tenantId: tenant, userId: user.id, expectedRevision: 0 }, cmd());
    const granted = await api.request('POST', '/api/tenant/permission/grants', {
      ...asAdmin,
      body: { userId: user.id, profileId: of('standard_360_advanced_admin').id },
    });
    expect(granted.status, await granted.clone().text()).toBe(201);
    const asUser = { user: user.id, tenant };
    const before = await api.request('GET', `${BASE}/activities`, asUser);
    expect(before.status).toBe(200);
    const created = await api.request('POST', `${BASE}/activities`, {
      ...asUser,
      ifMatch: 0,
      body: { name: '高级自建', form: 'single' },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const list = (await (await api.request('GET', `${BASE}/activities`, asUser)).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(1);
    // 首位租户管理员没有 360 身份：看不到 360 活动（360 身份要另行授予）
    expect((await api.request('GET', `${BASE}/activities`, asAdmin)).status).toBe(403);
    const me = await api.request('GET', `/api/tenant/permission/me/objects/${ACTIVITY.code}`, asUser);
    const buttons = ((await me.json()) as MyObject).buttons.map((b) => b.buttonCode);
    expect(buttons).not.toContain(survey360.SURVEY360_BUTTONS.allActivities);
    expect(buttons).toContain('update');
  });

  it('不能编辑非本人创建的套卷：403 且数据不变；本人创建的可改；系统管理员可改他人的', async () => {
    const w = await world360(testDb().db, 'd280c');
    const { advanced } = await team(w);
    const a = w.as(advanced);
    const others = await w.keyBehavior();
    expect((await a('GET', `/questionnaires/${others.id}`)).status).toBe(200);
    const before = await w.ok<QuestionnaireView>(w.request('GET', `/questionnaires/${others.id}`));
    const put = await a('PUT', `/questionnaires/${others.id}`, { ifMatch: before.revision, body: { name: '篡改' } });
    expect(put.status).toBe(403);
    expect(((await put.json()) as { error: { details?: { reason?: string } } }).error.details?.reason).toBe(
      'QUESTIONNAIRE_NOT_OWNER',
    );
    expect((await a('POST', `/questionnaires/${others.id}/enable`, { ifMatch: before.revision })).status).toBe(403);
    expect((await a('DELETE', `/questionnaires/${others.id}`, { ifMatch: before.revision })).status).toBe(403);
    expect(await w.ok(w.request('GET', `/questionnaires/${others.id}`))).toEqual(before);

    const mine = await w.ok<QuestionnaireView>(
      a('POST', '/questionnaires', { ifMatch: 0, body: { name: '高级自建套卷', type: 'key_behavior' } }),
      201,
    );
    const renamed = await w.ok<QuestionnaireView>(
      a('PUT', `/questionnaires/${mine.id}`, { ifMatch: mine.revision, body: { name: '改名' } }),
    );
    expect(renamed.name).toBe('改名');
    const bySystem = await w.ok<QuestionnaireView>(
      w.request('PUT', `/questionnaires/${mine.id}`, { ifMatch: renamed.revision, body: { name: '系统改' } }),
    );
    expect(bySystem.name).toBe('系统改');
  });

  it('一般管理员看不到“从系统管理中同步人员信息”：同步、冲突清单、关联日志都 403；高级管理员可以', async () => {
    const w = await world360(testDb().db, 'd280d');
    const { advanced, general } = await team(w);
    const person = await w.person('外部人员');
    const g = w.as(general);
    expect((await g('POST', '/people/sync', { body: {} })).status).toBe(403);
    expect((await g('GET', '/people/sync-conflicts')).status).toBe(403);
    expect((await g('GET', `/people/${person.id}/link-logs`)).status).toBe(403);
    expect((await g('GET', '/people')).status).toBe(200);
    expect((await w.as(advanced)('POST', '/people/sync', { body: {} })).status).toBe(200);
    expect((await w.as(advanced)('GET', '/people/sync-conflicts')).status).toBe(200);
  });

  it('租户自定义 360 身份（分子公司 HR-组织者）：只按其对象权限可用，其余 403', async () => {
    const w = await world360(testDb().db, 'd280e');
    const { activity, relation, questionnaire } = survey360.SURVEY360_OBJECTS;
    const all = (definition: typeof activity | typeof relation | typeof questionnaire) =>
      survey360.SURVEY360_PROFILES[0]!.objects.find((o) => o.objectCode === definition.code)!;
    const viewOnly = { ...all(questionnaire), dataOperations: { create: false, update: false, delete: false } };
    const organizer = await w.defineProfile('360分子公司HR-组织者', [
      {
        ...all(activity),
        dataOperations: { create: false, update: true, delete: false },
        buttons: [{ buttonCode: 'update', level: 'detail' }],
      },
      all(relation),
      { ...viewOnly, buttons: [] },
    ]);
    const hr = await w.member('组织者');
    await w.grantProfile(hr, organizer);
    const target = await w.activity({ name: '授权给组织者' });
    expect((await addGrant(w, target.id, [hr])).status).toBe(200);
    const h = w.as(hr);
    expect((await h('GET', `/activities/${target.id}`)).status).toBe(200);
    expect((await h('GET', `/activities/${target.id}/objects`)).status).toBe(200);
    expect((await h('GET', '/questionnaires')).status).toBe(200);
    const renamed = await h('PUT', `/activities/${target.id}`, {
      ifMatch: (await w.getActivity(target.id)).revision,
      body: { name: '组织者改名' },
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    expect((await h('GET', '/people')).status).toBe(403);
    expect((await h('POST', '/activities', { ifMatch: 0, body: { name: 'x', form: 'single' } })).status).toBe(403);
    expect((await h('POST', '/questionnaires', { ifMatch: 0, body: { name: 'x', type: 'rating' } })).status).toBe(403);
    const before = await w.getActivity(target.id);
    expect((await h('POST', `/activities/${target.id}/enable`, { ifMatch: before.revision })).status).toBe(403);
    expect(await w.getActivity(target.id)).toEqual(before);
  });
});

describe('DEC-280② 360 内没有管理员设置', () => {
  it('管理员接口不存在；撤销用户授权只停身份，不删活动授权（重新授予后照旧可见）', async () => {
    const w = await world360(testDb().db, 'd280f');
    const { advanced, advancedGrant } = await team(w);
    expect((await w.request('GET', '/admins')).status).toBe(404);
    expect(
      (await w.request('POST', '/admins', { ifMatch: 0, body: { userId: advanced, role: 'system' } })).status,
    ).toBe(404);
    expect((await w.request('GET', '/me')).status).toBe(404);
    const activity = await w.activity();
    expect((await addGrant(w, activity.id, [advanced])).status).toBe(200);
    await w.revokeGrant(advancedGrant);
    expect((await w.as(advanced)('GET', `/activities/${activity.id}`)).status).toBe(403);
    // 撤销后不再是 360 身份持有人，不出现在穿梭框里；活动授权行保留，重新授予后照旧可见
    expect((await grants(w, activity.id)).authorized.map((g) => g.userId)).not.toContain(advanced);
    await w.appoint(advanced, 'advanced');
    expect((await w.as(advanced)('GET', `/activities/${activity.id}`)).status).toBe(200);
  });
});

describe('DEC-280③ 活动授权穿梭框', () => {
  it('已授权栏默认含创建者与系统管理员；未授权栏只列 360 身份持有人；添加 / 移除不分查看与管理', async () => {
    const w = await world360(testDb().db, 'd280g');
    const { advanced, general } = await team(w);
    const outsider = await w.member('无 360 身份');
    const activity = await w.activity({ name: '高级建' }, advanced);
    const view = await grants(w, activity.id, advanced);
    expect(view.authorized).toEqual(
      expect.arrayContaining([
        { userId: advanced, creator: true, systemAdmin: false, explicit: false },
        { userId: w.admin, creator: false, systemAdmin: true, explicit: false },
      ]),
    );
    expect(view.authorized).toHaveLength(2);
    expect(view.unauthorized.map((u) => u.userId)).toEqual([general]);
    expect(JSON.stringify(view)).not.toMatch(/level|manage/);

    const before = await w.getActivity(activity.id);
    const bad = await addGrant(w, activity.id, [outsider], advanced);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { details?: { reason?: string } } }).error.details?.reason).toBe(
      'NOT_A_360_USER',
    );
    expect(await w.getActivity(activity.id)).toEqual(before);

    expect((await addGrant(w, activity.id, [general], advanced)).status).toBe(200);
    const after = await grants(w, activity.id, advanced);
    expect(after.authorized).toContainEqual({ userId: general, creator: false, systemAdmin: false, explicit: true });
    expect(after.unauthorized).toEqual([]);
    expect((await w.as(general)('GET', `/activities/${activity.id}`)).status).toBe(200);

    for (const implicit of [advanced, w.admin]) {
      const res = await removeGrant(w, activity.id, implicit, advanced);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { details?: { reason?: string } } }).error.details?.reason).toBe(
        'IMPLICIT_GRANT',
      );
    }
    expect((await removeGrant(w, activity.id, general, advanced)).status).toBe(200);
    expect((await w.as(general)('GET', `/activities/${activity.id}`)).status).toBe(404);
  });

  it('能编辑活动的人就能改授权：被授权的一般管理员可添加；只有查看权的自定义身份 403', async () => {
    const w = await world360(testDb().db, 'd280h');
    const { advanced, general } = await team(w);
    const activity = await w.activity();
    expect((await addGrant(w, activity.id, [general])).status).toBe(200);
    expect((await addGrant(w, activity.id, [advanced], general)).status).toBe(200);
    expect((await w.as(advanced)('GET', `/activities/${activity.id}`)).status).toBe(200);

    const readOnly = await w.defineProfile('只读活动', [
      {
        ...survey360.SURVEY360_PROFILES[0]!.objects.find((o) => o.objectCode === ACTIVITY.code)!,
        dataOperations: { create: false, update: false, delete: false },
        buttons: [],
      },
    ]);
    const viewer = await w.member('只读');
    await w.grantProfile(viewer, readOnly);
    expect((await addGrant(w, activity.id, [viewer])).status).toBe(200);
    const before = await grants(w, activity.id);
    expect((await addGrant(w, activity.id, [w.admin], viewer)).status).toBe(403);
    expect((await removeGrant(w, activity.id, general, viewer)).status).toBe(403);
    expect(await grants(w, activity.id)).toEqual(before);
  });
});

describe('DEC-280④ 作答页默认值', () => {
  it('建活动不传两个开关：默认显示评价者姓名、显示评价角色名称；作答页照此显示', async () => {
    const w = await world360(testDb().db, 'd280i');
    const created = await w.ok<ActivityView>(
      w.request('POST', '/activities', { ifMatch: 0, body: { name: '默认值', form: 'single' } }),
      201,
    );
    expect(created).toMatchObject({ showAppraiserName: true, roleDisplay: 'name' });
    const q = await w.enableQuestionnaire(await w.keyBehavior({ self: 0, superior: 1 }));
    const target = await w.person('被评价人');
    const object = await w.object(created.id, target.id, [q.id]);
    const rater = await w.person('评价者甲');
    await w.appraiser(created.id, object.id, rater.id, 'superior');
    await w.transition(created.id, 'enable');
    const page = await w.ok<{ appraiser: { name?: string }; tasks: { role: { name?: string } }[] }>(
      w.link(await w.token(created.id, rater.id))('GET', ''),
    );
    expect(page.appraiser.name).toBe('评价者甲');
    expect(page.tasks[0]!.role.name).toBe(w.roles.find((r) => r.code === 'superior')!.name);
  });
});

describe('DEC-280⑤ 人员表可见范围', () => {
  it('默认：一般管理员看全部人员，手机号原样（不单独脱敏）', async () => {
    const w = await world360(testDb().db, 'd280j');
    const { general } = await team(w);
    const person = await w.person('外部人员', { mobile: '10000000001' });
    const list = await w.ok<{ items: PersonView[] }>(w.as(general)('GET', '/people'));
    expect(list.items.find((p) => p.id === person.id)?.mobile).toBe('10000000001');
    expect((await w.ok<PersonView>(w.as(general)('GET', `/people/${person.id}`))).mobile).toBe('10000000001');
  });

  it('开启精细化权限：只有系统管理员能开；开启后一般管理员只见数据范围内挂接员工的人员，外部人员与范围外 404', async () => {
    const w = await world360(testDb().db, 'd280k');
    const { general } = await team(w);
    const hire = async (name: string) => {
      const org = await w.session.org(`${name}部门`, { establishedOn: '2025-01-01' });
      const employee = await w.session.employee(name);
      await w.session.business(
        employee.id,
        { kind: 'hire', mode: 'direct', effectiveDate: '2025-01-01', fields: { departmentId: org.id } },
        employee.revision,
      );
      return { org, employee };
    };
    const inside = await hire('范围内');
    await hire('范围外');
    await w.ok(w.request('POST', '/people/sync', { body: {} }));
    const external = await w.person('外部人员');
    const all = (await w.ok<{ items: PersonView[] }>(w.request('GET', '/people?pageSize=200'))).items;
    const insidePerson = all.find((p) => p.employeeId === inside.employee.id)!;
    const outside = all.find((p) => p.employeeId && p.employeeId !== inside.employee.id)!;
    expect((await w.ok<{ items: PersonView[] }>(w.as(general)('GET', '/people?pageSize=200'))).items).toHaveLength(3);

    const settings = await w.ok<{ finePermission: boolean; revision: number }>(w.request('GET', '/settings'));
    expect(settings.finePermission).toBe(false);
    const denied = await w.as(general)('PUT', '/settings', {
      ifMatch: settings.revision,
      body: { finePermission: true },
    });
    expect(denied.status).toBe(403);
    await w.ok(w.request('PUT', '/settings', { ifMatch: settings.revision, body: { finePermission: true } }));
    // 一般管理员在 360 应用上的数据权限：一个只含“范围内”部门的管理单元（用户 × 应用，DEC-043）
    const mou = await w.ok<{ id: string }>(
      w.enterprise('POST', '/mous', {
        ifMatch: 0,
        body: { code: 'mou360', name: '360范围', orgRanges: [{ orgId: inside.org.id, includeDescendants: true }] },
      }),
      201,
    );
    const scope = await w.enterprise('PUT', `/scopes/${general}/${survey360.SURVEY360_APP}`, {
      ifMatch: 0,
      body: { kind: 'mou', mouId: mou.id },
    });
    expect(scope.status, await scope.clone().text()).toBe(200);

    const g = w.as(general);
    const visible = (await w.ok<{ items: PersonView[] }>(g('GET', '/people?pageSize=200'))).items;
    expect(visible.map((p) => p.id)).toEqual([insidePerson.id]);
    expect((await g('GET', `/people/${outside.id}`)).status).toBe(404);
    expect((await g('GET', `/people/${external.id}`)).status).toBe(404);
    const edit = await g('PUT', `/people/${external.id}`, { ifMatch: external.revision, body: { name: '改' } });
    expect(edit.status).toBe(404);
    expect(await errorCode(edit)).toBe('NOT_FOUND');
    // 系统管理员不受精细化权限影响
    expect((await w.ok<{ items: PersonView[] }>(w.request('GET', '/people?pageSize=200'))).items).toHaveLength(3);
  });
});
