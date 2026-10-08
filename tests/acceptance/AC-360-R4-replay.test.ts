/**
 * PR #107 第 4 轮修改清单第一步（DEC-297③，评论 6050983318）：表驱动反向用例的第四类——成功后收窄范围，再用原幂等键
 * 重放。每个实际注册的 360 写路由一条：先以范围内的身份成功执行，再收窄它的范围（精细化下的（用户 × Survey360）人员
 * 范围、活动授权、编辑他人套卷按钮、全部活动按钮、链接令牌指向的关系 / 确认单），用同一幂等键重放——
 * 结果必须与新命令在当前范围下的判定一致：资源不在范围内即同一错误码，回执里范围外的条目去掉，不返回历史结果。
 * 用例表的键取自实际注册的写路由：缺用例即失败；不适用只限不引用任何受范围约束资源的租户级配置，并写明原因。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { survey360 } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { loginEmailOf } from './AC-EMP-support.js';
import {
  BASE,
  fullAccess,
  LINK,
  type ObjectPermissionBody,
  type PersonView,
  type QuestionnaireView,
  world360,
  type World360,
} from './AC-360-support.js';

const testDb = useTestDb();
const OBJ = survey360.SURVEY360_OBJECTS;
const APP = survey360.SURVEY360_APP;
const S = BASE;

type Key = keyof typeof OBJ;
interface Spec {
  readonly object: Key;
  readonly ops?: Partial<Record<'create' | 'update' | 'delete', boolean>>;
  readonly buttons?: readonly string[];
}

function perm(spec: Spec): ObjectPermissionBody {
  const definition = OBJ[spec.object];
  const buttons = definition.buttons as readonly { code: string; level: string }[];
  return {
    objectCode: definition.code,
    dataOperations: { create: false, update: false, delete: false, ...spec.ops },
    fields: definition.fields.map((f) => ({ fieldCode: f.code, view: true, edit: !f.system })),
    buttons: (spec.buttons ?? []).map((code) => ({
      buttonCode: code,
      level: buttons.find((b) => b.code === code)!.level,
    })),
  } as ObjectPermissionBody;
}

const ALL = { create: true, update: true, delete: true } as const;
const buttonsOf = (object: Key) => (OBJ[object].buttons as readonly { code: string }[]).map((b) => b.code);

interface Env {
  /** 主世界：已开启精细化权限；甲、乙两个部门各两名已同步员工（乙二的上级是乙一）。 */
  readonly w: World360;
  /** 同步类用例的世界（同步会处理全部员工，与主世界隔开）：同样开启精细化。 */
  readonly sw: World360;
  readonly orgs: { a: string; b: string };
  readonly swOrgs: { a: string; b: string };
  /** 管理单元：wide = 甲 + 乙，narrow = 只有甲（收窄即把用户的 Survey360 范围从 wide 换成 narrow）。 */
  readonly mous: Mous;
  readonly swMous: Mous;
  readonly people: Record<'a1' | 'a2' | 'b1' | 'b2', PersonView>;
  readonly q: QuestionnaireView;
  readonly swq: QuestionnaireView;
}

async function hire(w: World360, name: string, orgId: string, managerId?: string) {
  const employee = await w.session.employee(name);
  await w.session.business(
    employee.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2025-01-01',
      fields: { departmentId: orgId, ...(managerId ? { directManagerId: managerId } : {}) },
    },
    employee.revision,
  );
  return employee;
}

/** 系统管理员同步后，按员工取其 360 人员。 */
async function synced(w: World360, employeeIds: readonly string[]) {
  await w.ok(w.request('POST', '/people/sync', { body: {} }));
  const listed = (await w.ok<{ items: PersonView[] }>(w.request('GET', '/people?pageSize=200'))).items;
  return employeeIds.map((id) => listed.find((p) => p.employeeId === id)!);
}

async function finePermissionOn(w: World360) {
  const settings = await w.ok<{ revision: number }>(w.request('GET', '/settings'));
  await w.ok(w.request('PUT', '/settings', { ifMatch: settings.revision, body: { finePermission: true } }));
}

interface Mous {
  readonly wide: string;
  readonly narrow: string;
}

async function mous(w: World360, a: string, b: string): Promise<Mous> {
  const create = async (code: string, orgIds: readonly string[]) =>
    (
      await w.ok<{ id: string }>(
        w.enterprise('POST', '/mous', {
          ifMatch: 0,
          body: { code, name: code, orgRanges: orgIds.map((orgId) => ({ orgId, includeDescendants: true })) },
        }),
        201,
      )
    ).id;
  return { wide: await create('mou-wide', [a, b]), narrow: await create('mou-narrow', [a]) };
}

/** 360 高级管理员（没有“全部活动”，精细化下受限），（用户 × Survey360）范围为 wide；narrow() 换成只有甲的范围。 */
async function restricted(w: World360, name: string, scope: Mous) {
  const user = await w.member(name);
  await w.appoint(user, 'advanced');
  const assigned = await w.ok<{ revision: number }>(
    w.enterprise('PUT', `/scopes/${user}/${APP}`, { ifMatch: 0, body: { kind: 'mou', mouId: scope.wide } }),
  );
  const narrow = () =>
    w.ok(
      w.enterprise('PUT', `/scopes/${user}/${APP}`, {
        ifMatch: assigned.revision,
        body: { kind: 'mou', mouId: scope.narrow },
      }),
    );
  return { user, as: w.as(user), narrow };
}

/** 主世界里受限的管理员：范围甲 + 乙，收窄后只剩甲；带一个自己创建的活动。 */
async function scene(env: Env, name: string) {
  const r = await restricted(env.w, name, env.mous);
  const activity = await env.w.activity({ name: `${name}的活动` }, r.user);
  return { ...r, activity };
}

/** 自定义 360 身份授给新成员；setObjects 改该身份的对象权限（模拟撤掉按钮）。 */
async function custom(w: World360, name: string, specs: readonly Spec[]) {
  const profile = await w.defineProfile(name, specs.map(perm));
  const user = await w.member(name);
  await w.grantProfile(user, profile);
  const setObjects = async (changed: readonly Spec[]) => {
    for (const { objectCode, ...body } of changed.map(perm)) {
      const current = await w.ok<{ revision: number }>(w.enterprise('GET', `/profiles/${profile}`));
      await w.ok(
        w.enterprise('PUT', `/profiles/${profile}/objects/${objectCode}`, { ifMatch: current.revision, body }),
      );
    }
  };
  return { user, as: w.as(user), setObjects };
}

/** 360 高级管理员，经活动授权看到 activityId；revoke() 由系统管理员撤销这条活动授权。 */
async function grantee(w: World360, name: string, activityId: string) {
  const user = await w.member(name);
  await w.appoint(user, 'advanced');
  await grant(w, activityId, [user]);
  const revoke = async () => {
    const current = await w.getActivity(activityId);
    await w.ok(w.request('DELETE', `/activities/${activityId}/grants/${user}`, { ifMatch: current.revision }));
  };
  return { user, as: w.as(user), revoke };
}

async function grant(w: World360, activityId: string, userIds: readonly string[]) {
  const current = await w.getActivity(activityId);
  await w.ok(w.request('POST', `/activities/${activityId}/grants`, { ifMatch: current.revision, body: { userIds } }));
}

const expectStatus = async (res: Response | Promise<Response>, status: number) => {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  return r;
};
const errorOf = async (res: Response) =>
  ((await res.clone().json()) as { error: { code: string; details?: Record<string, unknown> } }).error;
const reasonOf = async (res: Response) => (await errorOf(res)).details?.reason;

/** 同一幂等键：先成功一次（status），再收窄（narrow），再重放；返回重放响应。 */
async function replayAfter(
  call: (key: string) => Promise<Response>,
  status: number,
  narrow: () => Promise<unknown>,
): Promise<Response> {
  const key = randomUUID();
  await expectStatus(call(key), status);
  await narrow();
  return call(key);
}

/** 链接令牌：取自 outbox 里该确认单的邀请邮件。 */
async function confirmToken(w: World360, confirmationId: string) {
  const result = await withTenant(w.db, w.tenantId, (tx) =>
    tx.execute(sql`SELECT payload->>'token' AS token FROM survey360_outbox
      WHERE event_type = 'survey360.confirm_invitation' AND payload->>'confirmationId' = ${confirmationId}`),
  );
  const list = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { token: string }[];
  expect(list).toHaveLength(1);
  return list[0]!.token;
}

/** 系统管理员建的活动：外部人员作评价对象 + 一名同事评价者，可选启用。 */
async function linkScene(env: Env, enable: boolean) {
  const { w, q } = env;
  const activity = await w.activity({ name: `链接${randomUUID().slice(0, 4)}` });
  const target = await w.person('链接对象');
  const object = await w.object(activity.id, target.id, [q.id]);
  const rater = await w.person('链接评价者');
  const relation = await w.appraiser(activity.id, object.id, rater.id, 'peer');
  if (enable) await w.transition(activity.id, 'enable');
  return { activity, object, relation, rater };
}

/** 系统管理员移除一条评价关系（作答令牌随之找不到任务）。 */
async function removeRelation(w: World360, activityId: string, objectId: string, relationId: string) {
  const list = await w.ok<{ items: { id: string; revision: number }[] }>(
    w.request('GET', `/activities/${activityId}/objects/${objectId}/appraisers`),
  );
  const revision = list.items.find((r) => r.id === relationId)!.revision;
  await w.ok(
    w.request('DELETE', `/activities/${activityId}/objects/${objectId}/appraisers/${relationId}`, {
      ifMatch: revision,
    }),
  );
}

/** 系统管理员移除评价对象（其确认单作废、确认链接失效）。 */
async function removeObject(w: World360, activityId: string, objectId: string) {
  const list = await w.ok<{ items: { id: string; revision: number }[] }>(
    w.request('GET', `/activities/${activityId}/objects`),
  );
  const revision = list.items.find((o) => o.id === objectId)!.revision;
  await w.ok(w.request('DELETE', `/activities/${activityId}/objects/${objectId}`, { ifMatch: revision }));
}

/** 确认场景：外部对象（上级为外部人员）邀请上级确认，返回确认链接。 */
async function confirmScene(env: Env) {
  const { w, q } = env;
  const activity = await w.activity({ name: `确认${randomUUID().slice(0, 4)}` });
  const boss = await w.person('确认上级');
  const target = await w.person('确认对象');
  await w.ok(
    w.request('PUT', `/people/${target.id}`, { ifMatch: target.revision, body: { superiorPersonId: boss.id } }),
  );
  const object = await w.object(activity.id, target.id, [q.id]);
  const invited = await w.ok<{ id: string }>(
    w.request('POST', `/activities/${activity.id}/objects/${object.id}/confirmation`, { ifMatch: 0, body: {} }),
    201,
  );
  const link = w.link(await confirmToken(w, invited.id));
  const revision = async () =>
    ((await (await expectStatus(link('GET', ''), 200)).json()) as { revision: number }).revision;
  return { activity, object, link, revision };
}

const customer = () => ({ name: '客户', email: `cust-${randomUUID().slice(0, 8)}@example.com` });

type Case = (env: Env) => Promise<void>;
interface NotApplicable {
  readonly na: string;
}

const CONFIG = '租户级配置，不引用任何受数据范围约束的资源（人员、评价对象、活动、员工）；功能权限撤销后的重放由路由层';

/** 用例表：键 = 方法 + 实际注册路径（只含写路由）。 */
const REPLAY_CASES: Record<string, Case | NotApplicable> = {
  [`PUT ${S}/settings`]: { na: `${CONFIG} objectContext / button 拦截（未授权类同一守卫）` },
  [`POST ${S}/roles`]: { na: `${CONFIG} objectContext / button 拦截（未授权类同一守卫）` },
  [`PUT ${S}/roles/:id`]: { na: `${CONFIG} objectContext / button 拦截（未授权类同一守卫）` },
  [`POST ${S}/questionnaires`]: { na: `新建套卷：${CONFIG} objectContext / button 拦截` },
  [`POST ${S}/activities`]: { na: `新建活动：${CONFIG} objectContext / button 拦截；活动由本人创建，本人始终可见` },

  [`POST ${S}/people/sync`]: async (env) => {
    const { sw } = env;
    const r = await restricted(sw, '同步管理员', env.swMous);
    const newcomer = await hire(sw, '乙部门新员工', env.swOrgs.b);
    const key = randomUUID();
    const sync = () => r.as('POST', '/people/sync', { idempotencyKey: key, body: {} });
    const first = (await (await expectStatus(sync(), 200)).json()) as { created: { employeeId: string }[] };
    expect(first.created.map((c) => c.employeeId)).toContain(newcomer.id);
    const [person] = await synced(sw, [newcomer.id]);
    await r.narrow();
    const replay = await expectStatus(sync(), 200);
    const text = await replay.text();
    expect(text).not.toContain(newcomer.id);
    expect(text).not.toContain(person!.id);
  },
  [`POST ${S}/people/sync-conflicts/:id/resolve`]: async (env) => {
    const { sw } = env;
    // 持“全部活动”时不受精细化限制，可挂接到外部候选；撤掉该按钮后受限且没有人员范围
    const u = await custom(sw, '冲突处理人', [
      { object: 'activity', buttons: [survey360.SURVEY360_BUTTONS.allActivities] },
      { object: 'person', buttons: [survey360.SURVEY360_BUTTONS.sync] },
    ]);
    const employee = await hire(sw, '冲突员工', env.swOrgs.a);
    const external = await sw.ok<PersonView>(
      sw.request('POST', '/people', { ifMatch: 0, body: { name: '外部同邮箱', email: loginEmailOf(employee.id) } }),
      201,
    );
    await sw.ok(sw.request('POST', '/people/sync', { body: {} }));
    const conflicts = await sw.ok<{ items: { id: string; employeeId: string; revision: number }[] }>(
      sw.request('GET', '/people/sync-conflicts'),
    );
    const conflict = conflicts.items.find((c) => c.employeeId === employee.id)!;
    const resolve = (key: string) =>
      u.as('POST', `/people/sync-conflicts/${conflict.id}/resolve`, {
        ifMatch: conflict.revision,
        idempotencyKey: key,
        body: { action: 'link', personId: external.id },
      });
    const replay = await replayAfter(resolve, 200, () =>
      u.setObjects([{ object: 'activity' }, { object: 'person', buttons: [survey360.SURVEY360_BUTTONS.sync] }]),
    );
    expect(await reasonOf(await expectStatus(replay, 400))).toBe('NOT_A_CANDIDATE');
    expect(await replay.text()).not.toContain(external.id);
  },
  [`POST ${S}/people`]: async (env) => {
    const { w } = env;
    const u = await custom(w, '建人员', [
      { object: 'activity', buttons: [survey360.SURVEY360_BUTTONS.allActivities] },
      { object: 'person', ops: { create: true }, buttons: ['create'] },
    ]);
    const create = (key: string) =>
      u.as('POST', '/people', {
        ifMatch: 0,
        idempotencyKey: key,
        body: { ...customer(), email: `new-${key.slice(0, 8)}@example.com`, superiorPersonId: env.people.b1.id },
      });
    const replay = await replayAfter(create, 201, () =>
      u.setObjects([{ object: 'activity' }, { object: 'person', ops: { create: true }, buttons: ['create'] }]),
    );
    expect(await reasonOf(await expectStatus(replay, 403))).toBe('PERSON_NOT_AVAILABLE');
  },
  [`PUT ${S}/people/:id`]: async (env) => {
    const { w } = env;
    const s = await scene(env, '改上级');
    const employee = await hire(w, '甲部门下属', env.orgs.a);
    const [person] = await synced(w, [employee.id]);
    const update = (key: string, revision: number) =>
      s.as('PUT', `/people/${person!.id}`, {
        ifMatch: revision,
        idempotencyKey: key,
        body: { superiorPersonId: env.people.b1.id },
      });
    const key = randomUUID();
    const saved = (await (await expectStatus(update(key, person!.revision), 200)).json()) as { revision: number };
    await s.narrow();
    // 重放与新命令同一判定：上级不在当前范围内即“上级人员不存在”，不返回带范围外上级的历史结果
    const replay = await expectStatus(update(key, person!.revision), 400);
    expect(await reasonOf(replay)).toBe('SUPERIOR_NOT_FOUND');
    expect(await replay.text()).not.toContain(env.people.b1.id);
    expect(await reasonOf(await expectStatus(update(randomUUID(), saved.revision), 400))).toBe('SUPERIOR_NOT_FOUND');
  },

  [`PUT ${S}/questionnaires/:id`]: async (env) => {
    const { w } = env;
    const u = await custom(w, '改他人套卷', [
      { object: 'questionnaire', ops: ALL, buttons: buttonsOf('questionnaire') },
    ]);
    const q = await w.keyBehavior();
    const replay = await replayAfter(
      (key) =>
        u.as('PUT', `/questionnaires/${q.id}`, { ifMatch: q.revision, idempotencyKey: key, body: { name: '改名' } }),
      200,
      () => u.setObjects([{ object: 'questionnaire', ops: ALL, buttons: ['create', 'update', 'delete', 'enable'] }]),
    );
    expect(await reasonOf(await expectStatus(replay, 403))).toBe('QUESTIONNAIRE_NOT_OWNER');
  },
  [`POST ${S}/questionnaires/:id/enable`]: async (env) => {
    const { w } = env;
    const u = await custom(w, '启用他人套卷', [
      { object: 'questionnaire', ops: ALL, buttons: buttonsOf('questionnaire') },
    ]);
    const q = await w.keyBehavior();
    const replay = await replayAfter(
      (key) => u.as('POST', `/questionnaires/${q.id}/enable`, { ifMatch: q.revision, idempotencyKey: key }),
      200,
      () => u.setObjects([{ object: 'questionnaire', ops: ALL, buttons: ['create', 'update', 'delete', 'enable'] }]),
    );
    expect(await reasonOf(await expectStatus(replay, 403))).toBe('QUESTIONNAIRE_NOT_OWNER');
  },
  [`DELETE ${S}/questionnaires/:id`]: async (env) => {
    const { w } = env;
    const u = await custom(w, '删他人套卷', [
      { object: 'questionnaire', ops: ALL, buttons: buttonsOf('questionnaire') },
    ]);
    const q = await w.keyBehavior();
    const replay = await replayAfter(
      (key) => u.as('DELETE', `/questionnaires/${q.id}`, { ifMatch: q.revision, idempotencyKey: key }),
      200,
      () => u.setObjects([{ object: 'questionnaire', ops: ALL, buttons: ['create', 'update', 'delete', 'enable'] }]),
    );
    expect(await reasonOf(await expectStatus(replay, 403))).toBe('QUESTIONNAIRE_NOT_OWNER');
  },

  [`PUT ${S}/activities/:id`]: async (env) => {
    const { w } = env;
    const activity = await w.activity({ name: '授权后改名' });
    const g = await grantee(w, '改活动', activity.id);
    const current = await w.getActivity(activity.id);
    const replay = await replayAfter(
      (key) =>
        g.as('PUT', `/activities/${activity.id}`, {
          ifMatch: current.revision,
          idempotencyKey: key,
          body: { name: '新名称' },
        }),
      200,
      g.revoke,
    );
    await expectStatus(replay, 404);
  },
  [`DELETE ${S}/activities/:id`]: async (env) => {
    const { w } = env;
    const activity = await w.activity({ name: '授权后删除' });
    const g = await grantee(w, '删活动', activity.id);
    const current = await w.getActivity(activity.id);
    // 活动删除后接口不再允许改授权：直接删授权行模拟撤销
    const revoke = () =>
      withTenant(w.db, w.tenantId, (tx) =>
        tx.execute(sql`DELETE FROM survey360_activity_grants WHERE activity_id = ${activity.id}::uuid
          AND user_id = ${g.user}::uuid`),
      );
    const replay = await replayAfter(
      (key) => g.as('DELETE', `/activities/${activity.id}`, { ifMatch: current.revision, idempotencyKey: key }),
      200,
      revoke,
    );
    await expectStatus(replay, 404);
  },
  [`POST ${S}/activities/:id/enable`]: async (env) => {
    const s = await linkScene(env, false);
    const g = await grantee(env.w, '启用活动', s.activity.id);
    const current = await env.w.getActivity(s.activity.id);
    const replay = await replayAfter(
      (key) => g.as('POST', `/activities/${s.activity.id}/enable`, { ifMatch: current.revision, idempotencyKey: key }),
      200,
      g.revoke,
    );
    await expectStatus(replay, 404);
  },
  [`POST ${S}/activities/:id/disable`]: async (env) => {
    const s = await linkScene(env, true);
    const g = await grantee(env.w, '停用活动', s.activity.id);
    const current = await env.w.getActivity(s.activity.id);
    const replay = await replayAfter(
      (key) => g.as('POST', `/activities/${s.activity.id}/disable`, { ifMatch: current.revision, idempotencyKey: key }),
      200,
      g.revoke,
    );
    await expectStatus(replay, 404);
  },
  [`POST ${S}/activities/:id/grants`]: async (env) => {
    const { w } = env;
    const activity = await w.activity({ name: '授权他人' });
    const g = await grantee(w, '加授权', activity.id);
    const other = await w.member('被加授权');
    await w.appoint(other, 'general');
    const current = await w.getActivity(activity.id);
    const replay = await replayAfter(
      (key) =>
        g.as('POST', `/activities/${activity.id}/grants`, {
          ifMatch: current.revision,
          idempotencyKey: key,
          body: { userIds: [other] },
        }),
      200,
      g.revoke,
    );
    await expectStatus(replay, 404);
  },
  [`DELETE ${S}/activities/:id/grants/:userId`]: async (env) => {
    const { w } = env;
    const activity = await w.activity({ name: '移除授权' });
    const g = await grantee(w, '减授权', activity.id);
    const other = await w.member('被移除授权');
    await w.appoint(other, 'general');
    await grant(w, activity.id, [other]);
    const current = await w.getActivity(activity.id);
    const replay = await replayAfter(
      (key) =>
        g.as('DELETE', `/activities/${activity.id}/grants/${other}`, {
          ifMatch: current.revision,
          idempotencyKey: key,
        }),
      200,
      g.revoke,
    );
    await expectStatus(replay, 404);
  },

  [`POST ${S}/activities/:id/objects`]: async (env) => {
    const s = await scene(env, '录对象');
    const path = `/activities/${s.activity.id}/objects`;
    const byId = (key: string) =>
      s.as('POST', path, {
        ifMatch: 0,
        idempotencyKey: key,
        body: { personId: env.people.b1.id, questionnaireIds: [env.q.id] },
      });
    const byEmail = (key: string) =>
      s.as('POST', path, {
        ifMatch: 0,
        idempotencyKey: key,
        body: { person: { name: '乙二', email: env.people.b2.email }, questionnaireIds: [env.q.id] },
      });
    const [k1, k2] = [randomUUID(), randomUUID()];
    await expectStatus(byId(k1), 201);
    await expectStatus(byEmail(k2), 201);
    await s.narrow();
    // 选人：人员不在当前范围内，重放与新命令一样 404；录入邮箱属范围外人员：与新命令一样 403
    const replayById = await expectStatus(byId(k1), 404);
    expect(await replayById.text()).not.toContain(env.people.b1.id);
    await expectStatus(byId(randomUUID()), 404);
    const replayByEmail = await expectStatus(byEmail(k2), 403);
    expect(await reasonOf(replayByEmail)).toBe('PERSON_NOT_AVAILABLE');
    expect(await replayByEmail.text()).not.toContain(env.people.b2.id);
  },
  [`PUT ${S}/activities/:id/objects/:objectId/questionnaires`]: async (env) => {
    const s = await scene(env, '换套卷');
    const object = await env.w.ok<{ id: string; revision: number }>(
      s.as('POST', `/activities/${s.activity.id}/objects`, {
        ifMatch: 0,
        body: { personId: env.people.b1.id, questionnaireIds: [env.q.id] },
      }),
      201,
    );
    const replay = await replayAfter(
      (key) =>
        s.as('PUT', `/activities/${s.activity.id}/objects/${object.id}/questionnaires`, {
          ifMatch: object.revision,
          idempotencyKey: key,
          body: { questionnaireIds: [env.q.id] },
        }),
      200,
      s.narrow,
    );
    await expectStatus(replay, 404);
  },
  [`DELETE ${S}/activities/:id/objects/:objectId`]: async (env) => {
    const s = await scene(env, '移除对象');
    const object = await env.w.ok<{ id: string; revision: number }>(
      s.as('POST', `/activities/${s.activity.id}/objects`, {
        ifMatch: 0,
        body: { personId: env.people.b1.id, questionnaireIds: [env.q.id] },
      }),
      201,
    );
    const replay = await replayAfter(
      (key) =>
        s.as('DELETE', `/activities/${s.activity.id}/objects/${object.id}`, {
          ifMatch: object.revision,
          idempotencyKey: key,
        }),
      200,
      s.narrow,
    );
    await expectStatus(replay, 404);
  },
  [`POST ${S}/activities/:id/objects/:objectId/appraisers`]: async (env) => {
    const s = await scene(env, '加评价者');
    const object = await env.w.ok<{ id: string }>(
      s.as('POST', `/activities/${s.activity.id}/objects`, {
        ifMatch: 0,
        body: { personId: env.people.a1.id, questionnaireIds: [env.q.id] },
      }),
      201,
    );
    const path = `/activities/${s.activity.id}/objects/${object.id}/appraisers`;
    const byId = (key: string) =>
      s.as('POST', path, {
        ifMatch: 0,
        idempotencyKey: key,
        body: { personId: env.people.b1.id, roleId: env.w.role('peer') },
      });
    const byEmail = (key: string) =>
      s.as('POST', path, {
        ifMatch: 0,
        idempotencyKey: key,
        body: { person: { name: '乙二', email: env.people.b2.email }, roleId: env.w.role('customer') },
      });
    const [k1, k2] = [randomUUID(), randomUUID()];
    await expectStatus(byId(k1), 201);
    await expectStatus(byEmail(k2), 201);
    await s.narrow();
    const replayById = await expectStatus(byId(k1), 404);
    expect(await replayById.text()).not.toContain(env.people.b1.id);
    await expectStatus(byId(randomUUID()), 404);
    const replayByEmail = await expectStatus(byEmail(k2), 403);
    expect(await reasonOf(replayByEmail)).toBe('PERSON_NOT_AVAILABLE');
    expect(await replayByEmail.text()).not.toContain(env.people.b2.id);
  },
  [`DELETE ${S}/activities/:id/objects/:objectId/appraisers/:relationId`]: async (env) => {
    const s = await scene(env, '删评价者');
    const object = await env.w.ok<{ id: string }>(
      s.as('POST', `/activities/${s.activity.id}/objects`, {
        ifMatch: 0,
        body: { personId: env.people.a1.id, questionnaireIds: [env.q.id] },
      }),
      201,
    );
    const relation = await env.w.ok<{ id: string; revision: number }>(
      s.as('POST', `/activities/${s.activity.id}/objects/${object.id}/appraisers`, {
        ifMatch: 0,
        body: { personId: env.people.b1.id, roleId: env.w.role('peer') },
      }),
      201,
    );
    const replay = await replayAfter(
      (key) =>
        s.as('DELETE', `/activities/${s.activity.id}/objects/${object.id}/appraisers/${relation.id}`, {
          ifMatch: relation.revision,
          idempotencyKey: key,
        }),
      200,
      s.narrow,
    );
    await expectStatus(replay, 404);
  },
  [`POST ${S}/activities/:id/objects/:objectId/appraisers/auto`]: async (env) => {
    const { sw } = env;
    const r = await restricted(sw, '自动添加', env.swMous);
    const manager = await hire(sw, '乙部门经理', env.swOrgs.b);
    const target = await hire(sw, '甲部门对象', env.swOrgs.a, manager.id);
    const peer = await hire(sw, '甲部门同事', env.swOrgs.a, manager.id);
    const [mp, tp, pp] = await synced(sw, [manager.id, target.id, peer.id]);
    const activity = await sw.activity({ name: '自动添加活动' }, r.user);
    const object = await sw.ok<{ id: string }>(
      r.as('POST', `/activities/${activity.id}/objects`, {
        ifMatch: 0,
        body: { personId: tp!.id, questionnaireIds: [env.swq.id] },
      }),
      201,
    );
    const key = randomUUID();
    const auto = () =>
      r.as('POST', `/activities/${activity.id}/objects/${object.id}/appraisers/auto`, {
        ifMatch: 0,
        idempotencyKey: key,
        body: { roles: ['superior', 'peer'] },
      });
    const first = (await (await expectStatus(auto(), 200)).json()) as { added: { appraiserPersonId: string }[] };
    expect(first.added.map((a) => a.appraiserPersonId).sort()).toEqual([mp!.id, pp!.id].sort());
    await r.narrow();
    const replay = (await (await expectStatus(auto(), 200)).json()) as { added: { appraiserPersonId: string }[] };
    expect(replay.added.map((a) => a.appraiserPersonId)).toEqual([pp!.id]);
    expect(JSON.stringify(replay)).not.toContain(mp!.id);
    expect(JSON.stringify(replay)).not.toContain(manager.id);
  },
  [`POST ${S}/activities/:id/appraisers/import`]: async (env) => {
    const s = await scene(env, '导入');
    for (const person of [env.people.a1, env.people.b1])
      await expectStatus(
        s.as('POST', `/activities/${s.activity.id}/objects`, {
          ifMatch: 0,
          body: { personId: person.id, questionnaireIds: [env.q.id] },
        }),
        201,
      );
    const row = (objectEmail: string, email: string) => ({
      objectEmail,
      roleId: env.w.role('customer'),
      name: '导入评价者',
      email,
    });
    const importRows = (key: string, rows: object[]) =>
      s.as('POST', `/activities/${s.activity.id}/appraisers/import`, {
        ifMatch: 0,
        idempotencyKey: key,
        body: { sync: true, rows },
      });
    // 行 1：乙部门的评价对象；行 2：乙部门的评价者（都是范围内已有人员，受限管理员可复用）
    const objectRows = [row(env.people.b1.email, env.people.a2.email)];
    const appraiserRows = [row(env.people.a1.email, env.people.b2.email)];
    const [k1, k2] = [randomUUID(), randomUUID()];
    await expectStatus(importRows(k1, objectRows), 200);
    await expectStatus(importRows(k2, appraiserRows), 200);
    await s.narrow();
    const rowReasons = async (res: Response) =>
      ((await errorOf(res)).details?.errors as { row: number; details: { reason: string } }[]).map((e) => [
        e.row,
        e.details.reason,
      ]);
    const replayObject = await expectStatus(importRows(k1, objectRows), 400);
    expect(await reasonOf(replayObject)).toBe('IMPORT_INVALID');
    expect(await rowReasons(replayObject)).toEqual([[1, 'OBJECT_NOT_FOUND']]);
    expect(await replayObject.text()).not.toContain('relationId');
    expect(await rowReasons(await expectStatus(importRows(randomUUID(), objectRows), 400))).toEqual([
      [1, 'OBJECT_NOT_FOUND'],
    ]);
    const replayAppraiser = await expectStatus(importRows(k2, appraiserRows), 400);
    expect(await rowReasons(replayAppraiser)).toEqual([[1, 'PERSON_NOT_AVAILABLE']]);
  },
  [`POST ${S}/activities/:id/objects/:objectId/confirmation`]: async (env) => {
    const s = await scene(env, '邀请确认');
    // 乙二的上级是乙一（同步写入）：对象与确认人都在乙部门
    const object = await env.w.ok<{ id: string }>(
      s.as('POST', `/activities/${s.activity.id}/objects`, {
        ifMatch: 0,
        body: { personId: env.people.b2.id, questionnaireIds: [env.q.id] },
      }),
      201,
    );
    const replay = await replayAfter(
      (key) =>
        s.as('POST', `/activities/${s.activity.id}/objects/${object.id}/confirmation`, {
          ifMatch: 0,
          idempotencyKey: key,
          body: {},
        }),
      201,
      s.narrow,
    );
    await expectStatus(replay, 404);
    expect(await replay.text()).not.toContain(env.people.b1.id);
  },

  [`PUT ${LINK}/tasks/:relationId/questionnaires/:questionnaireId`]: async (env) => {
    const { w, q } = env;
    const s = await linkScene(env, true);
    const link = w.link(await w.token(s.activity.id, s.rater.id));
    const options = q.scales[0]!.options;
    const answers = q.questions.map((question) => ({ itemId: question.id, optionId: options[0]!.id }));
    const replay = await replayAfter(
      (key) =>
        link('PUT', `/tasks/${s.relation.id}/questionnaires/${q.id}`, {
          ifMatch: 0,
          idempotencyKey: key,
          body: { answers },
        }),
      200,
      () => removeRelation(w, s.activity.id, s.object.id, s.relation.id),
    );
    await expectStatus(replay, 404);
  },
  [`POST ${LINK}/tasks/:relationId/questionnaires/:questionnaireId/submit`]: async (env) => {
    const { w, q } = env;
    const s = await linkScene(env, true);
    const token = await w.token(s.activity.id, s.rater.id);
    const saved = await w.answer(token, s.relation.id, q, ['v4', 'v4'], false);
    const link = w.link(token);
    const replay = await replayAfter(
      (key) =>
        link('POST', `/tasks/${s.relation.id}/questionnaires/${q.id}/submit`, {
          ifMatch: (saved as { revision: number }).revision,
          idempotencyKey: key,
        }),
      200,
      () => removeRelation(w, s.activity.id, s.object.id, s.relation.id),
    );
    await expectStatus(replay, 404);
  },
  [`POST ${LINK}/confirmation/appraisers`]: async (env) => {
    const s = await confirmScene(env);
    const revision = await s.revision();
    // 先冻结输入：同键同内容才是重放（第 4 轮审查 P3）
    const body = { person: customer(), roleId: env.w.role('customer') };
    const replay = await replayAfter(
      (key) => s.link('POST', '/confirmation/appraisers', { ifMatch: revision, idempotencyKey: key, body }),
      201,
      () => removeObject(env.w, s.activity.id, s.object.id),
    );
    await expectStatus(replay, 404);
  },
  [`DELETE ${LINK}/confirmation/appraisers/:relationId`]: async (env) => {
    const s = await confirmScene(env);
    const added = (await (
      await expectStatus(
        s.link('POST', '/confirmation/appraisers', {
          ifMatch: await s.revision(),
          body: { person: customer(), roleId: env.w.role('customer') },
        }),
        201,
      )
    ).json()) as { id: string };
    const revision = await s.revision();
    const replay = await replayAfter(
      (key) => s.link('DELETE', `/confirmation/appraisers/${added.id}`, { ifMatch: revision, idempotencyKey: key }),
      200,
      () => removeObject(env.w, s.activity.id, s.object.id),
    );
    await expectStatus(replay, 404);
  },
  [`POST ${LINK}/confirmation/submit`]: async (env) => {
    const s = await confirmScene(env);
    const revision = await s.revision();
    const replay = await replayAfter(
      (key) => s.link('POST', '/confirmation/submit', { ifMatch: revision, idempotencyKey: key }),
      200,
      () => removeObject(env.w, s.activity.id, s.object.id),
    );
    await expectStatus(replay, 404);
  },
};

/** 只有这些写路由允许不适用（租户级配置）；其余都引用受范围约束的资源，必须给用例。 */
const CONFIG_ROUTES = new Set([
  `PUT ${S}/settings`,
  `POST ${S}/roles`,
  `PUT ${S}/roles/:id`,
  `POST ${S}/questionnaires`,
  `POST ${S}/activities`,
]);

async function buildEnv(): Promise<Env> {
  const w = await world360(testDb().db, 'replay', { access: fullAccess() });
  const a = await w.session.org('甲部门', { establishedOn: '2025-01-01' });
  const b = await w.session.org('乙部门', { establishedOn: '2025-01-01' });
  const a1 = await hire(w, '甲一', a.id);
  const a2 = await hire(w, '甲二', a.id, a1.id);
  const b1 = await hire(w, '乙一', b.id);
  const b2 = await hire(w, '乙二', b.id, b1.id);
  const [pa1, pa2, pb1, pb2] = await synced(w, [a1.id, a2.id, b1.id, b2.id]);
  const q = await w.enableQuestionnaire(await w.keyBehavior({ self: 0, superior: 1, peer: 1, customer: 1 }));
  await finePermissionOn(w);

  const sw = await world360(testDb().db, 'replay-sync', { access: fullAccess() });
  const sa = await sw.session.org('同步甲部门', { establishedOn: '2025-01-01' });
  const sb = await sw.session.org('同步乙部门', { establishedOn: '2025-01-01' });
  await hire(sw, '同步甲一', sa.id);
  await sw.ok(sw.request('POST', '/people/sync', { body: {} }));
  const swq = await sw.enableQuestionnaire(await sw.keyBehavior({ self: 0, superior: 1, peer: 1, customer: 1 }));
  await finePermissionOn(sw);
  return {
    w,
    sw,
    orgs: { a: a.id, b: b.id },
    swOrgs: { a: sa.id, b: sb.id },
    mous: await mous(w, a.id, b.id),
    swMous: await mous(sw, sa.id, sb.id),
    people: { a1: pa1!, a2: pa2!, b1: pb1!, b2: pb2! },
    q,
    swq,
  };
}

describe('路由 × 守卫第四类：成功后收窄范围，再用原幂等键重放（表驱动）', () => {
  let env: Env;
  beforeAll(async () => {
    env = await buildEnv();
  }, 600_000);

  it('写路由清单与用例表一一对应：引用受范围约束资源的写路由都有用例，不适用只限租户级配置并写明原因', () => {
    const registered = env.w.api.app.routes
      .filter((r) => !['ALL', 'GET'].includes(r.method))
      .map((r) => `${r.method} ${r.path}`)
      .filter((key) => key.includes('/survey360'));
    expect([...new Set(registered)].sort()).toEqual(Object.keys(REPLAY_CASES).sort());
    for (const [route, entry] of Object.entries(REPLAY_CASES)) {
      if (typeof entry === 'function') continue;
      expect(CONFIG_ROUTES.has(route), `${route} 引用受范围约束的资源，不能标不适用`).toBe(true);
      expect(entry.na.length, route).toBeGreaterThan(10);
    }
  });

  for (const [route, entry] of Object.entries(REPLAY_CASES))
    if (typeof entry === 'function') it(`收窄后重放｜${route}`, async () => entry(env), 120_000);
});
