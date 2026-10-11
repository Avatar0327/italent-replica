/**
 * 第 3 轮清单补充（总编排，评论 6045364496）：R3-T03 的每个路由都接公共守卫，并按路由清单表驱动生成三类反向用例——
 * 未授权（缺功能权限或只缺按钮）、超范围（目标对象 / 活动 / 员工 / 租户 / 令牌不在范围内）、字段裁剪（禁止查看的
 * 字段在读响应、写响应、重放结果、嵌套对象、汇总里都不出现）。路由清单取自实际注册的路由：新增路由缺用例即失败；
 * 不适用的格必须写明原因（不算跳过，也不生成用例）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { survey360 } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import {
  renderPdf,
  renderPng,
  reportDocument,
  scoreTableDocument,
} from '../../apps/api/src/modules/survey360/export-files.js';
import { loginEmailOf } from './AC-EMP-support.js';
import { confirmationToken, outbox } from './AC-360-B-support.js';
import type { RequestOptions } from './support/tenant-api.js';
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
type Key = 'activity' | 'relation' | 'result' | 'questionnaire' | 'person' | 'settings' | 'answer';
const KEYS: readonly Key[] = ['activity', 'relation', 'result', 'questionnaire', 'person', 'settings'];

interface Spec {
  readonly object: Key;
  readonly ops?: Partial<Record<'create' | 'update' | 'delete', boolean>>;
  readonly hide?: readonly string[];
  readonly buttons?: readonly string[] | 'all';
}

function perm(spec: Spec): ObjectPermissionBody {
  const definition = OBJ[spec.object];
  const hidden = new Set(spec.hide ?? []);
  const buttons = definition.buttons as readonly { code: string; level: string; requires?: string }[];
  const granted = spec.buttons === 'all' ? buttons.map((b) => b.code) : (spec.buttons ?? []);
  return {
    objectCode: definition.code,
    dataOperations: { create: false, update: false, delete: false, ...spec.ops },
    fields: definition.fields.map((f) => ({
      fieldCode: f.code,
      view: !hidden.has(f.code),
      edit: !f.system && !hidden.has(f.code),
    })),
    buttons: granted.map((code) => ({ buttonCode: code, level: buttons.find((b) => b.code === code)!.level })),
  } as ObjectPermissionBody;
}

const ALL_OPS = { create: true, update: true, delete: true } as const;
/** 某对象全部数据操作与按钮，可再隐藏字段。 */
const full = (object: Key, hide: readonly string[] = []): Spec => ({ object, ops: ALL_OPS, hide, buttons: 'all' });

async function custom(w: World360, name: string, specs: readonly Spec[]) {
  const user = await w.member(name);
  await w.grantProfile(user, await w.defineProfile(name, specs.map(perm)));
  return user;
}

interface Env {
  readonly w: World360;
  readonly w2: World360;
  readonly fw: FineWorld;
  readonly access: ReturnType<typeof fullAccess>;
  readonly users: Record<
    | 'outsider'
    | 'onlySettings'
    | 'onlyActivity'
    | 'noButtons'
    | 'general'
    | 'advanced'
    | 'tAct'
    | 'tPerson'
    | 'tPersonMobile'
    | 'tRel'
    | 'tRole'
    | 'tQ'
    | 'tResult'
    | 'tSettings'
    | 'tSettingsFine'
    | 'tSettingsRev'
    | 'tRelNoId'
    | 'tLinkLogs'
    | 'tProgress'
    | 'tAnswer'
    | 'tReport'
    | 'tForward'
    | 'tTemplate'
    | 'tTemplateRev'
    | 'tQOwner',
    string
  >;
  readonly q: QuestionnaireView;
  readonly A: { id: string; objectId: string; relationId: string };
  readonly T: { id: string };
  readonly SC: { id: string; objectId: string };
  readonly AU: { id: string; objectId: string };
  readonly L: {
    id: string;
    relation1: string;
    relation2: string;
    t1: string;
    t2: string;
    tc: string;
    tcRemoved: string;
    confirmObjectId: string;
    otherObjectRelation: string;
  };
  readonly role: string;
  readonly conflictId: () => Promise<{ id: string; revision: number }>;
  readonly unsynced: string;
  readonly emails: readonly string[];
  readonly w2Ids: { questionnaire: string; role: string };
}

interface FineWorld {
  readonly w: World360;
  readonly general: string;
  readonly advanced: string;
  readonly external: PersonView;
  readonly outside: PersonView;
}

async function hireIn(w: World360, name: string, orgId: string, managerId?: string) {
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

async function grantTo(w: World360, activityId: string, userIds: string[]) {
  const current = await w.getActivity(activityId);
  await w.ok(w.request('POST', `/activities/${activityId}/grants`, { ifMatch: current.revision, body: { userIds } }));
}

/** 确认链接令牌：取自该确认单的邀请邮件（outbox）。 */
const confirmToken = confirmationToken;

async function buildFineWorld(): Promise<FineWorld> {
  const w = await world360(testDb().db, 'guard-fine');
  const general = await w.member('精细化一般');
  await w.appoint(general, 'general');
  const advanced = await w.member('精细化高级');
  await w.appoint(advanced, 'advanced');
  const inside = await w.session.org('范围内', { establishedOn: '2025-01-01' });
  const outsideOrg = await w.session.org('范围外', { establishedOn: '2025-01-01' });
  await hireIn(w, '范围内员工', inside.id);
  const out = await hireIn(w, '范围外员工', outsideOrg.id);
  await w.ok(w.request('POST', '/people/sync', { body: {} }));
  const people = (await w.ok<{ items: PersonView[] }>(w.request('GET', '/people?pageSize=200'))).items;
  const external = await w.person('外部人员');
  const mou = await w.ok<{ id: string }>(
    w.enterprise('POST', '/mous', {
      ifMatch: 0,
      body: { code: 'mou-guard', name: '范围', orgRanges: [{ orgId: inside.id, includeDescendants: true }] },
    }),
    201,
  );
  for (const user of [general, advanced])
    await w.ok(
      w.enterprise('PUT', `/scopes/${user}/${survey360.SURVEY360_APP}`, {
        ifMatch: 0,
        body: { kind: 'mou', mouId: mou.id },
      }),
    );
  const settings = await w.ok<{ revision: number }>(w.request('GET', '/settings'));
  await w.ok(w.request('PUT', '/settings', { ifMatch: settings.revision, body: { finePermission: true } }));
  return { w, general, advanced, external, outside: people.find((p) => p.employeeId === out.id)! };
}

async function buildEnv(): Promise<Env> {
  const access = fullAccess();
  const w = await world360(testDb().db, 'guard', { access });
  const users = {
    outsider: await w.member('无360身份'),
    onlySettings: await custom(w, '只有设置', [{ object: 'settings' }]),
    onlyActivity: await custom(w, '只有活动', [{ object: 'activity' }]),
    // 全部数据操作、全部字段，唯独没有按钮（计分结果没有数据操作与按钮，只给查看）
    noButtons: await custom(
      w,
      '无按钮',
      KEYS.map((object) => (object === 'result' ? { object } : { object, ops: ALL_OPS })),
    ),
    general: await w.member('一般管理员'),
    advanced: await w.member('高级管理员'),
    tAct: await custom(w, '看不到欢迎语', [full('activity', ['welcome'])]),
    tPerson: await custom(w, '看不到联系方式', [
      full('activity'),
      full('relation'),
      { object: 'result' },
      { object: 'questionnaire' },
      full('person', ['email', 'mobile']),
    ]),
    tPersonMobile: await custom(w, '看不到手机', [full('person', ['mobile'])]),
    tRel: await custom(w, '看不到来源', [
      full('activity'),
      full('relation', ['source', 'activityId']),
      { object: 'questionnaire' },
      full('person'),
    ]),
    tRole: await custom(w, '看不到角色', [
      { object: 'activity' },
      { object: 'relation', hide: ['roleId', 'roleName'] },
      { object: 'person' },
    ]),
    tQ: await custom(w, '看不到指导语', [full('questionnaire', ['guide', 'createdBy'])]),
    tResult: await custom(w, '看不到角色名', [{ object: 'activity' }, { object: 'result', hide: ['roleName'] }]),
    tSettings: await custom(w, '看不到固定文字', [full('settings', ['displayText'])]),
    tSettingsFine: await custom(w, '看不到精细化', [{ object: 'settings', hide: ['finePermission'] }]),
    // 能写精细化开关、看不到独立的 revision 字段（第 3 轮审查 P3）
    tSettingsRev: await custom(w, '看不到设置版本号', [
      { object: 'settings', ops: { update: true }, hide: ['revision'], buttons: ['finePermission'] },
    ]),
    // 看不到评价关系 id：导入回执不能再原样返回关系 ID（第 4 轮 R3-P2-1）
    tRelNoId: await custom(w, '看不到关系ID', [
      full('activity'),
      full('relation', ['id']),
      { object: 'questionnaire' },
      full('person'),
    ]),
    tLinkLogs: await custom(w, '看不到挂接', [
      { object: 'person', hide: ['employeeId', 'previousEmployeeId'], buttons: ['sync'] },
    ]),
    // PR-B：进程控制看不到邮箱与角色名；原始数据看不到总分（可屏蔽、重新作答）；报告看不到生成时间、内容与收件人
    // 邮箱（可转发）；报告模板看不到开关 / 版本号
    tProgress: await custom(w, '进度看不到邮箱', [
      { object: 'activity' },
      { object: 'relation', hide: ['email', 'roleName'] },
    ]),
    // DEC-358②：逐份卡片只给持“全部活动”者或活动创建者，字段裁剪用例的查看人持“全部活动”（不兼任任何活动）
    tAnswer: await custom(w, '答卷看不到总分', [
      { object: 'activity', buttons: ['viewAll'] },
      { object: 'relation', hide: ['roleName'] },
      { object: 'answer', ops: { update: true }, hide: ['total'], buttons: ['block', 'reanswer'] },
    ]),
    tReport: await custom(w, '报告看不到内容', [
      { object: 'activity' },
      {
        object: 'result',
        ops: { update: true },
        hide: ['generatedAt', 'questionnaires', 'recipientEmail'],
        buttons: ['forwardReport'],
      },
    ]),
    // 对报告正文有完整查看权，只看不到收件人邮箱：转发预览按字段裁剪（第 2 轮 P2-5 起看不到正文的转发人 403）
    tForward: await custom(w, '看不到收件人邮箱', [
      { object: 'activity' },
      { object: 'result', ops: { update: true }, hide: ['recipientEmail'], buttons: ['forwardReport'] },
    ]),
    tTemplate: await custom(w, '看不到文本角色开关', [{ object: 'settings', hide: ['showTextRole'] }]),
    // 能新建 / 编辑套卷模板（含指导语），看不到创建人
    tQOwner: await custom(w, '看不到创建人', [full('questionnaire', ['createdBy'])]),
    tTemplateRev: await custom(w, '看不到模板版本号', [
      { object: 'settings', ops: { update: true }, hide: ['revision'], buttons: ['update'] },
    ]),
  };
  await w.appoint(users.general, 'general');
  await w.appoint(users.advanced, 'advanced');

  // 组织员工：经理 M、被评价员工 Tg（上级 M）、同事 P（上级 M）、冲突员工 C2（登录邮箱与外部人员相同）
  const org = await w.session.org('守卫部门', { establishedOn: '2025-01-01' });
  const M = await hireIn(w, '经理M', org.id);
  const Tg = await hireIn(w, '被评价Tg', org.id, M.id);
  await hireIn(w, '同事P', org.id, M.id);
  const C2 = await hireIn(w, '冲突员工', org.id);
  await w.ok(
    w.request('POST', '/people', { ifMatch: 0, body: { name: '外部冲突人员', email: loginEmailOf(C2.id) } }),
    201,
  );
  await w.ok(w.request('POST', '/people/sync', { body: {} }));
  const unsynced = (await hireIn(w, '未同步员工', org.id)).id;
  const people = (await w.ok<{ items: PersonView[] }>(w.request('GET', '/people?pageSize=200'))).items;
  const personOf = (employeeId: string) => people.find((p) => p.employeeId === employeeId)!;

  const q = await w.enableQuestionnaire(await w.keyBehavior({ self: 0, superior: 1, peer: 1, customer: 1 }));
  const target = await w.person('被评价人', { mobile: '10000000011' });
  const rater = await w.person('评价者甲', { mobile: '10000000012' });

  const a = await w.activity({ name: '活动A', welcome: 'WELCOME_A' });
  const oA = await w.object(a.id, target.id, [q.id]);
  const rA = await w.appraiser(a.id, oA.id, rater.id, 'peer');

  const t = await w.activity({ name: '活动T', welcome: 'WELCOME_T' });
  await w.object(t.id, target.id, [q.id]);
  await grantTo(w, t.id, [users.tAct, users.tPerson, users.tRel, users.tRole, users.tResult]);

  // 计分活动：一份答卷后停用
  const sc = await w.activity({ name: '计分活动' });
  const oS = await w.object(sc.id, target.id, [q.id]);
  const rS = await w.appraiser(sc.id, oS.id, rater.id, 'peer');
  await w.transition(sc.id, 'enable');
  await w.answer(await w.token(sc.id, rater.id), rS.id, q, ['v4', 'v4']);
  await w.transition(sc.id, 'disable');
  await grantTo(w, sc.id, [users.tResult, users.tProgress, users.tAnswer, users.tReport, users.tForward]);

  // 自动添加：评价对象是已挂接的 Tg
  const au = await w.activity({ name: '自动添加活动' });
  const oAU = await w.object(au.id, personOf(Tg.id).id, [q.id]);
  await grantTo(w, au.id, [users.tRel]);

  // 链接：不显示姓名与角色；两名评价者；确认链接（有效 / 对象已移除）；另一个对象 Y 的评价关系
  const l = await w.activity({ name: '链接活动', showAppraiserName: false, roleDisplay: 'hidden' });
  const boss = await w.person('上级B');
  const underBoss = async (name: string) => {
    const p = await w.person(name);
    await w.ok(w.request('PUT', `/people/${p.id}`, { ifMatch: p.revision, body: { superiorPersonId: boss.id } }));
    return p;
  };
  const oL = await w.object(l.id, (await underBoss('链接对象')).id, [q.id]);
  const r1p = await w.person('作答甲');
  const r2p = await w.person('作答乙');
  const r1 = await w.appraiser(l.id, oL.id, r1p.id, 'peer');
  const r2 = await w.appraiser(l.id, oL.id, r2p.id, 'customer');
  const oX = await w.object(l.id, (await underBoss('将移除对象')).id, [q.id]);
  await w.appraiser(l.id, oX.id, r1p.id, 'peer');
  const oY = await w.object(l.id, (await w.person('另一对象')).id, [q.id]);
  const rY = await w.appraiser(l.id, oY.id, r2p.id, 'peer');
  const invite = (objectId: string) =>
    w.ok<{ id: string }>(
      w.request('POST', `/activities/${l.id}/objects/${objectId}/confirmation`, { ifMatch: 0, body: {} }),
      201,
    );
  // 同一上级对两个对象各有一张确认单：令牌按确认单取
  const tc = await confirmToken(w, (await invite(oL.id)).id);
  const tcRemoved = await confirmToken(w, (await invite(oX.id)).id);
  await w.transition(l.id, 'enable');
  const objects = await w.ok<{ items: { id: string; revision: number }[] }>(
    w.request('GET', `/activities/${l.id}/objects`),
  );
  const xRevision = objects.items.find((o) => o.id === oX.id)!.revision;
  await w.ok(w.request('DELETE', `/activities/${l.id}/objects/${oX.id}`, { ifMatch: xRevision }));

  // 另一个租户：套卷、自定义角色、开启精细化
  const w2 = await world360(testDb().db, 'guard-other');
  const q2 = await w2.keyBehavior();
  const role2 = await w2.ok<{ id: string }>(
    w2.request('POST', '/roles', { ifMatch: 0, body: { name: '他租户角色' } }),
    201,
  );
  const s2 = await w2.ok<{ revision: number }>(w2.request('GET', '/settings'));
  await w2.ok(w2.request('PUT', '/settings', { ifMatch: s2.revision, body: { finePermission: true } }));

  const fw = await buildFineWorld();
  return {
    w,
    w2,
    fw,
    access,
    users,
    q,
    A: { id: a.id, objectId: oA.id, relationId: rA.id },
    T: { id: t.id },
    SC: { id: sc.id, objectId: oS.id },
    AU: { id: au.id, objectId: oAU.id },
    L: {
      id: l.id,
      relation1: r1.id,
      relation2: r2.id,
      t1: await w.token(l.id, r1p.id),
      t2: await w.token(l.id, r2p.id),
      tc,
      tcRemoved,
      confirmObjectId: oL.id,
      otherObjectRelation: rY.id,
    },
    role: w.role('peer'),
    conflictId: async () =>
      (await w.ok<{ items: { id: string; revision: number }[] }>(w.request('GET', '/people/sync-conflicts'))).items[0]!,
    unsynced,
    emails: [target.email, rater.email, r1p.email, r2p.email, loginEmailOf(C2.id)],
    w2Ids: { questionnaire: q2.id, role: role2.id },
  };
}

type Case = (env: Env) => Promise<void>;
interface NotApplicable {
  readonly na: string;
}
interface RouteCases {
  readonly unauthorized: Case;
  readonly outOfScope: Case | NotApplicable;
  readonly trimming: Case | NotApplicable;
}

const json = async (res: Response) =>
  (await res.json()) as Record<string, unknown> & { items?: Record<string, unknown>[] };
const expectStatus = async (res: Response | Promise<Response>, status: number) => {
  const r = await res;
  expect(r.status, await r.clone().text()).toBe(status);
  return r;
};
const reasonOf = async (res: Response) =>
  ((await res.clone().json()) as { error: { details?: { reason?: string } } }).error.details?.reason;
/** 写入并用同一命令 ID 重放，两次响应都交给 check。 */
async function writeTwice(
  call: (key: string) => Promise<Response>,
  status: number,
  check: (body: Record<string, unknown>) => void,
) {
  const key = randomUUID();
  for (const res of [await call(key), await call(key)]) {
    expect(res.status, await res.clone().text()).toBe(status);
    check(await json(res));
  }
}
/** 任何层级都不出现这些键（只查键，不查值：matchedBy 里的 "email" 是查重方式，不是邮箱）。 */
const without = (body: unknown, ...keys: string[]) => {
  const text = JSON.stringify(body);
  for (const key of keys) expect(text, key).not.toContain(`"${key}":`);
};
/** 缺按钮的 403 先于业务校验（本人套卷等），不是业务校验给出的 403。 */
const buttonDenied = async (res: Promise<Response>) =>
  expect(await reasonOf(await expectStatus(res, 403))).not.toBe('QUESTIONNAIRE_NOT_OWNER');
const noMarkers = (body: unknown, markers: readonly string[]) => {
  const text = JSON.stringify(body);
  for (const marker of markers) expect(text).not.toContain(marker);
};
const keysOf = (value: unknown) => Object.keys(value as object).sort();

const admin = (env: Env, user: string) => env.w.as(user);
const sa = (env: Env) => env.w.request;
/** 确认单当前 revision（确认人从确认页取得）。 */
const confirmRevision = async (env: Env) =>
  (await json(await expectStatus(env.w.link(env.L.tc)('GET', ''), 200))).revision as number;
const freshActivity = async (env: Env, grantees: string[] = []) => {
  const activity = await env.w.activity({ name: `临时${randomUUID().slice(0, 4)}`, welcome: 'WELCOME_TMP' });
  if (grantees.length) await grantTo(env.w, activity.id, grantees);
  return activity;
};

/** 路由清单：键 = 方法 + 实际注册路径。 */
const S = BASE;
const ROUTE_CASES: Record<string, RouteCases> = {
  [`GET ${S}/settings`]: {
    unauthorized: async (env) => void (await expectStatus(admin(env, env.users.onlyActivity)('GET', '/settings'), 403)),
    outOfScope: async (env) => {
      const own = await json(await expectStatus(sa(env)('GET', '/settings'), 200));
      expect(own.finePermission).toBe(false); // 另一个租户开启了精细化，不影响本租户
    },
    trimming: async (env) => {
      const body = await json(await expectStatus(admin(env, env.users.tSettingsFine)('GET', '/settings'), 200));
      expect(body).not.toHaveProperty('finePermission');
    },
  },
  [`PUT ${S}/settings`]: {
    unauthorized: async (env) => {
      const before = await json(await sa(env)('GET', '/settings'));
      await expectStatus(
        admin(env, env.users.noButtons)('PUT', '/settings', {
          ifMatch: before.revision as number,
          body: { finePermission: false },
        }),
        403,
      );
      expect(await json(await sa(env)('GET', '/settings'))).toEqual(before);
    },
    outOfScope: async (env) => {
      const other = await json(await env.w2.request('GET', '/settings'));
      const own = await json(await sa(env)('GET', '/settings'));
      await expectStatus(
        sa(env)('PUT', '/settings', { ifMatch: own.revision as number, body: { finePermission: false } }),
        200,
      );
      expect(await json(await env.w2.request('GET', '/settings'))).toEqual(other);
    },
    trimming: async (env) => {
      // 能编辑 finePermission 不代表能看独立的 revision 字段：写响应与同键重放都不带 revision（第 3 轮审查 P3）
      const before = await json(await sa(env)('GET', '/settings'));
      await writeTwice(
        (key) =>
          admin(env, env.users.tSettingsRev)('PUT', '/settings', {
            ifMatch: before.revision as number,
            idempotencyKey: key,
            body: { finePermission: false },
          }),
        200,
        (body) => expect(body).toEqual({ finePermission: false }),
      );
    },
  },
  [`GET ${S}/roles`]: {
    unauthorized: async (env) => void (await expectStatus(admin(env, env.users.onlyActivity)('GET', '/roles'), 403)),
    outOfScope: async (env) => {
      const body = await json(await expectStatus(sa(env)('GET', '/roles'), 200));
      expect(JSON.stringify(body)).not.toContain(env.w2Ids.role);
    },
    trimming: async (env) => {
      const body = await json(await expectStatus(admin(env, env.users.tSettings)('GET', '/roles'), 200));
      expect(body.items!.length).toBeGreaterThan(0);
      without(body, 'displayText');
    },
  },
  [`POST ${S}/roles`]: {
    unauthorized: async (env) => {
      const before = await json(await sa(env)('GET', '/roles'));
      await expectStatus(
        admin(env, env.users.noButtons)('POST', '/roles', { ifMatch: 0, body: { name: '无按钮角色' } }),
        403,
      );
      expect(await json(await sa(env)('GET', '/roles'))).toEqual(before);
    },
    outOfScope: async (env) => {
      const created = await json(
        await expectStatus(sa(env)('POST', '/roles', { ifMatch: 0, body: { name: '本租户角色' } }), 201),
      );
      expect(JSON.stringify(await json(await env.w2.request('GET', '/roles')))).not.toContain(created.id as string);
    },
    trimming: async (env) =>
      writeTwice(
        (key) =>
          admin(env, env.users.tSettings)('POST', '/roles', {
            ifMatch: 0,
            idempotencyKey: key,
            body: { name: `裁剪${key.slice(0, 4)}` },
          }),
        201,
        (body) => expect(body).not.toHaveProperty('displayText'),
      ),
  },
  [`PUT ${S}/roles/:id`]: {
    unauthorized: async (env) => {
      const role = await json(await sa(env)('POST', '/roles', { ifMatch: 0, body: { name: '待改角色' } }));
      await expectStatus(
        admin(env, env.users.noButtons)('PUT', `/roles/${role.id as string}`, {
          ifMatch: role.revision as number,
          body: { name: '改' },
        }),
        403,
      );
    },
    outOfScope: async (env) =>
      void (await expectStatus(
        sa(env)('PUT', `/roles/${env.w2Ids.role}`, { ifMatch: 1, body: { name: '跨租户' } }),
        404,
      )),
    trimming: async (env) => {
      const role = await json(
        await sa(env)('POST', '/roles', { ifMatch: 0, body: { name: '裁剪改名', displayText: 'TEXT_X' } }),
      );
      await writeTwice(
        (key) =>
          admin(env, env.users.tSettings)('PUT', `/roles/${role.id as string}`, {
            ifMatch: role.revision as number,
            idempotencyKey: key,
            body: { name: '已改' },
          }),
        200,
        (body) => {
          expect(body).not.toHaveProperty('displayText');
          noMarkers(body, ['TEXT_X']);
        },
      );
    },
  },
  [`GET ${S}/people/sync-conflicts`]: {
    unauthorized: async (env) =>
      void (await expectStatus(admin(env, env.users.general)('GET', '/people/sync-conflicts'), 403)),
    outOfScope: async (env) => {
      env.access.scope = EMPTY_SCOPE;
      try {
        expect((await json(await expectStatus(sa(env)('GET', '/people/sync-conflicts'), 200))).items).toEqual([]);
      } finally {
        env.access.scope = fullAccess().scope;
      }
    },
    trimming: async (env) => {
      const body = await json(await expectStatus(admin(env, env.users.tPerson)('GET', '/people/sync-conflicts'), 200));
      expect(body.items!.length).toBeGreaterThan(0);
      without(body, 'email');
      noMarkers(body, env.emails);
      // 候选人员的挂接字段同样按人员字段权限裁剪（冲突本身的员工 ID 属组织员工侧，按员工范围判定）
      const linkage = await json(
        await expectStatus(admin(env, env.users.tLinkLogs)('GET', '/people/sync-conflicts'), 200),
      );
      for (const item of linkage.items!)
        for (const candidate of item.candidates as object[]) expect(candidate).not.toHaveProperty('employeeId');
    },
  },
  [`POST ${S}/people/sync`]: {
    unauthorized: async (env) =>
      void (await expectStatus(admin(env, env.users.general)('POST', '/people/sync', { body: {} }), 403)),
    outOfScope: async (env) => {
      env.access.scope = EMPTY_SCOPE;
      try {
        const body = await json(await expectStatus(sa(env)('POST', '/people/sync', { body: {} }), 200));
        noMarkers(body, [env.unsynced]);
        const all = await json(await sa(env)('GET', '/people?pageSize=200'));
        noMarkers(all, [env.unsynced]);
      } finally {
        env.access.scope = fullAccess().scope;
      }
    },
    trimming: async (env) =>
      writeTwice(
        (key) => admin(env, env.users.tLinkLogs)('POST', '/people/sync', { idempotencyKey: key, body: {} }),
        200,
        (body) => {
          // 回执里的人员条目按人员字段权限裁剪：看不到挂接员工 ID 的人，回执里也没有
          const people = [...(body.created as object[]), ...(body.updated as object[])];
          expect(people.length).toBeGreaterThan(0);
          for (const entry of people) expect(entry).not.toHaveProperty('employeeId');
          noMarkers(body, [env.unsynced, ...env.emails]);
        },
      ),
  },
  [`POST ${S}/people/sync-conflicts/:id/resolve`]: {
    unauthorized: async (env) => {
      const conflict = await env.conflictId();
      await expectStatus(
        admin(env, env.users.general)('POST', `/people/sync-conflicts/${conflict.id}/resolve`, {
          ifMatch: conflict.revision,
          body: { action: 'ignore' },
        }),
        403,
      );
    },
    outOfScope: async (env) => {
      const conflict = await env.conflictId();
      env.access.scope = EMPTY_SCOPE;
      try {
        await expectStatus(
          sa(env)('POST', `/people/sync-conflicts/${conflict.id}/resolve`, {
            ifMatch: conflict.revision,
            body: { action: 'ignore' },
          }),
          404,
        );
      } finally {
        env.access.scope = fullAccess().scope;
      }
    },
    trimming: async (env) => {
      const conflict = await env.conflictId();
      await writeTwice(
        (key) =>
          admin(env, env.users.tPerson)('POST', `/people/sync-conflicts/${conflict.id}/resolve`, {
            ifMatch: conflict.revision,
            idempotencyKey: key,
            body: { action: 'ignore' },
          }),
        200,
        (body) => {
          // 冲突回执只有冲突协议字段，不带人员的联系方式
          expect(keysOf(body)).toEqual([
            'candidatePersonIds',
            'employeeId',
            'id',
            'matchedBy',
            'resolution',
            'resolvedPersonId',
            'revision',
            'status',
          ]);
          noMarkers(body, env.emails);
        },
      );
    },
  },
  [`GET ${S}/people`]: {
    unauthorized: async (env) => void (await expectStatus(admin(env, env.users.onlySettings)('GET', '/people'), 403)),
    outOfScope: async (env) => {
      const body = await json(await expectStatus(env.fw.w.as(env.fw.general)('GET', '/people?pageSize=200'), 200));
      noMarkers(body, [env.fw.external.id, env.fw.outside.id]);
    },
    trimming: async (env) => {
      const body = await json(await expectStatus(admin(env, env.users.tPerson)('GET', '/people?pageSize=200'), 200));
      without(body, 'email', 'mobile');
      noMarkers(body, [...env.emails, '10000000011', '10000000012']);
    },
  },
  [`GET ${S}/people/:id`]: {
    unauthorized: async (env) =>
      void (await expectStatus(admin(env, env.users.onlySettings)('GET', `/people/${env.fw.external.id}`), 403)),
    outOfScope: async (env) =>
      void (await expectStatus(env.fw.w.as(env.fw.general)('GET', `/people/${env.fw.external.id}`), 404)),
    trimming: async (env) => {
      const list = await json(await sa(env)('GET', '/people?pageSize=200'));
      const id = list.items!.find((p) => p.mobile === '10000000012')!.id as string;
      const body = await json(await expectStatus(admin(env, env.users.tPerson)('GET', `/people/${id}`), 200));
      expect(body).toHaveProperty('name', '评价者甲');
      without(body, 'email', 'mobile');
    },
  },
  [`GET ${S}/people/:id/link-logs`]: {
    unauthorized: async (env) => {
      const list = await json(await sa(env)('GET', '/people?pageSize=200'));
      const linked = list.items!.find((p) => p.employeeId)!.id as string;
      await expectStatus(admin(env, env.users.general)('GET', `/people/${linked}/link-logs`), 403);
    },
    outOfScope: async (env) =>
      void (await expectStatus(env.fw.w.as(env.fw.advanced)('GET', `/people/${env.fw.outside.id}/link-logs`), 404)),
    trimming: async (env) => {
      const list = await json(await sa(env)('GET', '/people?pageSize=200'));
      const linked = list.items!.find((p) => p.employeeId)!;
      const body = await json(
        await expectStatus(admin(env, env.users.tLinkLogs)('GET', `/people/${linked.id as string}/link-logs`), 200),
      );
      expect(body.items!.length).toBeGreaterThan(0);
      without(body, 'employeeId', 'previousEmployeeId');
      noMarkers(body, [linked.employeeId as string]);
    },
  },
  [`POST ${S}/people`]: {
    unauthorized: async (env) => {
      const before = await json(await sa(env)('GET', '/people?pageSize=200'));
      await expectStatus(
        admin(env, env.users.noButtons)('POST', '/people', {
          ifMatch: 0,
          body: { name: '无按钮', email: 'nb-guard@example.com' },
        }),
        403,
      );
      expect(await json(await sa(env)('GET', '/people?pageSize=200'))).toEqual(before);
    },
    outOfScope: async (env) => {
      const res = await expectStatus(
        env.fw.w.as(env.fw.general)('POST', '/people', {
          ifMatch: 0,
          body: { name: '受限新建', email: 'fine-guard@example.com' },
        }),
        403,
      );
      expect(await reasonOf(res)).toBe('PERSON_NOT_AVAILABLE');
    },
    trimming: async (env) =>
      writeTwice(
        (key) =>
          admin(env, env.users.tPersonMobile)('POST', '/people', {
            ifMatch: 0,
            idempotencyKey: key,
            body: { name: '新人员', email: `m-${key.slice(0, 6)}@example.com` },
          }),
        201,
        (body) => expect(body).not.toHaveProperty('mobile'),
      ),
  },
  [`PUT ${S}/people/:id`]: {
    unauthorized: async (env) => {
      const p = await env.w.person('待改人员');
      await expectStatus(
        admin(env, env.users.noButtons)('PUT', `/people/${p.id}`, { ifMatch: p.revision, body: { name: '改' } }),
        403,
      );
      expect(await json(await sa(env)('GET', `/people/${p.id}`))).toMatchObject({
        name: '待改人员',
        revision: p.revision,
      });
    },
    outOfScope: async (env) =>
      void (await expectStatus(
        env.fw.w.as(env.fw.general)('PUT', `/people/${env.fw.external.id}`, {
          ifMatch: env.fw.external.revision,
          body: { name: '改' },
        }),
        404,
      )),
    trimming: async (env) => {
      const p = await env.w.person('裁剪人员', { mobile: '10000000099' });
      await writeTwice(
        (key) =>
          admin(env, env.users.tPerson)('PUT', `/people/${p.id}`, {
            ifMatch: p.revision,
            idempotencyKey: key,
            body: { name: '改名' },
          }),
        200,
        (body) => {
          without(body, 'email', 'mobile');
          noMarkers(body, [p.email, '10000000099']);
        },
      );
    },
  },
  [`GET ${S}/questionnaires`]: {
    unauthorized: async (env) =>
      void (await expectStatus(admin(env, env.users.onlySettings)('GET', '/questionnaires'), 403)),
    outOfScope: async (env) =>
      noMarkers(await json(await expectStatus(sa(env)('GET', '/questionnaires'), 200)), [env.w2Ids.questionnaire]),
    trimming: async (env) =>
      without(
        await json(await expectStatus(admin(env, env.users.tQ)('GET', '/questionnaires'), 200)),
        'createdBy',
        'guide',
      ),
  },
  [`GET ${S}/questionnaires/:id`]: {
    unauthorized: async (env) =>
      void (await expectStatus(admin(env, env.users.onlySettings)('GET', `/questionnaires/${env.q.id}`), 403)),
    outOfScope: async (env) =>
      void (await expectStatus(sa(env)('GET', `/questionnaires/${env.w2Ids.questionnaire}`), 404)),
    trimming: async (env) =>
      without(
        await json(await expectStatus(admin(env, env.users.tQ)('GET', `/questionnaires/${env.q.id}`), 200)),
        'createdBy',
        'guide',
      ),
  },
  [`POST ${S}/questionnaires`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        admin(env, env.users.noButtons)('POST', '/questionnaires', {
          ifMatch: 0,
          body: { name: '无按钮', type: 'rating' },
        }),
        403,
      )),
    outOfScope: async (env) => {
      const created = await json(
        await expectStatus(
          sa(env)('POST', '/questionnaires', { ifMatch: 0, body: { name: '本租户套卷', type: 'rating' } }),
          201,
        ),
      );
      await expectStatus(env.w2.request('GET', `/questionnaires/${created.id as string}`), 404);
    },
    trimming: async (env) =>
      writeTwice(
        (key) =>
          admin(env, env.users.tQ)('POST', '/questionnaires', {
            ifMatch: 0,
            idempotencyKey: key,
            body: { name: '裁剪套卷', type: 'rating' },
          }),
        201,
        (body) => without(body, 'createdBy', 'guide'),
      ),
  },
  [`PUT ${S}/questionnaires/:id`]: {
    unauthorized: async (env) =>
      buttonDenied(
        admin(env, env.users.noButtons)('PUT', `/questionnaires/${env.q.id}`, {
          ifMatch: env.q.revision,
          body: { name: '改' },
        }),
      ),
    outOfScope: async (env) => {
      const draft = await env.w.keyBehavior();
      const res = await expectStatus(
        admin(env, env.users.advanced)('PUT', `/questionnaires/${draft.id}`, {
          ifMatch: draft.revision,
          body: { name: '改' },
        }),
        403,
      );
      expect(await reasonOf(res)).toBe('QUESTIONNAIRE_NOT_OWNER');
    },
    trimming: async (env) => {
      const own = await json(
        await admin(env, env.users.tQ)('POST', '/questionnaires', {
          ifMatch: 0,
          body: { name: '自建', type: 'rating' },
        }),
      );
      await writeTwice(
        (key) =>
          admin(env, env.users.tQ)('PUT', `/questionnaires/${own.id as string}`, {
            ifMatch: own.revision as number,
            idempotencyKey: key,
            body: { name: '自建改名' },
          }),
        200,
        (body) => without(body, 'createdBy', 'guide'),
      );
    },
  },
  [`POST ${S}/questionnaires/:id/enable`]: {
    unauthorized: async (env) => {
      const draft = await env.w.keyBehavior();
      await buttonDenied(
        admin(env, env.users.noButtons)('POST', `/questionnaires/${draft.id}/enable`, { ifMatch: draft.revision }),
      );
    },
    outOfScope: async (env) => {
      const draft = await env.w.keyBehavior();
      const res = await expectStatus(
        admin(env, env.users.advanced)('POST', `/questionnaires/${draft.id}/enable`, { ifMatch: draft.revision }),
        403,
      );
      expect(await reasonOf(res)).toBe('QUESTIONNAIRE_NOT_OWNER');
    },
    trimming: async (env) => {
      const u = admin(env, env.users.tQ);
      const own = await json(
        await u('POST', '/questionnaires', { ifMatch: 0, body: { name: '待启用', type: 'key_behavior' } }),
      );
      const content = env.w.keyBehaviorContent({ self: 0, peer: 1 });
      const saved = await json(
        await expectStatus(
          u('PUT', `/questionnaires/${own.id as string}`, { ifMatch: own.revision as number, body: { content } }),
          200,
        ),
      );
      await writeTwice(
        (key) =>
          u('POST', `/questionnaires/${own.id as string}/enable`, {
            ifMatch: saved.revision as number,
            idempotencyKey: key,
          }),
        200,
        (body) => without(body, 'createdBy', 'guide'),
      );
    },
  },
  [`DELETE ${S}/questionnaires/:id`]: {
    unauthorized: async (env) => {
      const draft = await env.w.keyBehavior();
      await buttonDenied(
        admin(env, env.users.noButtons)('DELETE', `/questionnaires/${draft.id}`, { ifMatch: draft.revision }),
      );
    },
    outOfScope: async (env) => {
      const draft = await env.w.keyBehavior();
      const res = await expectStatus(
        admin(env, env.users.advanced)('DELETE', `/questionnaires/${draft.id}`, { ifMatch: draft.revision }),
        403,
      );
      expect(await reasonOf(res)).toBe('QUESTIONNAIRE_NOT_OWNER');
    },
    trimming: async (env) => {
      const own = await json(
        await admin(env, env.users.tQ)('POST', '/questionnaires', {
          ifMatch: 0,
          body: { name: '待删', type: 'rating' },
        }),
      );
      await writeTwice(
        (key) =>
          admin(env, env.users.tQ)('DELETE', `/questionnaires/${own.id as string}`, {
            ifMatch: own.revision as number,
            idempotencyKey: key,
          }),
        200,
        (body) => expect(keysOf(body)).toEqual(['deleted', 'id']),
      );
    },
  },
  [`GET ${S}/activities`]: {
    unauthorized: async (env) =>
      void (await expectStatus(admin(env, env.users.onlySettings)('GET', '/activities'), 403)),
    outOfScope: async (env) =>
      noMarkers(await json(await expectStatus(admin(env, env.users.general)('GET', '/activities'), 200)), [env.A.id]),
    trimming: async (env) => {
      const body = await json(await expectStatus(admin(env, env.users.tAct)('GET', '/activities'), 200));
      expect(body.items!.length).toBeGreaterThan(0);
      without(body, 'welcome');
      noMarkers(body, ['WELCOME_T']);
    },
  },
  [`GET ${S}/activities/:id`]: {
    unauthorized: async (env) =>
      void (await expectStatus(admin(env, env.users.onlySettings)('GET', `/activities/${env.T.id}`), 403)),
    outOfScope: async (env) =>
      void (await expectStatus(admin(env, env.users.general)('GET', `/activities/${env.A.id}`), 404)),
    trimming: async (env) => {
      const body = await json(await expectStatus(admin(env, env.users.tAct)('GET', `/activities/${env.T.id}`), 200));
      expect(body).not.toHaveProperty('welcome');
    },
  },
  [`POST ${S}/activities`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        admin(env, env.users.noButtons)('POST', '/activities', {
          ifMatch: 0,
          body: { name: '无按钮', form: 'single' },
        }),
        403,
      )),
    outOfScope: async (env) => {
      const created = await json(
        await expectStatus(
          sa(env)('POST', '/activities', { ifMatch: 0, body: { name: '本租户', form: 'single' } }),
          201,
        ),
      );
      await expectStatus(env.w2.request('GET', `/activities/${created.id as string}`), 404);
    },
    trimming: async (env) =>
      writeTwice(
        (key) =>
          admin(env, env.users.tAct)('POST', '/activities', {
            ifMatch: 0,
            idempotencyKey: key,
            body: { name: '裁剪活动', form: 'single' },
          }),
        201,
        (body) => expect(body).not.toHaveProperty('welcome'),
      ),
  },
  [`PUT ${S}/activities/:id`]: {
    unauthorized: async (env) => {
      const before = await env.w.getActivity(env.T.id);
      await expectStatus(
        admin(env, env.users.noButtons)('PUT', `/activities/${env.T.id}`, {
          ifMatch: before.revision,
          body: { name: '改' },
        }),
        403,
      );
      expect(await env.w.getActivity(env.T.id)).toEqual(before);
    },
    outOfScope: async (env) => {
      const before = await env.w.getActivity(env.A.id);
      await expectStatus(
        admin(env, env.users.general)('PUT', `/activities/${env.A.id}`, {
          ifMatch: before.revision,
          body: { name: '改' },
        }),
        404,
      );
      expect(await env.w.getActivity(env.A.id)).toEqual(before);
    },
    trimming: async (env) => {
      const activity = await freshActivity(env, [env.users.tAct]);
      const current = await env.w.getActivity(activity.id);
      await writeTwice(
        (key) =>
          admin(env, env.users.tAct)('PUT', `/activities/${activity.id}`, {
            ifMatch: current.revision,
            idempotencyKey: key,
            body: { name: '改名' },
          }),
        200,
        (body) => {
          expect(body).not.toHaveProperty('welcome');
          noMarkers(body, ['WELCOME_TMP']);
        },
      );
    },
  },
  [`DELETE ${S}/activities/:id`]: {
    unauthorized: async (env) => {
      const activity = await freshActivity(env);
      await expectStatus(
        admin(env, env.users.noButtons)('DELETE', `/activities/${activity.id}`, { ifMatch: activity.revision }),
        403,
      );
    },
    outOfScope: async (env) => {
      const activity = await freshActivity(env);
      await expectStatus(
        admin(env, env.users.general)('DELETE', `/activities/${activity.id}`, { ifMatch: activity.revision }),
        404,
      );
    },
    trimming: async (env) => {
      const activity = await freshActivity(env, [env.users.tAct]);
      const current = await env.w.getActivity(activity.id);
      await writeTwice(
        (key) =>
          admin(env, env.users.tAct)('DELETE', `/activities/${activity.id}`, {
            ifMatch: current.revision,
            idempotencyKey: key,
          }),
        200,
        (body) => expect(keysOf(body)).toEqual(['deleted', 'id']),
      );
    },
  },
  [`POST ${S}/activities/:id/enable`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        admin(env, env.users.noButtons)('POST', `/activities/${env.A.id}/enable`, {
          ifMatch: (await env.w.getActivity(env.A.id)).revision,
        }),
        403,
      )),
    outOfScope: async (env) =>
      void (await expectStatus(
        admin(env, env.users.general)('POST', `/activities/${env.A.id}/enable`, {
          ifMatch: (await env.w.getActivity(env.A.id)).revision,
        }),
        404,
      )),
    trimming: async (env) => {
      const activity = await freshActivity(env, [env.users.tAct]);
      const object = await env.w.object(activity.id, (await env.w.person('启用对象')).id, [env.q.id]);
      await env.w.appraiser(activity.id, object.id, (await env.w.person('启用评价者')).id, 'peer');
      const current = await env.w.getActivity(activity.id);
      await writeTwice(
        (key) =>
          admin(env, env.users.tAct)('POST', `/activities/${activity.id}/enable`, {
            ifMatch: current.revision,
            idempotencyKey: key,
          }),
        200,
        (body) => expect(body).not.toHaveProperty('welcome'),
      );
    },
  },
  [`POST ${S}/activities/:id/disable`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        admin(env, env.users.noButtons)('POST', `/activities/${env.A.id}/disable`, {
          ifMatch: (await env.w.getActivity(env.A.id)).revision,
        }),
        403,
      )),
    outOfScope: async (env) =>
      void (await expectStatus(
        admin(env, env.users.general)('POST', `/activities/${env.A.id}/disable`, {
          ifMatch: (await env.w.getActivity(env.A.id)).revision,
        }),
        404,
      )),
    trimming: async (env) => {
      const activity = await freshActivity(env, [env.users.tAct]);
      const object = await env.w.object(activity.id, (await env.w.person('停用对象')).id, [env.q.id]);
      await env.w.appraiser(activity.id, object.id, (await env.w.person('停用评价者')).id, 'peer');
      await env.w.transition(activity.id, 'enable');
      const current = await env.w.getActivity(activity.id);
      await writeTwice(
        (key) =>
          admin(env, env.users.tAct)('POST', `/activities/${activity.id}/disable`, {
            ifMatch: current.revision,
            idempotencyKey: key,
          }),
        200,
        (body) => expect(body).not.toHaveProperty('welcome'),
      );
    },
  },
  [`GET ${S}/activities/:id/grants`]: {
    unauthorized: async (env) =>
      void (await expectStatus(admin(env, env.users.onlySettings)('GET', `/activities/${env.T.id}/grants`), 403)),
    outOfScope: async (env) =>
      void (await expectStatus(admin(env, env.users.general)('GET', `/activities/${env.A.id}/grants`), 404)),
    trimming: async (env) => {
      // 授权例外：只有账号层面的两栏与显示名，不带任何 360 人员字段
      const body = await json(
        await expectStatus(admin(env, env.users.tAct)('GET', `/activities/${env.T.id}/grants`), 200),
      );
      expect(keysOf(body)).toEqual(['authorized', 'names', 'unauthorized']);
      noMarkers(body, env.emails);
    },
  },
  [`POST ${S}/activities/:id/grants`]: {
    unauthorized: async (env) => {
      const current = await env.w.getActivity(env.T.id);
      await expectStatus(
        admin(env, env.users.noButtons)('POST', `/activities/${env.T.id}/grants`, {
          ifMatch: current.revision,
          body: { userIds: [env.users.advanced] },
        }),
        403,
      );
    },
    outOfScope: async (env) => {
      const current = await env.w.getActivity(env.A.id);
      await expectStatus(
        admin(env, env.users.general)('POST', `/activities/${env.A.id}/grants`, {
          ifMatch: current.revision,
          body: { userIds: [env.users.general] },
        }),
        404,
      );
    },
    trimming: async (env) => {
      const activity = await freshActivity(env, [env.users.tAct]);
      const current = await env.w.getActivity(activity.id);
      await writeTwice(
        (key) =>
          admin(env, env.users.tAct)('POST', `/activities/${activity.id}/grants`, {
            ifMatch: current.revision,
            idempotencyKey: key,
            body: { userIds: [env.users.advanced] },
          }),
        200,
        (body) => {
          expect(keysOf(body)).toEqual(['authorized', 'names', 'unauthorized']);
          noMarkers(body, env.emails);
        },
      );
    },
  },
  [`DELETE ${S}/activities/:id/grants/:userId`]: {
    unauthorized: async (env) => {
      const current = await env.w.getActivity(env.T.id);
      await expectStatus(
        admin(env, env.users.noButtons)('DELETE', `/activities/${env.T.id}/grants/${env.users.tAct}`, {
          ifMatch: current.revision,
        }),
        403,
      );
    },
    outOfScope: async (env) => {
      const current = await env.w.getActivity(env.A.id);
      await expectStatus(
        admin(env, env.users.general)('DELETE', `/activities/${env.A.id}/grants/${env.users.general}`, {
          ifMatch: current.revision,
        }),
        404,
      );
    },
    trimming: async (env) => {
      const activity = await freshActivity(env, [env.users.tAct, env.users.advanced]);
      const current = await env.w.getActivity(activity.id);
      await writeTwice(
        (key) =>
          admin(env, env.users.tAct)('DELETE', `/activities/${activity.id}/grants/${env.users.advanced}`, {
            ifMatch: current.revision,
            idempotencyKey: key,
          }),
        200,
        (body) => {
          expect(keysOf(body)).toEqual(['authorized', 'names', 'unauthorized']);
          noMarkers(body, env.emails);
        },
      );
    },
  },
  [`GET ${S}/activities/:id/objects/:objectId/scores`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        admin(env, env.users.onlyActivity)('GET', `/activities/${env.SC.id}/objects/${env.SC.objectId}/scores`),
        403,
      )),
    outOfScope: async (env) =>
      void (await expectStatus(
        admin(env, env.users.general)('GET', `/activities/${env.SC.id}/objects/${env.SC.objectId}/scores`),
        404,
      )),
    trimming: async (env) => {
      const body = await json(
        await expectStatus(
          admin(env, env.users.tResult)('GET', `/activities/${env.SC.id}/objects/${env.SC.objectId}/scores`),
          200,
        ),
      );
      expect(body.items!.length).toBeGreaterThan(0);
      without(body, 'roleName');
    },
  },
  [`GET ${S}/activities/:id/objects`]: {
    unauthorized: async (env) =>
      void (await expectStatus(admin(env, env.users.onlyActivity)('GET', `/activities/${env.T.id}/objects`), 403)),
    outOfScope: async (env) =>
      void (await expectStatus(admin(env, env.users.general)('GET', `/activities/${env.A.id}/objects`), 404)),
    trimming: async (env) => {
      const body = await json(
        await expectStatus(admin(env, env.users.tPerson)('GET', `/activities/${env.T.id}/objects`), 200),
      );
      expect(body.items![0]!.person).toEqual({ name: '被评价人', avatar: null });
      noMarkers(body, env.emails);
    },
  },
  [`POST ${S}/activities/:id/objects`]: {
    unauthorized: async (env) => {
      const before = await json(await sa(env)('GET', `/activities/${env.T.id}/objects`));
      const p = await env.w.person('无按钮对象');
      await expectStatus(
        admin(env, env.users.noButtons)('POST', `/activities/${env.T.id}/objects`, {
          ifMatch: 0,
          body: { personId: p.id, questionnaireIds: [env.q.id] },
        }),
        403,
      );
      expect(await json(await sa(env)('GET', `/activities/${env.T.id}/objects`))).toEqual(before);
    },
    outOfScope: async (env) => {
      const p = await env.w.person('越界对象');
      await expectStatus(
        admin(env, env.users.general)('POST', `/activities/${env.A.id}/objects`, {
          ifMatch: 0,
          body: { personId: p.id, questionnaireIds: [env.q.id] },
        }),
        404,
      );
    },
    trimming: async (env) => {
      const activity = await freshActivity(env, [env.users.tRel]);
      const p = await env.w.person('裁剪对象');
      await writeTwice(
        (key) =>
          admin(env, env.users.tRel)('POST', `/activities/${activity.id}/objects`, {
            ifMatch: 0,
            idempotencyKey: key,
            body: { personId: p.id, questionnaireIds: [env.q.id] },
          }),
        201,
        (body) => expect(body).not.toHaveProperty('activityId'),
      );
    },
  },
  [`PUT ${S}/activities/:id/objects/:objectId/questionnaires`]: {
    unauthorized: async (env) => {
      const objects = await json(await sa(env)('GET', `/activities/${env.T.id}/objects`));
      const o = objects.items![0]!;
      await expectStatus(
        admin(env, env.users.noButtons)('PUT', `/activities/${env.T.id}/objects/${o.id as string}/questionnaires`, {
          ifMatch: o.revision as number,
          body: { questionnaireIds: [env.q.id] },
        }),
        403,
      );
    },
    outOfScope: async (env) =>
      void (await expectStatus(
        admin(env, env.users.general)('PUT', `/activities/${env.A.id}/objects/${env.A.objectId}/questionnaires`, {
          ifMatch: 1,
          body: { questionnaireIds: [env.q.id] },
        }),
        404,
      )),
    trimming: async (env) => {
      const activity = await freshActivity(env, [env.users.tRel]);
      const object = await env.w.object(activity.id, (await env.w.person('换卷对象')).id, [env.q.id]);
      await writeTwice(
        (key) =>
          admin(env, env.users.tRel)('PUT', `/activities/${activity.id}/objects/${object.id}/questionnaires`, {
            ifMatch: object.revision,
            idempotencyKey: key,
            body: { questionnaireIds: [env.q.id] },
          }),
        200,
        (body) => expect(body).not.toHaveProperty('activityId'),
      );
    },
  },
  [`DELETE ${S}/activities/:id/objects/:objectId`]: {
    unauthorized: async (env) => {
      const objects = await json(await sa(env)('GET', `/activities/${env.T.id}/objects`));
      const o = objects.items![0]!;
      await expectStatus(
        admin(env, env.users.noButtons)('DELETE', `/activities/${env.T.id}/objects/${o.id as string}`, {
          ifMatch: o.revision as number,
        }),
        403,
      );
    },
    outOfScope: async (env) =>
      void (await expectStatus(
        admin(env, env.users.general)('DELETE', `/activities/${env.A.id}/objects/${env.A.objectId}`, { ifMatch: 1 }),
        404,
      )),
    trimming: async (env) => {
      const activity = await freshActivity(env, [env.users.tRel]);
      const object = await env.w.object(activity.id, (await env.w.person('移除对象')).id, [env.q.id]);
      await writeTwice(
        (key) =>
          admin(env, env.users.tRel)('DELETE', `/activities/${activity.id}/objects/${object.id}`, {
            ifMatch: object.revision,
            idempotencyKey: key,
          }),
        200,
        (body) => expect(keysOf(body)).toEqual(['id', 'removed']),
      );
    },
  },
  [`GET ${S}/activities/:id/objects/:objectId/appraisers`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        admin(env, env.users.onlyActivity)('GET', `/activities/${env.A.id}/objects/${env.A.objectId}/appraisers`),
        403,
      )),
    outOfScope: async (env) =>
      void (await expectStatus(
        admin(env, env.users.general)('GET', `/activities/${env.A.id}/objects/${env.A.objectId}/appraisers`),
        404,
      )),
    trimming: async (env) => {
      const objects = await json(await sa(env)('GET', `/activities/${env.T.id}/objects`));
      const objectId = objects.items![0]!.id as string;
      await env.w.appraiser(env.T.id, objectId, (await env.w.person('角色裁剪评价者')).id, 'peer');
      const body = await json(
        await expectStatus(
          admin(env, env.users.tRole)('GET', `/activities/${env.T.id}/objects/${objectId}/appraisers`),
          200,
        ),
      );
      expect(body.items!.length).toBeGreaterThan(0);
      without(body, 'roleId', 'roleName', 'roleCounts');
      noMarkers(body, [env.role]);
    },
  },
  [`POST ${S}/activities/:id/objects/:objectId/appraisers`]: {
    unauthorized: async (env) => {
      const p = await env.w.person('无按钮评价者');
      await expectStatus(
        admin(env, env.users.noButtons)('POST', `/activities/${env.A.id}/objects/${env.A.objectId}/appraisers`, {
          ifMatch: 0,
          body: { personId: p.id, roleId: env.w.role('customer') },
        }),
        403,
      );
    },
    outOfScope: async (env) => {
      const p = await env.w.person('越界评价者');
      await expectStatus(
        admin(env, env.users.general)('POST', `/activities/${env.A.id}/objects/${env.A.objectId}/appraisers`, {
          ifMatch: 0,
          body: { personId: p.id, roleId: env.w.role('customer') },
        }),
        404,
      );
    },
    trimming: async (env) => {
      const activity = await freshActivity(env, [env.users.tRel]);
      const object = await env.w.object(activity.id, (await env.w.person('加评价者对象')).id, [env.q.id]);
      const p = await env.w.person('新评价者');
      await writeTwice(
        (key) =>
          admin(env, env.users.tRel)('POST', `/activities/${activity.id}/objects/${object.id}/appraisers`, {
            ifMatch: 0,
            idempotencyKey: key,
            body: { personId: p.id, roleId: env.w.role('customer') },
          }),
        201,
        (body) => without(body, 'source', 'activityId'),
      );
    },
  },
  [`DELETE ${S}/activities/:id/objects/:objectId/appraisers/:relationId`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        admin(env, env.users.noButtons)(
          'DELETE',
          `/activities/${env.A.id}/objects/${env.A.objectId}/appraisers/${env.A.relationId}`,
          { ifMatch: 1 },
        ),
        403,
      )),
    outOfScope: async (env) =>
      void (await expectStatus(
        admin(env, env.users.general)(
          'DELETE',
          `/activities/${env.A.id}/objects/${env.A.objectId}/appraisers/${env.A.relationId}`,
          { ifMatch: 1 },
        ),
        404,
      )),
    trimming: async (env) => {
      const activity = await freshActivity(env, [env.users.tRel]);
      const object = await env.w.object(activity.id, (await env.w.person('删评价者对象')).id, [env.q.id]);
      const relation = await env.w.appraiser(activity.id, object.id, (await env.w.person('将删评价者')).id, 'customer');
      await writeTwice(
        (key) =>
          admin(env, env.users.tRel)(
            'DELETE',
            `/activities/${activity.id}/objects/${object.id}/appraisers/${relation.id}`,
            {
              ifMatch: relation.revision,
              idempotencyKey: key,
            },
          ),
        200,
        (body) => without(body, 'source', 'activityId'),
      );
    },
  },
  [`POST ${S}/activities/:id/objects/:objectId/appraisers/auto`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        admin(env, env.users.noButtons)('POST', `/activities/${env.AU.id}/objects/${env.AU.objectId}/appraisers/auto`, {
          ifMatch: 0,
          body: { roles: ['superior'] },
        }),
        403,
      )),
    outOfScope: async (env) =>
      void (await expectStatus(
        admin(env, env.users.general)('POST', `/activities/${env.AU.id}/objects/${env.AU.objectId}/appraisers/auto`, {
          ifMatch: 0,
          body: { roles: ['superior'] },
        }),
        404,
      )),
    trimming: async (env) =>
      writeTwice(
        (key) =>
          admin(env, env.users.tRel)('POST', `/activities/${env.AU.id}/objects/${env.AU.objectId}/appraisers/auto`, {
            ifMatch: 0,
            idempotencyKey: key,
            body: { roles: ['superior', 'peer'] },
          }),
        200,
        (body) => {
          expect((body.added as unknown[]).length).toBeGreaterThan(0);
          without(body, 'source', 'activityId');
        },
      ),
  },
  [`POST ${S}/activities/:id/appraisers/import`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        admin(env, env.users.noButtons)('POST', `/activities/${env.T.id}/appraisers/import`, {
          ifMatch: 0,
          body: {
            sync: false,
            rows: [
              { objectEmail: env.emails[0], roleId: env.w.role('customer'), name: '导入', email: 'imp-nb@example.com' },
            ],
          },
        }),
        403,
      )),
    outOfScope: async (env) =>
      void (await expectStatus(
        admin(env, env.users.general)('POST', `/activities/${env.A.id}/appraisers/import`, {
          ifMatch: 0,
          body: {
            sync: false,
            rows: [
              {
                objectEmail: env.emails[0],
                roleId: env.w.role('customer'),
                name: '导入',
                email: 'imp-oos@example.com',
              },
            ],
          },
        }),
        404,
      )),
    trimming: async (env) => {
      const activity = await freshActivity(env, [env.users.tRel]);
      const target = await env.w.person('导入对象');
      await env.w.object(activity.id, target.id, [env.q.id]);
      await writeTwice(
        (key) =>
          admin(env, env.users.tRel)('POST', `/activities/${activity.id}/appraisers/import`, {
            ifMatch: 0,
            idempotencyKey: key,
            body: {
              sync: false,
              rows: [
                {
                  objectEmail: target.email,
                  roleId: env.w.role('customer'),
                  name: '导入客户',
                  email: `imp-${key.slice(0, 6)}@example.com`,
                },
              ],
            },
          }),
        200,
        (body) => {
          expect(keysOf(body)).toEqual(['receipts']);
          for (const receipt of body.receipts as object[])
            expect(keysOf(receipt)).toEqual(['relationId', 'row', 'status']);
          noMarkers(body, [target.email]);
        },
      );
      // 看不到评价关系 id：回执只剩行号与处理状态（第 4 轮 R3-P2-1：导入回执不再原样返回）
      const hidden = await freshActivity(env, [env.users.tRelNoId]);
      const hiddenTarget = await env.w.person('导入对象（看不到关系ID）');
      await env.w.object(hidden.id, hiddenTarget.id, [env.q.id]);
      await writeTwice(
        (key) =>
          admin(env, env.users.tRelNoId)('POST', `/activities/${hidden.id}/appraisers/import`, {
            ifMatch: 0,
            idempotencyKey: key,
            body: {
              sync: false,
              rows: [
                {
                  objectEmail: hiddenTarget.email,
                  roleId: env.w.role('customer'),
                  name: '导入客户',
                  email: `imp-noid-${key.slice(0, 6)}@example.com`,
                },
              ],
            },
          }),
        200,
        (body) => {
          for (const receipt of body.receipts as object[]) expect(keysOf(receipt)).toEqual(['row', 'status']);
        },
      );
    },
  },
  [`POST ${S}/activities/:id/objects/:objectId/confirmation`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        admin(env, env.users.noButtons)('POST', `/activities/${env.AU.id}/objects/${env.AU.objectId}/confirmation`, {
          ifMatch: 0,
          body: {},
        }),
        403,
      )),
    outOfScope: async (env) =>
      void (await expectStatus(
        admin(env, env.users.general)('POST', `/activities/${env.AU.id}/objects/${env.AU.objectId}/confirmation`, {
          ifMatch: 0,
          body: {},
        }),
        404,
      )),
    trimming: async (env) =>
      writeTwice(
        (key) =>
          admin(env, env.users.tRel)('POST', `/activities/${env.AU.id}/objects/${env.AU.objectId}/confirmation`, {
            ifMatch: 0,
            idempotencyKey: key,
            body: {},
          }),
        201,
        (body) => expect(body).not.toHaveProperty('activityId'),
      ),
  },
  [`GET ${LINK}`]: {
    unauthorized: async (env) =>
      void (await expectStatus(env.w.api.request('GET', LINK, { tenant: env.w.tenantId }), 404)),
    outOfScope: async (env) => void (await expectStatus(env.w.link(env.L.tcRemoved)('GET', ''), 404)),
    trimming: async (env) => {
      const body = await json(await expectStatus(env.w.link(env.L.t1)('GET', ''), 200));
      expect(body).not.toHaveProperty('appraiser');
      for (const task of body.tasks as object[]) expect(task).not.toHaveProperty('role');
      noMarkers(body, ['作答甲', '作答乙']);
    },
  },
  [`GET ${LINK}/avatars/:attachmentId/content`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        env.w.api.request('GET', `${LINK}/avatars/${randomUUID()}/content`, { tenant: env.w.tenantId }),
        404,
      )),
    outOfScope: async (env) =>
      void (await expectStatus(
        env.w.api.request('GET', `${LINK}/avatars/${randomUUID()}/content`, {
          tenant: env.w2.tenantId,
          headers: { 'x-survey360-token': env.L.t1 },
        }),
        404,
      )),
    trimming: {
      na: '仅返回授权图片字节，没有人员字段投影；实名名单、匿名、真实字节和响应头由 AC-EMP-F058-avatar-token 覆盖',
    },
  },
  [`GET ${LINK}/tasks/:relationId/questionnaires/:questionnaireId`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        env.w.link(env.L.tc)('GET', `/tasks/${env.L.relation1}/questionnaires/${env.q.id}`),
        404,
      )),
    outOfScope: async (env) =>
      void (await expectStatus(
        env.w.link(env.L.t1)('GET', `/tasks/${env.L.relation2}/questionnaires/${env.q.id}`),
        404,
      )),
    trimming: async (env) => {
      const body = await json(
        await expectStatus(env.w.link(env.L.t1)('GET', `/tasks/${env.L.relation1}/questionnaires/${env.q.id}`), 200),
      );
      without(body, 'appraiser', 'role');
      noMarkers(body, ['作答甲']);
    },
  },
  [`PUT ${LINK}/tasks/:relationId/questionnaires/:questionnaireId`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        env.w.api.request('PUT', `${LINK}/tasks/${env.L.relation1}/questionnaires/${env.q.id}`, {
          tenant: env.w.tenantId,
          ifMatch: 0,
          body: { answers: [] },
        }),
        404,
      )),
    outOfScope: async (env) =>
      void (await expectStatus(
        env.w.link(env.L.t1)('PUT', `/tasks/${env.L.relation2}/questionnaires/${env.q.id}`, {
          ifMatch: 0,
          body: { answers: [] },
        }),
        404,
      )),
    trimming: async (env) =>
      writeTwice(
        (key) =>
          env.w.link(env.L.t1)('PUT', `/tasks/${env.L.relation1}/questionnaires/${env.q.id}`, {
            ifMatch: 0,
            idempotencyKey: key,
            body: { answers: [] },
          }),
        200,
        (body) => {
          without(body, 'appraiser');
          noMarkers(body, ['作答甲', '作答乙']);
        },
      ),
  },
  [`POST ${LINK}/tasks/:relationId/questionnaires/:questionnaireId/submit`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        env.w.api.request('POST', `${LINK}/tasks/${env.L.relation1}/questionnaires/${env.q.id}/submit`, {
          tenant: env.w.tenantId,
          ifMatch: 1,
        }),
        404,
      )),
    outOfScope: async (env) =>
      void (await expectStatus(
        env.w.link(env.L.t1)('POST', `/tasks/${env.L.relation2}/questionnaires/${env.q.id}/submit`, { ifMatch: 1 }),
        404,
      )),
    trimming: async (env) => {
      const options = env.q.scales[0]!.options;
      const answers = env.q.questions.map((question) => ({
        itemId: question.id,
        optionId: options.find((o) => o.key === 'v4')!.id,
      }));
      const saved = await json(
        await expectStatus(
          env.w.link(env.L.t2)('PUT', `/tasks/${env.L.relation2}/questionnaires/${env.q.id}`, {
            ifMatch: 0,
            body: { answers },
          }),
          200,
        ),
      );
      await writeTwice(
        (key) =>
          env.w.link(env.L.t2)('POST', `/tasks/${env.L.relation2}/questionnaires/${env.q.id}/submit`, {
            ifMatch: saved.revision as number,
            idempotencyKey: key,
          }),
        200,
        (body) => {
          without(body, 'appraiser');
          noMarkers(body, ['作答甲', '作答乙']);
        },
      );
    },
  },
  [`GET ${LINK}/confirmation/candidates`]: {
    unauthorized: async (env) =>
      void (await expectStatus(env.w.link(env.L.t1)('GET', '/confirmation/candidates'), 404)),
    outOfScope: async (env) =>
      void (await expectStatus(env.w.link(env.L.tcRemoved)('GET', '/confirmation/candidates'), 404)),
    trimming: async (env) => {
      const body = await json(await expectStatus(env.w.link(env.L.tc)('GET', '/confirmation/candidates'), 200));
      expect(body.items!.length).toBeGreaterThan(0);
      for (const item of body.items!) {
        expect(keysOf(item)).toEqual(['avatar', 'department', 'id', 'name', 'position']);
        expect(item.avatar).toBeNull();
      }
      noMarkers(body, env.emails);
    },
  },
  [`POST ${LINK}/confirmation/appraisers`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        env.w.link(env.L.t1)('POST', '/confirmation/appraisers', {
          ifMatch: 0,
          body: { roleId: env.w.role('customer') },
        }),
        404,
      )),
    outOfScope: async (env) =>
      void (await expectStatus(
        env.w.link(env.L.tcRemoved)('POST', '/confirmation/appraisers', {
          ifMatch: 0,
          body: { person: { name: '外部客户', email: 'conf-oos@example.com' }, roleId: env.w.role('customer') },
        }),
        404,
      )),
    trimming: async (env) => {
      const revision = await confirmRevision(env);
      await writeTwice(
        (key) =>
          env.w.link(env.L.tc)('POST', '/confirmation/appraisers', {
            ifMatch: revision,
            idempotencyKey: key,
            body: {
              person: { name: '确认加的客户', email: `conf-${key.slice(0, 6)}@example.com` },
              roleId: env.w.role('customer'),
            },
          }),
        201,
        (body) => expect(keysOf(body)).toEqual(['appraiserPersonId', 'id', 'roleId']),
      );
    },
  },
  [`DELETE ${LINK}/confirmation/appraisers/:relationId`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        env.w.link(env.L.t1)('DELETE', `/confirmation/appraisers/${env.L.relation2}`, { ifMatch: 1 }),
        404,
      )),
    outOfScope: async (env) => {
      // 用当前 revision：确认单只管自己评价对象的关系，同活动另一个对象的关系按不存在处理
      const revision = await confirmRevision(env);
      await expectStatus(
        env.w.link(env.L.tc)('DELETE', `/confirmation/appraisers/${env.L.otherObjectRelation}`, { ifMatch: revision }),
        404,
      );
    },
    trimming: async (env) => {
      const added = await json(
        await expectStatus(
          env.w.link(env.L.tc)('POST', '/confirmation/appraisers', {
            ifMatch: await confirmRevision(env),
            body: {
              person: { name: '待删客户', email: `del-${randomUUID().slice(0, 6)}@example.com` },
              roleId: env.w.role('customer'),
            },
          }),
          201,
        ),
      );
      const revision = await confirmRevision(env);
      await writeTwice(
        (key) =>
          env.w.link(env.L.tc)('DELETE', `/confirmation/appraisers/${added.id as string}`, {
            ifMatch: revision,
            idempotencyKey: key,
          }),
        200,
        (body) => expect(keysOf(body)).toEqual(['id', 'removed']),
      );
    },
  },
  [`POST ${LINK}/confirmation/submit`]: {
    unauthorized: async (env) =>
      void (await expectStatus(env.w.link(env.L.t1)('POST', '/confirmation/submit', { ifMatch: 1 }), 404)),
    outOfScope: async (env) =>
      void (await expectStatus(env.w.link(env.L.tcRemoved)('POST', '/confirmation/submit', { ifMatch: 1 }), 404)),
    trimming: async (env) => {
      const revision = await confirmRevision(env);
      await writeTwice(
        (key) => env.w.link(env.L.tc)('POST', '/confirmation/submit', { ifMatch: revision, idempotencyKey: key }),
        200,
        (body) => {
          // 确认页例外：确认人负责设置关系，列出本对象评价者；不带答卷与其他对象的信息
          without(body, 'answers', 'score');
          noMarkers(body, ['将移除对象', '另一对象']);
        },
      );
    },
  },
};

/** PR-B 共用场景（只建一次）：计分活动的答卷与报告、转发链接、待办活动（不显示姓名与角色）、他租户的套卷模板。 */
interface PrB {
  readonly sheetId: string;
  readonly reportId: string;
  readonly reportToken: string;
  readonly todo: { id: string; user: string; activityId: string; relationId: string; otherRelation: string };
  readonly w2Template: string;
  readonly template: string;
}
let prbCache: Promise<PrB> | undefined;
const rowsOf = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
function prb(env: Env): Promise<PrB> {
  prbCache ??= (async () => {
    const { w } = env;
    const [sheet] = rowsOf<{ id: string }>(
      await withTenant(w.db, w.tenantId, (tx) =>
        tx.execute(sql`SELECT id FROM survey360_sheets WHERE activity_id = ${env.SC.id}::uuid`),
      ),
    );
    await w.ok(w.request('POST', `/activities/${env.SC.id}/reports/generate`, { body: {} }));
    const reports = await w.ok<{ items: { id: string }[] }>(w.request('GET', `/activities/${env.SC.id}/reports`));
    await w.ok(
      w.request('POST', `/activities/${env.SC.id}/reports/forward`, {
        body: { mode: 'others', others: [{ name: 'HRBP', email: 'guard-hrbp@example.com' }] },
      }),
    );
    // 转发邮件的令牌在 payload.sealed 里（DEC-377②），夹具解封后给出 token；取最后一封
    const mail = { token: (await outbox(w, 'survey360.report_forward')).at(-1)!.payload.token };
    const people = (await w.ok<{ items: PersonView[] }>(w.request('GET', '/people?pageSize=200'))).items;
    const manager = people.find((p) => p.name === '经理M')!;
    const activity = await w.activity({ name: '待办活动', showAppraiserName: false, roleDisplay: 'hidden' });
    const object = await w.object(activity.id, (await w.person('待办对象')).id, [env.q.id]);
    const relation = await w.appraiser(activity.id, object.id, manager.id, 'peer');
    const other = await w.appraiser(activity.id, object.id, (await w.person('待办外部评价者')).id, 'customer');
    await w.transition(activity.id, 'enable');
    await w.ok(w.request('POST', `/activities/${activity.id}/todos`, { body: { personIds: [manager.id] } }));
    const [link] = rowsOf<{ user_id: string }>(
      await withTenant(w.db, w.tenantId, (tx) =>
        tx.execute(
          sql`SELECT user_id FROM permission_user_person_links WHERE employee_id = ${manager.employeeId}::uuid`,
        ),
      ),
    );
    const todos = await w.ok<{ items: { id: string; activityId: string }[] }>(
      w.api.request('GET', `${S}/my/todos`, { user: link!.user_id, tenant: w.tenantId }),
    );
    const w2Template = await env.w2.ok<{ id: string }>(
      env.w2.request('POST', '/questionnaire-templates', { ifMatch: 0, body: { name: '他租户模板', type: 'rating' } }),
      201,
    );
    const template = await w.ok<{ id: string }>(
      w.request('POST', '/questionnaire-templates', { ifMatch: 0, body: { name: '守卫模板', type: 'rating' } }),
      201,
    );
    return {
      sheetId: sheet!.id,
      reportId: reports.items[0]!.id,
      reportToken: mail!.token,
      todo: {
        id: todos.items.find((t) => t.activityId === activity.id)!.id,
        user: link!.user_id,
        activityId: activity.id,
        relationId: relation.id,
        otherRelation: other.id,
      },
      w2Template: w2Template.id,
      template: template.id,
    };
  })();
  return prbCache;
}

/** 新建、计分并停用的活动（答卷一份），授权给 grantees：屏蔽 / 重新作答的字段裁剪用，不动共用的计分活动。 */
async function freshScored(env: Env, grantees: string[]) {
  const { w, q } = env;
  const activity = await w.activity({ name: `计分${randomUUID().slice(0, 4)}` });
  const object = await w.object(activity.id, (await w.person('裁剪对象')).id, [q.id]);
  const rater = await w.person('裁剪评价者');
  const relation = await w.appraiser(activity.id, object.id, rater.id, 'peer');
  await w.transition(activity.id, 'enable');
  await w.answer(await w.token(activity.id, rater.id), relation.id, q, ['v4', 'v5']);
  await w.transition(activity.id, 'disable');
  await grantTo(w, activity.id, grantees);
  const [sheet] = rowsOf<{ id: string; revision: number }>(
    await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`SELECT id, revision FROM survey360_sheets WHERE activity_id = ${activity.id}::uuid`),
    ),
  );
  return { activity, relation, sheet: sheet! };
}

const RECEIPT = '回执只有协议字段（人数与原站提示文案），不含任何 360 对象字段，不按对象字段裁剪（asIs）';
const my =
  (env: Env, user: string) =>
  (method: string, path: string, opts: RequestOptions = {}) =>
    env.w.api.request(method, `${S}/my${path}`, { ...opts, user, tenant: env.w.tenantId });
const todoTask = (p: PrB, relationId = p.todo.relationId) =>
  `/todos/${p.todo.id}/tasks/${relationId}/questionnaires/${'Q'}`;

/** 活动内批量命令（发送 / 取消待办、邮件邀请、屏蔽疑似、恢复、生成 / 转发报告）：未授权 403、无授权活动 404。 */
function activityCommand(path: string, body: Record<string, unknown>, unauthorized: (env: Env) => string): RouteCases {
  return {
    unauthorized: async (env) =>
      void (await expectStatus(
        admin(env, unauthorized(env))('POST', `/activities/${env.SC.id}${path}`, { body }),
        403,
      )),
    outOfScope: async (env) =>
      void (await expectStatus(
        admin(env, env.users.general)('POST', `/activities/${env.SC.id}${path}`, { body }),
        404,
      )),
    trimming: { na: RECEIPT },
  };
}

const PR_B_CASES: Record<string, RouteCases> = {
  [`GET ${S}/activities/:id/progress`]: {
    unauthorized: async (env) =>
      void (await expectStatus(admin(env, env.users.onlyActivity)('GET', `/activities/${env.SC.id}/progress`), 403)),
    outOfScope: async (env) =>
      void (await expectStatus(admin(env, env.users.general)('GET', `/activities/${env.SC.id}/progress`), 404)),
    trimming: async (env) => {
      const body = await json(
        await expectStatus(admin(env, env.users.tProgress)('GET', `/activities/${env.SC.id}/progress`), 200),
      );
      expect(body.items!.length).toBeGreaterThan(0);
      without(body, 'email');
    },
  },
  [`GET ${S}/activities/:id/progress/:personId`]: {
    unauthorized: async (env) => {
      const items = (await json(await sa(env)('GET', `/activities/${env.SC.id}/progress`))).items!;
      await expectStatus(
        admin(env, env.users.onlyActivity)('GET', `/activities/${env.SC.id}/progress/${items[0]!.personId}`),
        403,
      );
    },
    outOfScope: async (env) => {
      const items = (await json(await sa(env)('GET', `/activities/${env.SC.id}/progress`))).items!;
      await expectStatus(
        admin(env, env.users.general)('GET', `/activities/${env.SC.id}/progress/${items[0]!.personId}`),
        404,
      );
      // 不是该活动评价者的人员：与不存在同一 404
      await expectStatus(sa(env)('GET', `/activities/${env.SC.id}/progress/${randomUUID()}`), 404);
    },
    trimming: async (env) => {
      const items = (await json(await sa(env)('GET', `/activities/${env.SC.id}/progress`))).items!;
      const body = await json(
        await expectStatus(
          admin(env, env.users.tProgress)('GET', `/activities/${env.SC.id}/progress/${items[0]!.personId}`),
          200,
        ),
      );
      expect(body.items!.length).toBe(1);
      without(body, 'roleName');
    },
  },
  [`POST ${S}/activities/:id/relations/:relationId/reanswer`]: {
    unauthorized: async (env) => {
      const before = await json(await sa(env)('GET', `/activities/${env.SC.id}/progress`));
      await expectStatus(
        admin(env, env.users.noButtons)('POST', `/activities/${env.SC.id}/relations/${env.SC.objectId}/reanswer`, {
          ifMatch: 1,
        }),
        403,
      );
      expect(await json(await sa(env)('GET', `/activities/${env.SC.id}/progress`))).toEqual(before);
    },
    outOfScope: async (env) => {
      const relation = (await json(await sa(env)('GET', `/activities/${env.SC.id}/progress`))).items!;
      const detail = await json(await sa(env)('GET', `/activities/${env.SC.id}/progress/${relation[0]!.personId}`));
      const row = detail.items![0]!;
      await expectStatus(
        admin(env, env.users.general)('POST', `/activities/${env.SC.id}/relations/${row.relationId}/reanswer`, {
          ifMatch: row.revision as number,
        }),
        404,
      );
    },
    trimming: async (env) => {
      const f = await freshScored(env, [env.users.tAnswer]);
      const res = await expectStatus(
        admin(env, env.users.tAnswer)('POST', `/activities/${f.activity.id}/relations/${f.relation.id}/reanswer`, {
          ifMatch: f.relation.revision,
        }),
        200,
      );
      const body = await json(res);
      expect(body.status).toBe('not_started');
      without(body, 'roleName');
    },
  },
  [`POST ${S}/activities/:id/todos`]: activityCommand('/todos', {}, (env) => env.users.noButtons),
  [`POST ${S}/activities/:id/todos/cancel`]: activityCommand('/todos/cancel', {}, (env) => env.users.noButtons),
  [`POST ${S}/activities/:id/invitations`]: activityCommand('/invitations', {}, (env) => env.users.noButtons),
  [`POST ${S}/activities/:id/sheets/block-suspected`]: activityCommand(
    '/sheets/block-suspected',
    {},
    (env) => env.users.noButtons,
  ),
  [`POST ${S}/activities/:id/sheets/unblock-all`]: activityCommand(
    '/sheets/unblock-all',
    {},
    (env) => env.users.noButtons,
  ),
  [`POST ${S}/activities/:id/reports/generate`]: activityCommand('/reports/generate', {}, (env) => env.users.tResult),
  [`POST ${S}/activities/:id/reports/forward`]: activityCommand(
    '/reports/forward',
    { mode: 'others', others: [{ name: 'X', email: 'guard-x@example.com' }] },
    (env) => env.users.tResult,
  ),
  [`POST ${S}/activities/:id/reports/forward/preview`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        admin(env, env.users.tResult)('POST', `/activities/${env.SC.id}/reports/forward/preview`, {
          body: { mode: 'reporting', targets: ['self'] },
        }),
        403,
      )),
    outOfScope: async (env) =>
      void (await expectStatus(
        admin(env, env.users.general)('POST', `/activities/${env.SC.id}/reports/forward/preview`, {
          body: { mode: 'reporting', targets: ['self'] },
        }),
        404,
      )),
    trimming: async (env) => {
      await prb(env);
      // 看不到报告正文（生成时间、套卷）的转发人：预览同转发一样 403
      await expectStatus(
        admin(env, env.users.tReport)('POST', `/activities/${env.SC.id}/reports/forward/preview`, {
          body: { mode: 'others', others: [{ name: 'Y', email: 'guard-y@example.com' }] },
        }),
        403,
      );
      const body = await json(
        await expectStatus(
          admin(env, env.users.tForward)('POST', `/activities/${env.SC.id}/reports/forward/preview`, {
            body: { mode: 'others', others: [{ name: 'Y', email: 'guard-y@example.com' }] },
          }),
          200,
        ),
      );
      expect(body.items!.length).toBe(1);
      without(body, 'recipientEmail');
      noMarkers(body, ['guard-y@example.com']);
    },
  },
  [`GET ${S}/my/todos`]: {
    unauthorized: async (env) =>
      // 不是本租户成员（他租户的管理员）
      void (await expectStatus(
        env.w.api.request('GET', `${S}/my/todos`, { user: env.w2.admin, tenant: env.w.tenantId }),
        403,
      )),
    outOfScope: async (env) => {
      const p = await prb(env);
      const body = await json(await expectStatus(my(env, env.users.outsider)('GET', '/todos'), 200));
      expect(JSON.stringify(body)).not.toContain(p.todo.id);
    },
    trimming: { na: '只返回本人账号的待办（标题、活动名称、状态、时间），不是 360 对象字段，不需要 360 身份' },
  },
  [`GET ${S}/my/todos/:todoId/answer`]: {
    unauthorized: async (env) => {
      const p = await prb(env);
      await expectStatus(my(env, env.users.outsider)('GET', `/todos/${p.todo.id}/answer`), 404);
    },
    outOfScope: async (env) => {
      const p = await prb(env);
      await expectStatus(my(env, p.todo.user)('GET', `/todos/${randomUUID()}/answer`), 404);
    },
    trimming: async (env) => {
      const p = await prb(env);
      const body = await json(await expectStatus(my(env, p.todo.user)('GET', `/todos/${p.todo.id}/answer`), 200));
      expect(body).not.toHaveProperty('appraiser');
      for (const task of body.tasks as object[]) expect(task).not.toHaveProperty('role');
      noMarkers(body, ['待办外部评价者', '经理M']);
    },
  },
  [`GET ${S}/my/todos/:todoId/avatars/:attachmentId/content`]: {
    unauthorized: async (env) => {
      const p = await prb(env);
      await expectStatus(
        my(env, env.users.outsider)('GET', `/todos/${p.todo.id}/avatars/${randomUUID()}/content`),
        404,
      );
    },
    outOfScope: async (env) => {
      const p = await prb(env);
      await expectStatus(my(env, p.todo.user)('GET', `/todos/${randomUUID()}/avatars/${randomUUID()}/content`), 404);
    },
    trimming: {
      na: '仅返回本单具名人员的头像字节，没有人员字段投影；与令牌链接的头像路由同一判定（AC-360-B-01 覆盖待办入口的地址与字节）',
    },
  },
  [`GET ${S}/my/todos/:todoId/tasks/:relationId/questionnaires/:questionnaireId`]: {
    unauthorized: async (env) => {
      const p = await prb(env);
      await expectStatus(my(env, env.users.outsider)('GET', todoTask(p).replace('Q', env.q.id)), 404);
    },
    outOfScope: async (env) => {
      const p = await prb(env);
      await expectStatus(my(env, p.todo.user)('GET', todoTask(p, p.todo.otherRelation).replace('Q', env.q.id)), 404);
    },
    trimming: async (env) => {
      const p = await prb(env);
      const body = await json(await expectStatus(my(env, p.todo.user)('GET', todoTask(p).replace('Q', env.q.id)), 200));
      without(body, 'appraiser', 'role');
    },
  },
  [`PUT ${S}/my/todos/:todoId/tasks/:relationId/questionnaires/:questionnaireId`]: {
    unauthorized: async (env) => {
      const p = await prb(env);
      await expectStatus(
        my(env, env.users.outsider)('PUT', todoTask(p).replace('Q', env.q.id), { ifMatch: 0, body: { answers: [] } }),
        404,
      );
    },
    outOfScope: async (env) => {
      const p = await prb(env);
      await expectStatus(
        my(env, p.todo.user)('PUT', todoTask(p, p.todo.otherRelation).replace('Q', env.q.id), {
          ifMatch: 0,
          body: { answers: [] },
        }),
        404,
      );
    },
    trimming: {
      na: '答卷视图只有本人作答的内容（状态、版本、答案、建议），与链接作答同一出口，不含其他评价者或对象字段',
    },
  },
  [`POST ${S}/my/todos/:todoId/tasks/:relationId/questionnaires/:questionnaireId/submit`]: {
    unauthorized: async (env) => {
      const p = await prb(env);
      await expectStatus(
        my(env, env.users.outsider)('POST', `${todoTask(p).replace('Q', env.q.id)}/submit`, { ifMatch: 1 }),
        404,
      );
    },
    outOfScope: async (env) => {
      const p = await prb(env);
      await expectStatus(
        my(env, p.todo.user)('POST', `${todoTask(p, p.todo.otherRelation).replace('Q', env.q.id)}/submit`, {
          ifMatch: 1,
        }),
        404,
      );
    },
    trimming: {
      na: '答卷视图只有本人作答的内容（状态、版本、答案、建议），与链接作答同一出口，不含其他评价者或对象字段',
    },
  },
  [`GET ${S}/activities/:id/sheets`]: {
    unauthorized: async (env) =>
      void (await expectStatus(admin(env, env.users.onlyActivity)('GET', `/activities/${env.SC.id}/sheets`), 403)),
    outOfScope: async (env) =>
      void (await expectStatus(admin(env, env.users.general)('GET', `/activities/${env.SC.id}/sheets`), 404)),
    trimming: async (env) => {
      const body = await json(
        await expectStatus(admin(env, env.users.tAnswer)('GET', `/activities/${env.SC.id}/sheets`), 200),
      );
      expect(body.items!.length).toBe(1);
      without(body, 'total', 'relationId', 'appraiserPersonId', 'appraiser');
      noMarkers(body, ['评价者甲']);
    },
  },
  [`POST ${S}/activities/:id/sheets/:sheetId/block`]: {
    unauthorized: async (env) => {
      const p = await prb(env);
      await expectStatus(
        admin(env, env.users.noButtons)('POST', `/activities/${env.SC.id}/sheets/${p.sheetId}/block`, { ifMatch: 1 }),
        403,
      );
    },
    outOfScope: async (env) => {
      const p = await prb(env);
      await expectStatus(
        admin(env, env.users.general)('POST', `/activities/${env.SC.id}/sheets/${p.sheetId}/block`, { ifMatch: 1 }),
        404,
      );
    },
    trimming: async (env) => {
      const f = await freshScored(env, [env.users.tAnswer]);
      await writeTwice(
        (key) =>
          admin(env, env.users.tAnswer)('POST', `/activities/${f.activity.id}/sheets/${f.sheet.id}/block`, {
            ifMatch: f.sheet.revision,
            idempotencyKey: key,
          }),
        200,
        (body) => {
          expect(body.blocked).toBe(true);
          without(body, 'total');
        },
      );
    },
  },
  [`POST ${S}/activities/:id/sheets/:sheetId/unblock`]: {
    unauthorized: async (env) => {
      const p = await prb(env);
      await expectStatus(
        admin(env, env.users.noButtons)('POST', `/activities/${env.SC.id}/sheets/${p.sheetId}/unblock`, { ifMatch: 1 }),
        403,
      );
    },
    outOfScope: async (env) => {
      const p = await prb(env);
      await expectStatus(
        admin(env, env.users.general)('POST', `/activities/${env.SC.id}/sheets/${p.sheetId}/unblock`, { ifMatch: 1 }),
        404,
      );
    },
    trimming: async (env) => {
      const f = await freshScored(env, [env.users.tAnswer]);
      const blocked = await json(
        await expectStatus(
          sa(env)('POST', `/activities/${f.activity.id}/sheets/${f.sheet.id}/block`, { ifMatch: f.sheet.revision }),
          200,
        ),
      );
      const body = await json(
        await expectStatus(
          admin(env, env.users.tAnswer)('POST', `/activities/${f.activity.id}/sheets/${f.sheet.id}/unblock`, {
            ifMatch: blocked.revision as number,
          }),
          200,
        ),
      );
      expect(body.blocked).toBe(false);
      without(body, 'total');
    },
  },
  [`GET ${S}/report-template`]: {
    unauthorized: async (env) =>
      void (await expectStatus(admin(env, env.users.onlyActivity)('GET', '/report-template'), 403)),
    outOfScope: async (env) => {
      const own = await json(await expectStatus(sa(env)('GET', '/report-template'), 200));
      const other = await json(await expectStatus(env.w2.request('GET', '/report-template'), 200));
      expect(own.id).not.toBe(other.id);
    },
    trimming: async (env) => {
      const body = await json(await expectStatus(admin(env, env.users.tTemplate)('GET', '/report-template'), 200));
      expect(body).not.toHaveProperty('showTextRole');
    },
  },
  [`PUT ${S}/report-template`]: {
    unauthorized: async (env) => {
      const before = await json(await sa(env)('GET', '/report-template'));
      await expectStatus(
        admin(env, env.users.noButtons)('PUT', '/report-template', {
          ifMatch: before.revision as number,
          body: { showTextRole: true },
        }),
        403,
      );
      expect(await json(await sa(env)('GET', '/report-template'))).toEqual(before);
    },
    outOfScope: async (env) => {
      const other = await json(await env.w2.request('GET', '/report-template'));
      const own = await json(await sa(env)('GET', '/report-template'));
      await expectStatus(
        sa(env)('PUT', '/report-template', { ifMatch: own.revision as number, body: { showTextRole: true } }),
        200,
      );
      expect(await json(await env.w2.request('GET', '/report-template'))).toEqual(other);
    },
    trimming: async (env) => {
      const before = await json(await sa(env)('GET', '/report-template'));
      await writeTwice(
        (key) =>
          admin(env, env.users.tTemplateRev)('PUT', '/report-template', {
            ifMatch: before.revision as number,
            idempotencyKey: key,
            body: { showTextRole: true },
          }),
        200,
        (body) => expect(body).not.toHaveProperty('revision'),
      );
    },
  },
  [`GET ${S}/activities/:id/reports`]: {
    unauthorized: async (env) =>
      void (await expectStatus(admin(env, env.users.onlyActivity)('GET', `/activities/${env.SC.id}/reports`), 403)),
    outOfScope: async (env) =>
      void (await expectStatus(admin(env, env.users.general)('GET', `/activities/${env.SC.id}/reports`), 404)),
    trimming: async (env) => {
      await prb(env);
      const body = await json(
        await expectStatus(admin(env, env.users.tReport)('GET', `/activities/${env.SC.id}/reports`), 200),
      );
      expect(body.items![0]!.status).toBe('generated');
      without(body, 'generatedAt');
    },
  },
  [`GET ${S}/activities/:id/reports/:reportId`]: {
    unauthorized: async (env) => {
      const p = await prb(env);
      await expectStatus(
        admin(env, env.users.onlyActivity)('GET', `/activities/${env.SC.id}/reports/${p.reportId}`),
        403,
      );
    },
    outOfScope: async (env) => {
      const p = await prb(env);
      await expectStatus(admin(env, env.users.general)('GET', `/activities/${env.SC.id}/reports/${p.reportId}`), 404);
      // 报告须属于该活动
      await expectStatus(sa(env)('GET', `/activities/${env.A.id}/reports/${p.reportId}`), 404);
    },
    trimming: async (env) => {
      const p = await prb(env);
      const body = await json(
        await expectStatus(admin(env, env.users.tReport)('GET', `/activities/${env.SC.id}/reports/${p.reportId}`), 200),
      );
      expect(body).toHaveProperty('cover');
      expect(body).not.toHaveProperty('questionnaires');
      expect(body).not.toHaveProperty('generatedAt');
    },
  },
  [`GET ${S}/activities/:id/score-tables`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        admin(env, env.users.onlyActivity)('GET', `/activities/${env.SC.id}/score-tables?level=questionnaire`),
        403,
      )),
    outOfScope: async (env) =>
      void (await expectStatus(
        admin(env, env.users.general)('GET', `/activities/${env.SC.id}/score-tables?level=questionnaire`),
        404,
      )),
    trimming: async (env) => {
      const body = await json(
        await expectStatus(
          admin(env, env.users.tResult)('GET', `/activities/${env.SC.id}/score-tables?level=questionnaire`),
          200,
        ),
      );
      expect(body.items!.length).toBe(1);
      without(body, 'roleName');
    },
  },
  [`GET ${S}/questionnaire-templates`]: {
    unauthorized: async (env) =>
      void (await expectStatus(admin(env, env.users.onlyActivity)('GET', '/questionnaire-templates'), 403)),
    outOfScope: async (env) => {
      const p = await prb(env);
      const body = await json(await expectStatus(sa(env)('GET', '/questionnaire-templates'), 200));
      expect(JSON.stringify(body)).not.toContain(p.w2Template);
    },
    trimming: async (env) => {
      await prb(env);
      const body = await json(await expectStatus(admin(env, env.users.tQ)('GET', '/questionnaire-templates'), 200));
      expect(body.items!.length).toBeGreaterThan(0);
      without(body, 'createdBy');
    },
  },
  [`GET ${S}/questionnaire-templates/:id`]: {
    unauthorized: async (env) => {
      const p = await prb(env);
      await expectStatus(admin(env, env.users.onlyActivity)('GET', `/questionnaire-templates/${p.template}`), 403);
    },
    outOfScope: async (env) => {
      const p = await prb(env);
      await expectStatus(sa(env)('GET', `/questionnaire-templates/${p.w2Template}`), 404);
      // 套卷与模板互不可见
      await expectStatus(sa(env)('GET', `/questionnaire-templates/${env.q.id}`), 404);
    },
    trimming: async (env) => {
      const p = await prb(env);
      const body = await json(
        await expectStatus(admin(env, env.users.tQ)('GET', `/questionnaire-templates/${p.template}`), 200),
      );
      without(body, 'guide', 'createdBy');
    },
  },
  [`POST ${S}/questionnaire-templates`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        admin(env, env.users.noButtons)('POST', '/questionnaire-templates', {
          ifMatch: 0,
          body: { name: '无权', type: 'rating' },
        }),
        403,
      )),
    outOfScope: { na: '新建模板是租户级配置：不引用活动、人员或其他租户的资源；他租户隔离由读用例覆盖' },
    trimming: async (env) =>
      writeTwice(
        (key) =>
          admin(env, env.users.tQOwner)('POST', '/questionnaire-templates', {
            ifMatch: 0,
            idempotencyKey: key,
            body: { name: '裁剪模板', type: 'rating', guide: 'GUIDE_SECRET' },
          }),
        201,
        (body) => {
          without(body, 'createdBy');
          expect(body.guide).toBe('GUIDE_SECRET');
        },
      ),
  },
  [`PUT ${S}/questionnaire-templates/:id`]: {
    unauthorized: async (env) => {
      const p = await prb(env);
      await expectStatus(
        admin(env, env.users.noButtons)('PUT', `/questionnaire-templates/${p.template}`, {
          ifMatch: 1,
          body: { name: 'x' },
        }),
        403,
      );
    },
    outOfScope: async (env) => {
      const p = await prb(env);
      await expectStatus(
        sa(env)('PUT', `/questionnaire-templates/${p.w2Template}`, { ifMatch: 1, body: { name: 'x' } }),
        404,
      );
    },
    trimming: async (env) => {
      const own = await json(
        await expectStatus(
          admin(env, env.users.tQOwner)('POST', '/questionnaire-templates', {
            ifMatch: 0,
            body: { name: '改名模板', type: 'rating' },
          }),
          201,
        ),
      );
      const body = await json(
        await expectStatus(
          admin(env, env.users.tQOwner)('PUT', `/questionnaire-templates/${own.id}`, {
            ifMatch: own.revision as number,
            body: { guide: 'GUIDE_X' },
          }),
          200,
        ),
      );
      without(body, 'createdBy');
    },
  },
  [`DELETE ${S}/questionnaire-templates/:id`]: {
    unauthorized: async (env) => {
      const p = await prb(env);
      await expectStatus(
        admin(env, env.users.noButtons)('DELETE', `/questionnaire-templates/${p.template}`, { ifMatch: 1 }),
        403,
      );
      await expectStatus(sa(env)('GET', `/questionnaire-templates/${p.template}`), 200);
    },
    outOfScope: async (env) => {
      const p = await prb(env);
      await expectStatus(sa(env)('DELETE', `/questionnaire-templates/${p.w2Template}`, { ifMatch: 1 }), 404);
    },
    trimming: { na: '删除回执只有 id 与 deleted 协议键，不含模板字段' },
  },
  [`POST ${S}/questionnaires/:id/save-as-template`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        admin(env, env.users.noButtons)('POST', `/questionnaires/${env.q.id}/save-as-template`, {
          ifMatch: 0,
          body: { name: 'x' },
        }),
        403,
      )),
    outOfScope: async (env) =>
      void (await expectStatus(
        sa(env)('POST', `/questionnaires/${env.w2Ids.questionnaire}/save-as-template`, {
          ifMatch: 0,
          body: { name: 'x' },
        }),
        404,
      )),
    trimming: async (env) =>
      writeTwice(
        (key) =>
          admin(env, env.users.tQOwner)('POST', `/questionnaires/${env.q.id}/save-as-template`, {
            ifMatch: 0,
            idempotencyKey: key,
            body: { name: '另存模板' },
          }),
        201,
        (body) => without(body, 'createdBy'),
      ),
  },
  [`POST ${S}/questionnaire-templates/:id/instantiate`]: {
    unauthorized: async (env) => {
      const p = await prb(env);
      await expectStatus(
        admin(env, env.users.noButtons)('POST', `/questionnaire-templates/${p.template}/instantiate`, {
          ifMatch: 0,
          body: { name: 'x' },
        }),
        403,
      );
    },
    outOfScope: async (env) => {
      const p = await prb(env);
      await expectStatus(
        sa(env)('POST', `/questionnaire-templates/${p.w2Template}/instantiate`, { ifMatch: 0, body: { name: 'x' } }),
        404,
      );
    },
    trimming: async (env) => {
      const p = await prb(env);
      await writeTwice(
        (key) =>
          admin(env, env.users.tQOwner)('POST', `/questionnaire-templates/${p.template}/instantiate`, {
            ifMatch: 0,
            idempotencyKey: key,
            body: { name: '模板新建' },
          }),
        201,
        (body) => without(body, 'createdBy'),
      );
    },
  },
  // F-076 通用网址门户：认证入口，凭据在请求体里；失败一律同一个 401（逐字节相同由 AC-360-F076-13 断言）
  [`POST /api/survey360/portal/login`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        env.w.api.request('POST', '/api/survey360/portal/login', {
          tenant: env.w.tenantId,
          body: { serial: 'ZZZZZZZZZZ', password: 'ZZZZZZZZ' },
        }),
        401,
      )),
    outOfScope: { na: '凭据绑定租户：别的租户的序列号与不存在同一个 401（AC-360-F076-13 逐字节核对）' },
    trimming: { na: '回执只有会话令牌与过期时间，不含任何对象字段' },
  },
  // 登出：持有令牌才能作废对应会话；无效 / 缺失 / 二次登出一律 204，不返回任何内容
  [`POST /api/survey360/portal/logout`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        env.w.api.request('POST', '/api/survey360/portal/logout', {
          tenant: env.w.tenantId,
          headers: { 'x-survey360-session': 'not-a-session' },
        }),
        204,
      )),
    outOfScope: { na: '令牌摘要只在本租户的会话表里匹配，别的租户的令牌作废不了任何会话' },
    trimming: { na: '204 无内容，响应体没有任何字段' },
  },
  [`GET /api/survey360/report-link`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        env.w.api.request('GET', '/api/survey360/report-link', { tenant: env.w.tenantId }),
        404,
      )),
    outOfScope: async (env) => {
      const p = await prb(env);
      // 他租户：同一令牌换租户头即 404
      await expectStatus(
        env.w.api.request('GET', '/api/survey360/report-link', {
          tenant: env.w2.tenantId,
          headers: { 'x-survey360-token': p.reportToken },
        }),
        404,
      );
    },
    trimming: async (env) => {
      const p = await prb(env);
      const body = await json(
        await expectStatus(
          env.w.api.request('GET', '/api/survey360/report-link', {
            tenant: env.w.tenantId,
            headers: { 'x-survey360-token': p.reportToken },
          }),
          200,
        ),
      );
      expect(keysOf((body.reports as object[])[0])).toEqual(['id', 'objectName', 'templateName']);
    },
  },
  [`GET /api/survey360/report-link/reports/:reportId`]: {
    unauthorized: async (env) => {
      const p = await prb(env);
      await expectStatus(
        env.w.api.request('GET', `/api/survey360/report-link/reports/${p.reportId}`, { tenant: env.w.tenantId }),
        404,
      );
    },
    outOfScope: async (env) => {
      const p = await prb(env);
      await expectStatus(
        env.w.api.request('GET', `/api/survey360/report-link/reports/${randomUUID()}`, {
          tenant: env.w.tenantId,
          headers: { 'x-survey360-token': p.reportToken },
        }),
        404,
      );
    },
    trimming: async (env) => {
      const p = await prb(env);
      const body = await json(
        await expectStatus(
          env.w.api.request('GET', `/api/survey360/report-link/reports/${p.reportId}`, {
            tenant: env.w.tenantId,
            headers: { 'x-survey360-token': p.reportToken },
          }),
          200,
        ),
      );
      // 报告快照不带任何评价者标识
      noMarkers(body, ['评价者甲', ...env.emails.slice(1, 2)]);
      without(body, 'appraiserPersonId', 'relationId', 'sheetId');
    },
  },
};
Object.assign(ROUTE_CASES, PR_B_CASES);

/**
 * F-060：报表 PNG / 报告 PDF 下载。三类反向用例与对应 JSON 接口同口径；字段裁剪格另断言文件由“裁剪后的 JSON”生成
 * （逐字节等于把该 JSON 交给渲染函数的结果；渲染用项目内置字体，F-080，下载一律 200）。
 */
const DOWNLOAD_OK = 200;
const sameFile = async (res: Response, expected: () => Promise<Buffer>) => {
  if (res.status === 200) expect(Buffer.from(await res.arrayBuffer()).equals(await expected())).toBe(true);
};
const F060_CASES: Record<string, RouteCases> = {
  [`GET ${S}/activities/:id/score-tables/download`]: {
    unauthorized: async (env) =>
      void (await expectStatus(
        admin(env, env.users.onlyActivity)('GET', `/activities/${env.SC.id}/score-tables/download?level=questionnaire`),
        403,
      )),
    outOfScope: async (env) =>
      void (await expectStatus(
        admin(env, env.users.general)('GET', `/activities/${env.SC.id}/score-tables/download?level=questionnaire`),
        404,
      )),
    trimming: async (env) => {
      const as = admin(env, env.users.tResult);
      const path = `/activities/${env.SC.id}/score-tables`;
      const body = await json(await expectStatus(as('GET', `${path}?level=questionnaire`), 200));
      without(body, 'roleName');
      const name = (await json(await expectStatus(sa(env)('GET', `/activities/${env.SC.id}`), 200))).name as string;
      const file = await expectStatus(as('GET', `${path}/download?level=questionnaire`), DOWNLOAD_OK);
      await sameFile(file, () => renderPng(scoreTableDocument(body as never, { activityName: name })));
    },
  },
  [`GET ${S}/activities/:id/reports/:reportId/download`]: {
    unauthorized: async (env) => {
      const p = await prb(env);
      await expectStatus(
        admin(env, env.users.onlyActivity)('GET', `/activities/${env.SC.id}/reports/${p.reportId}/download`),
        403,
      );
    },
    outOfScope: async (env) => {
      const p = await prb(env);
      await expectStatus(
        admin(env, env.users.general)('GET', `/activities/${env.SC.id}/reports/${p.reportId}/download`),
        404,
      );
      // 报告须属于该活动
      await expectStatus(sa(env)('GET', `/activities/${env.A.id}/reports/${p.reportId}/download`), 404);
    },
    trimming: async (env) => {
      const p = await prb(env);
      const as = admin(env, env.users.tReport);
      const path = `/activities/${env.SC.id}/reports/${p.reportId}`;
      const body = await json(await expectStatus(as('GET', path), 200));
      expect(body).not.toHaveProperty('questionnaires');
      const file = await expectStatus(as('GET', `${path}/download`), DOWNLOAD_OK);
      await sameFile(file, () => renderPdf(reportDocument(body as never)));
    },
  },
  [`GET /api/survey360/report-link/reports/:reportId/download`]: {
    unauthorized: async (env) => {
      const p = await prb(env);
      await expectStatus(
        env.w.api.request('GET', `/api/survey360/report-link/reports/${p.reportId}/download`, {
          tenant: env.w.tenantId,
        }),
        404,
      );
    },
    outOfScope: async (env) => {
      const p = await prb(env);
      await expectStatus(
        env.w.api.request('GET', `/api/survey360/report-link/reports/${randomUUID()}/download`, {
          tenant: env.w.tenantId,
          headers: { 'x-survey360-token': p.reportToken },
        }),
        404,
      );
      // 他租户：同一令牌换租户头即 404
      await expectStatus(
        env.w.api.request('GET', `/api/survey360/report-link/reports/${p.reportId}/download`, {
          tenant: env.w2.tenantId,
          headers: { 'x-survey360-token': p.reportToken },
        }),
        404,
      );
    },
    trimming: async (env) => {
      const p = await prb(env);
      const request = (suffix: string) =>
        env.w.api.request('GET', `/api/survey360/report-link/reports/${p.reportId}${suffix}`, {
          tenant: env.w.tenantId,
          headers: { 'x-survey360-token': p.reportToken },
        });
      const body = await json(await expectStatus(request(''), 200));
      const file = await expectStatus(request('/download'), DOWNLOAD_OK);
      await sameFile(file, () => renderPdf(reportDocument(body as never)));
    },
  },
};
Object.assign(ROUTE_CASES, F060_CASES);

describe('路由 × 守卫：三类反向用例（表驱动）', () => {
  let env: Env;
  beforeAll(async () => {
    env = await buildEnv();
  }, 600_000);

  it('路由清单与用例表一一对应：每个实际注册的 360 路由都有三类用例，不适用的写明原因', () => {
    const registered = env.w.api.app.routes
      .filter((r) => r.method !== 'ALL')
      .map((r) => `${r.method} ${r.path}`)
      .filter((key) => key.includes('/survey360'));
    expect([...new Set(registered)].sort()).toEqual(Object.keys(ROUTE_CASES).sort());
    for (const [route, cases] of Object.entries(ROUTE_CASES)) {
      expect(typeof cases.unauthorized, route).toBe('function');
      for (const kind of [cases.outOfScope, cases.trimming])
        if (typeof kind !== 'function') expect(kind.na.length, route).toBeGreaterThan(10);
    }
  });

  for (const [route, cases] of Object.entries(ROUTE_CASES)) {
    it(`未授权｜${route}`, async () => cases.unauthorized(env), 60_000);
    if (typeof cases.outOfScope === 'function') {
      const run = cases.outOfScope;
      it(`超范围｜${route}`, async () => run(env), 60_000);
    }
    if (typeof cases.trimming === 'function') {
      const run = cases.trimming;
      it(`字段裁剪｜${route}`, async () => run(env), 60_000);
    }
  }
});
