/**
 * PR #107 第 3 轮修改清单（依据第 2 轮审查 R2-P2-1～R2-P2-8）的回归：公共鉴权要接全——按钮、字段编辑、响应裁剪、
 * 重放范围、审计。负向用例断言具体状态码，并前后读取比对；裁剪用例核对允许字段的实际值与被裁剪字段的缺席。
 * （R2-P2-7 精细化权限下活动内裁剪见 AC-360-DEC289.test.ts。）
 */
import { randomUUID } from 'node:crypto';
import { survey360 } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { loginEmailOf } from './AC-EMP-support.js';
import { auditApi } from './AC-AUD-support.js';
import {
  type ActivityView,
  fullAccess,
  type ObjectPermissionBody,
  type PersonView,
  world360,
  type World360,
} from './AC-360-support.js';

const testDb = useTestDb();
const OBJ = survey360.SURVEY360_OBJECTS;
type Key = keyof typeof OBJ;

interface Spec {
  readonly object: Key;
  readonly ops?: Partial<Record<'create' | 'update' | 'delete', boolean>>;
  /** 查看与编辑都不给的字段。 */
  readonly hide?: readonly string[];
  /** 可见但不可编辑的字段；'all' = 全部字段都不可编辑。 */
  readonly readOnly?: readonly string[] | 'all';
  /** 授予的按钮编码；'all' = 目录登记的全部按钮。 */
  readonly buttons?: readonly string[] | 'all';
}

/** 按对象目录拼一条身份对象权限（自定义 360 身份，DEC-280①）。 */
function perm(spec: Spec): ObjectPermissionBody {
  const definition = OBJ[spec.object];
  const ops = { create: false, update: false, delete: false, ...spec.ops };
  const hidden = new Set(spec.hide ?? []);
  const readOnly = spec.readOnly === 'all' ? null : new Set(spec.readOnly ?? []);
  const buttons = definition.buttons as readonly { code: string; level: string }[];
  const granted = spec.buttons === 'all' ? buttons.map((b) => b.code) : (spec.buttons ?? []);
  return {
    objectCode: definition.code,
    dataOperations: ops,
    fields: definition.fields.map((f) => ({
      fieldCode: f.code,
      view: !hidden.has(f.code),
      edit: !f.system && !hidden.has(f.code) && readOnly !== null && !readOnly.has(f.code),
    })),
    buttons: granted.map((code) => ({
      buttonCode: code,
      level: buttons.find((b) => b.code === code)!.level as ObjectPermissionBody['buttons'][number]['level'],
    })),
  } as ObjectPermissionBody;
}

/** 建一个自定义 360 身份并授给一名新成员。 */
async function customUser(w: World360, name: string, specs: readonly Spec[]) {
  const profile = await w.defineProfile(name, specs.map(perm));
  const user = await w.member(name);
  await w.grantProfile(user, profile);
  return user;
}

async function grantActivity(w: World360, activityId: string, userId: string) {
  const current = await w.getActivity(activityId);
  await w.ok(
    w.request('POST', `/activities/${activityId}/grants`, { ifMatch: current.revision, body: { userIds: [userId] } }),
  );
}

const reasonOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; details?: { reason?: string } } }).error;

/** 一个活动：评价对象 + 同事评价者（均为外部人员），供关系类用例共用。 */
async function relationScene(w: World360) {
  const q = await w.enableQuestionnaire(await w.keyBehavior({ self: 0, peer: 1, customer: 1 }));
  const activity = await w.activity({ name: '关系场景' });
  const target = await w.person('被评价人');
  const object = await w.object(activity.id, target.id, [q.id]);
  const peer = await w.person('同事甲', { mobile: '10000000002' });
  const relation = await w.appraiser(activity.id, object.id, peer.id, 'peer');
  return { q, activity, target, object, peer, relation };
}

describe('R2-P2-6 普通 CRUD 按钮权限：公共层按目录登记的按钮默认检查', () => {
  it('有数据操作与可编辑字段、但没有对应按钮：新增 / 编辑 / 删除一律 403，数据不变', async () => {
    const w = await world360(testDb().db, 'r3a');
    const s = await relationScene(w);
    const user = await customUser(w, '无按钮', [
      { object: 'person', ops: { create: true, update: true } },
      { object: 'activity', ops: { create: true, update: true, delete: true } },
      { object: 'questionnaire', ops: { create: true, update: true, delete: true } },
      { object: 'settings', ops: { create: true, update: true } },
      { object: 'relation', ops: { create: true, update: true, delete: true } },
    ]);
    await grantActivity(w, s.activity.id, user);
    const u = w.as(user);
    const peopleBefore = await w.ok<{ items: PersonView[] }>(w.request('GET', '/people?pageSize=200'));
    const activityBefore = await w.getActivity(s.activity.id);
    const objectsPath = `/activities/${s.activity.id}/objects`;
    const objectsBefore = await w.ok(w.request('GET', objectsPath));
    const extra = await w.person('另一个人');
    const attempts: [string, Promise<Response>][] = [
      [
        'POST /people',
        u('POST', '/people', {
          ifMatch: 0,
          body: { name: '新人', email: `r3a-${randomUUID().slice(0, 6)}@example.com` },
        }),
      ],
      ['PUT /people/:id', u('PUT', `/people/${s.peer.id}`, { ifMatch: s.peer.revision, body: { name: '改名' } })],
      ['POST /activities', u('POST', '/activities', { ifMatch: 0, body: { name: '新活动', form: 'single' } })],
      [
        'PUT /activities/:id',
        u('PUT', `/activities/${s.activity.id}`, { ifMatch: activityBefore.revision, body: { name: '改' } }),
      ],
      ['DELETE /activities/:id', u('DELETE', `/activities/${s.activity.id}`, { ifMatch: activityBefore.revision })],
      ['POST /questionnaires', u('POST', '/questionnaires', { ifMatch: 0, body: { name: '新套卷', type: 'rating' } })],
      ['POST /roles', u('POST', '/roles', { ifMatch: 0, body: { name: '新角色' } })],
      [
        'POST objects',
        u('POST', objectsPath, { ifMatch: 0, body: { personId: extra.id, questionnaireIds: [s.q.id] } }),
      ],
      [
        'POST appraisers',
        u('POST', `${objectsPath}/${s.object.id}/appraisers`, {
          ifMatch: 0,
          body: { personId: extra.id, roleId: w.role('customer') },
        }),
      ],
    ];
    for (const [label, attempt] of attempts) expect((await attempt).status, label).toBe(403);
    expect(await w.ok(w.request('GET', '/people?pageSize=200'))).toEqual({
      ...peopleBefore,
      items: [...peopleBefore.items, expect.objectContaining({ id: extra.id })],
    });
    expect(await w.getActivity(s.activity.id)).toEqual(activityBefore);
    expect(await w.ok(w.request('GET', objectsPath))).toEqual(objectsBefore);
  });

  it('补上新增按钮后，同样的人员新增通过（按钮 + 数据操作 + 字段齐备）', async () => {
    const w = await world360(testDb().db, 'r3b');
    const user = await customUser(w, '有按钮', [{ object: 'person', ops: { create: true }, buttons: ['create'] }]);
    const res = await w.as(user)('POST', '/people', {
      ifMatch: 0,
      body: { name: '新人', email: `r3b-${randomUUID().slice(0, 6)}@example.com` },
    });
    expect(res.status, await res.clone().text()).toBe(201);
  });
});

describe('R2-P2-5 评价关系写入口校验字段编辑权（手工、批量、导入、重放）', () => {
  it('Relation 有新增 / 编辑 / 删除与全部按钮、但字段都不可编辑：新增对象 / 评价者、换套卷、导入、邀请确认一律 403', async () => {
    const w = await world360(testDb().db, 'r3c');
    const s = await relationScene(w);
    const user = await customUser(w, '关系只读字段', [
      { object: 'activity', buttons: [] },
      { object: 'relation', ops: { create: true, update: true, delete: true }, readOnly: 'all', buttons: 'all' },
    ]);
    await grantActivity(w, s.activity.id, user);
    const u = w.as(user);
    const base = `/activities/${s.activity.id}/objects`;
    const other = await w.person('另一个人');
    const before = {
      objects: await w.ok(w.request('GET', base)),
      appraisers: await w.ok(w.request('GET', `${base}/${s.object.id}/appraisers`)),
    };
    const attempts: [string, Promise<Response>][] = [
      ['POST objects', u('POST', base, { ifMatch: 0, body: { personId: other.id, questionnaireIds: [s.q.id] } })],
      [
        'PUT questionnaires',
        u('PUT', `${base}/${s.object.id}/questionnaires`, {
          ifMatch: s.object.revision,
          body: { questionnaireIds: [s.q.id] },
        }),
      ],
      [
        'POST appraisers',
        u('POST', `${base}/${s.object.id}/appraisers`, {
          ifMatch: 0,
          body: { personId: other.id, roleId: w.role('customer') },
        }),
      ],
      [
        'import',
        u('POST', `/activities/${s.activity.id}/appraisers/import`, {
          ifMatch: 0,
          body: {
            sync: false,
            rows: [
              {
                objectEmail: s.target.email,
                roleId: w.role('customer'),
                name: '导入客户',
                email: 'imp-r3c@example.com',
              },
            ],
          },
        }),
      ],
      ['confirmation', u('POST', `${base}/${s.object.id}/confirmation`, { ifMatch: 0, body: {} })],
    ];
    for (const [label, attempt] of attempts) expect((await attempt).status, label).toBe(403);
    expect(await w.ok(w.request('GET', base))).toEqual(before.objects);
    expect(await w.ok(w.request('GET', `${base}/${s.object.id}/appraisers`))).toEqual(before.appraisers);
  });
});

describe('R2-P2-5 自动添加同样校验评价关系字段编辑权', () => {
  it('评价对象已挂接员工、在范围内：Relation 字段都不可编辑时自动添加 403，不建关系', async () => {
    const w = await world360(testDb().db, 'r3p');
    const org = await w.session.org('自动部门', { establishedOn: '2025-01-01' });
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
      return employee;
    };
    const manager = await hire('经理');
    const target = await hire('被评价员工', manager.id);
    const { created } = await w.ok<{ created: { personId: string; employeeId: string }[] }>(
      w.request('POST', '/people/sync', { body: {} }),
    );
    const q = await w.enableQuestionnaire(await w.keyBehavior({ self: 0, superior: 1 }));
    const activity = await w.activity();
    const object = await w.object(activity.id, created.find((c) => c.employeeId === target.id)!.personId, [q.id]);
    const user = await customUser(w, '关系只读字段', [
      { object: 'activity' },
      { object: 'relation', ops: { create: true }, readOnly: 'all', buttons: ['create', 'autoAdd'] },
      { object: 'person', ops: { create: true }, buttons: ['create'] },
    ]);
    await grantActivity(w, activity.id, user);
    const path = `/activities/${activity.id}/objects/${object.id}/appraisers`;
    const before = await w.ok(w.request('GET', path));
    const res = await w.as(user)('POST', `${path}/auto`, { ifMatch: 0, body: { roles: ['superior'] } });
    expect(res.status).toBe(403);
    expect(await w.ok(w.request('GET', path))).toEqual(before);
  });
});

describe('R2-P2-2 写响应与同键重放按请求人当时的查看字段裁剪', () => {
  it('看不到人员邮箱 / 手机：PUT 只改姓名，响应与重放都不带邮箱、手机', async () => {
    const w = await world360(testDb().db, 'r3d');
    const target = await w.person('原名', { mobile: '10000000003' });
    const user = await customUser(w, '看不到联系方式', [
      { object: 'person', ops: { update: true }, hide: ['email', 'mobile'], buttons: ['update'] },
    ]);
    const key = randomUUID();
    const call = () =>
      w.as(user)('PUT', `/people/${target.id}`, {
        ifMatch: target.revision,
        idempotencyKey: key,
        body: { name: '新名' },
      });
    for (const res of [await call(), await call()]) {
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.name).toBe('新名');
      expect(body).not.toHaveProperty('email');
      expect(body).not.toHaveProperty('mobile');
    }
  });

  it('看不到活动欢迎语：PUT 活动名称的响应不带欢迎语', async () => {
    const w = await world360(testDb().db, 'r3e');
    const activity = await w.activity({ name: '原活动', welcome: 'SECRET_WELCOME' });
    const user = await customUser(w, '看不到欢迎语', [
      { object: 'activity', ops: { update: true }, hide: ['welcome'], buttons: ['update'] },
    ]);
    await grantActivity(w, activity.id, user);
    const current = await w.getActivity(activity.id);
    const res = await w.as(user)('PUT', `/activities/${activity.id}`, {
      ifMatch: current.revision,
      body: { name: '新活动' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ActivityView & Record<string, unknown>;
    expect(body.name).toBe('新活动');
    expect(body).not.toHaveProperty('welcome');
    expect(JSON.stringify(body)).not.toContain('SECRET_WELCOME');
  });
});

describe('R2-P2-3 嵌套候选、汇总信封与关联日志按查看人字段裁剪', () => {
  it('同步冲突候选：看不到人员邮箱时候选不带邮箱', async () => {
    const w = await world360(testDb().db, 'r3f');
    const org = await w.session.org('冲突部门', { establishedOn: '2025-01-01' });
    const employee = await w.session.employee('冲突员工');
    await w.session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2025-01-01', fields: { departmentId: org.id } },
      employee.revision,
    );
    await w.ok(
      w.request('POST', '/people', { ifMatch: 0, body: { name: '外部同邮箱', email: loginEmailOf(employee.id) } }),
      201,
    );
    await w.ok(w.request('POST', '/people/sync', { body: {} }));
    const user = await customUser(w, '同步但看不到邮箱', [{ object: 'person', hide: ['email'], buttons: ['sync'] }]);
    const list = await w.ok<{ items: { candidates: Record<string, unknown>[] }[] }>(
      w.as(user)('GET', '/people/sync-conflicts'),
    );
    expect(list.items).toHaveLength(1);
    const [candidate] = list.items[0]!.candidates;
    expect(candidate).toHaveProperty('name', '外部同邮箱');
    expect(candidate).not.toHaveProperty('email');
    expect(JSON.stringify(list)).not.toContain(loginEmailOf(employee.id));
  });

  it('关联日志：看不到人员的员工挂接字段时，不带当前 / 旧员工 ID', async () => {
    const w = await world360(testDb().db, 'r3g');
    const org = await w.session.org('挂接部门', { establishedOn: '2025-01-01' });
    const employee = await w.session.employee('挂接员工');
    await w.session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2025-01-01', fields: { departmentId: org.id } },
      employee.revision,
    );
    const { created } = await w.ok<{ created: { personId: string }[] }>(
      w.request('POST', '/people/sync', { body: {} }),
    );
    const user = await customUser(w, '看不到挂接', [
      { object: 'person', hide: ['employeeId', 'previousEmployeeId'], buttons: ['sync'] },
    ]);
    const logs = await w.ok<{ items: Record<string, unknown>[] }>(
      w.as(user)('GET', `/people/${created[0]!.personId}/link-logs`),
    );
    expect(logs.items).toHaveLength(1);
    expect(logs.items[0]).toHaveProperty('reason', 'new');
    expect(logs.items[0]).not.toHaveProperty('employeeId');
    expect(JSON.stringify(logs)).not.toContain(employee.id);
  });

  it('评价者列表：看不到角色时不返回以角色 ID 为键的人数汇总；嵌套人员按人员字段权限裁剪', async () => {
    const w = await world360(testDb().db, 'r3h');
    const s = await relationScene(w);
    const user = await customUser(w, '看不到角色与邮箱', [
      { object: 'activity' },
      { object: 'relation', hide: ['roleId', 'roleName'] },
      { object: 'person', hide: ['email'] },
    ]);
    await grantActivity(w, s.activity.id, user);
    const u = w.as(user);
    const base = `/activities/${s.activity.id}/objects`;
    const list = await w.ok<Record<string, unknown> & { items: Record<string, unknown>[] }>(
      u('GET', `${base}/${s.object.id}/appraisers`),
    );
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).not.toHaveProperty('roleId');
    expect(JSON.stringify(list)).not.toContain(w.role('peer'));
    expect(list.items[0]!.appraiser).toEqual({ name: '同事甲', internal: false });
    const objects = await w.ok<{ items: { person: Record<string, unknown> }[] }>(u('GET', base));
    expect(objects.items[0]!.person).toEqual({ name: '被评价人' });
    expect(JSON.stringify(objects)).not.toContain(s.target.email);
  });
});

describe('R2-P2-4 审计按真实对象权限与字段权限裁剪', () => {
  it('只有活动查看权、没有评价关系权：看不到评价对象 / 评价关系日志', async () => {
    const w = await world360(testDb().db, 'r3i');
    const s = await relationScene(w);
    const user = await customUser(w, '只看活动', [{ object: 'activity' }]);
    await grantActivity(w, s.activity.id, user);
    expect((await w.as(user)('GET', `/activities/${s.activity.id}/objects`)).status).toBe(403);
    const audit = auditApi(testDb().db, '2026-10-01T02:00:00Z', { authorize: w.authorize });
    const types = new Set(
      (await audit.dataChanges({ user, tenant: w.tenantId }, { limit: '100' })).items.map((i) => i.objectType),
    );
    expect(types.has('survey360-activity')).toBe(true);
    expect(types.has('survey360-object')).toBe(false);
    expect(types.has('survey360-relation')).toBe(false);
  });

  it('看不到人员邮箱：人员日志列表的变更与详情的 before / after 都不带邮箱', async () => {
    const w = await world360(testDb().db, 'r3j');
    const email = `audit-r3j-${randomUUID().slice(0, 6)}@example.com`;
    await w.ok(w.request('POST', '/people', { ifMatch: 0, body: { name: '审计人员', email } }), 201);
    const user = await customUser(w, '日志看不到邮箱', [{ object: 'person', hide: ['email'] }]);
    const audit = auditApi(testDb().db, '2026-10-01T02:00:00Z', { authorize: w.authorize });
    const as = { user, tenant: w.tenantId };
    const items = (await audit.dataChanges(as, { limit: '100' })).items.filter(
      (i) => i.objectType === 'survey360-person',
    );
    expect(items.length).toBeGreaterThan(0);
    expect(JSON.stringify(items)).not.toContain(email);
    const detail = await audit.dataChange(as, items[0]!.id);
    expect(JSON.stringify(detail)).not.toContain(email);
    expect(detail.after).toHaveProperty('name', '审计人员');
  });
});

describe('R2-P2-1 撤回员工范围后的重放按当前范围复核', () => {
  async function hired(w: World360, name: string, orgId: string, managerId?: string) {
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

  it('冲突处理成功后撤空员工范围：原键重放 404，不返回历史结果', async () => {
    const access = fullAccess();
    const w = await world360(testDb().db, 'r3k', { access });
    const org = await w.session.org('冲突部门', { establishedOn: '2025-01-01' });
    const employee = await hired(w, '冲突员工', org.id);
    await w.ok(
      w.request('POST', '/people', { ifMatch: 0, body: { name: '外部同邮箱', email: loginEmailOf(employee.id) } }),
      201,
    );
    await w.ok(w.request('POST', '/people/sync', { body: {} }));
    const [conflict] = (
      await w.ok<{ items: { id: string; revision: number }[] }>(w.request('GET', '/people/sync-conflicts'))
    ).items;
    const key = randomUUID();
    const resolve = () =>
      w.request('POST', `/people/sync-conflicts/${conflict!.id}/resolve`, {
        ifMatch: conflict!.revision,
        idempotencyKey: key,
        body: { action: 'ignore' },
      });
    expect((await resolve()).status).toBe(200);
    access.scope = EMPTY_SCOPE;
    const replay = await resolve();
    expect(replay.status).toBe(404);
    expect(JSON.stringify(await replay.json())).not.toContain(employee.id);
  });

  it('同步回执重放：撤空员工范围后，重放不再列出范围外的员工', async () => {
    const access = fullAccess();
    const w = await world360(testDb().db, 'r3l', { access });
    const org = await w.session.org('同步部门', { establishedOn: '2025-01-01' });
    const employee = await hired(w, '同步员工', org.id);
    const key = randomUUID();
    const sync = () => w.request('POST', '/people/sync', { idempotencyKey: key, body: {} });
    const first = (await (await sync()).json()) as { created: { employeeId: string }[] };
    expect(first.created.map((c) => c.employeeId)).toEqual([employee.id]);
    access.scope = EMPTY_SCOPE;
    const replay = await sync();
    expect(replay.status).toBe(200);
    expect(JSON.stringify(await replay.json())).not.toContain(employee.id);
  });

  it('自动添加重放：候选员工移出范围后，重放不再列出这些员工的关系与跳过原因', async () => {
    const access = fullAccess();
    const w = await world360(testDb().db, 'r3m', { access });
    const org = await w.session.org('自动部门', { establishedOn: '2025-01-01' });
    const manager = await hired(w, '经理', org.id);
    const target = await hired(w, '被评价员工', org.id, manager.id);
    const peer = await hired(w, '同事', org.id, manager.id);
    const { created } = await w.ok<{ created: { personId: string; employeeId: string }[] }>(
      w.request('POST', '/people/sync', { body: {} }),
    );
    const personOf = (id: string) => created.find((c) => c.employeeId === id)!.personId;
    const q = await w.enableQuestionnaire(await w.keyBehavior({ self: 0, superior: 1, peer: 1 }));
    const activity = await w.activity();
    const object = await w.object(activity.id, personOf(target.id), [q.id]);
    const key = randomUUID();
    const auto = () =>
      w.request('POST', `/activities/${activity.id}/objects/${object.id}/appraisers/auto`, {
        ifMatch: 0,
        idempotencyKey: key,
        body: { roles: ['superior', 'peer'] },
      });
    const first = (await (await auto()).json()) as { added: { appraiserPersonId: string }[] };
    expect(first.added.map((a) => a.appraiserPersonId).sort()).toEqual(
      [personOf(manager.id), personOf(peer.id)].sort(),
    );
    // 范围只剩评价对象本人：经理、同事都移出
    access.scope = {
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      terms: [{ dimension: 'reporting', orgIds: [], personIds: [target.id] }],
    };
    const replay = await auto();
    expect(replay.status).toBe(200);
    const text = JSON.stringify(await replay.json());
    expect(text).not.toContain(personOf(manager.id));
    expect(text).not.toContain(personOf(peer.id));
    expect(text).not.toContain(manager.id);
    expect(text).not.toContain(peer.id);
  });
});

describe('R2-P2-7 精细化权限下新建人员不暴露范围外人员是否存在', () => {
  it('受限管理员新建人员：用隐藏人员的邮箱与用全新邮箱结果相同（403），数据不变', async () => {
    const w = await world360(testDb().db, 'r3n');
    const general = await w.member('一般管理员');
    await w.appoint(general, 'general');
    const hidden = await w.person('隐藏的外部人员');
    const settings = await w.ok<{ revision: number }>(w.request('GET', '/settings'));
    await w.ok(w.request('PUT', '/settings', { ifMatch: settings.revision, body: { finePermission: true } }));
    const before = await w.ok(w.request('GET', '/people?pageSize=200'));
    const create = (email: string) => w.as(general)('POST', '/people', { ifMatch: 0, body: { name: '新人', email } });
    const taken = await create(hidden.email);
    const fresh = await create(`fresh-r3n-${randomUUID().slice(0, 6)}@example.com`);
    expect(taken.status).toBe(403);
    expect(fresh.status).toBe(403);
    expect(await reasonOf(taken)).toEqual(await reasonOf(fresh));
    expect(await w.ok(w.request('GET', '/people?pageSize=200'))).toEqual(before);
  });
});

describe('R2-P2-8 游标同步回补跨页上级', () => {
  it('下属在第一页、经理在第二页：最后一页结束后下属的上级是经理（推进 revision、计入 updated）', async () => {
    const w = await world360(testDb().db, 'r3o');
    const org = await w.session.org('两页部门', { establishedOn: '2025-01-01' });
    const a = await w.session.employee('员工A');
    const b = await w.session.employee('员工B');
    // 同步按员工 ID 升序分页：ID 小的作下属（第一页），ID 大的作经理（第二页）
    const [sub, boss] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));
    await w.session.business(
      boss!.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2025-01-01', fields: { departmentId: org.id } },
      boss!.revision,
    );
    await w.session.business(
      sub!.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2025-01-01',
        fields: { departmentId: org.id, directManagerId: boss!.id },
      },
      sub!.revision,
    );
    type Page = {
      created: { personId: string; employeeId: string }[];
      updated: { employeeId: string }[];
      nextCursor: string | null;
    };
    const page1 = await w.ok<Page>(w.request('POST', '/people/sync', { body: { limit: 1 } }));
    expect(page1.created.map((c) => c.employeeId)).toEqual([sub!.id]);
    expect(page1.nextCursor).toBe(sub!.id);
    const page2 = await w.ok<Page>(w.request('POST', '/people/sync', { body: { limit: 1, after: page1.nextCursor } }));
    expect(page2.created.map((c) => c.employeeId)).toEqual([boss!.id]);
    expect(page2.nextCursor).toBeNull();
    const subPerson = await w.ok<PersonView>(w.request('GET', `/people/${page1.created[0]!.personId}`));
    expect(subPerson.superiorPersonId).toBe(page2.created[0]!.personId);
    expect(subPerson.revision).toBe(2);
    expect(page2.updated.map((u) => u.employeeId)).toEqual([sub!.id]);
  });
});
