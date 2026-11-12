import { randomUUID } from 'node:crypto';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
  type PermissionWorld,
  type ProfileBody,
} from './AC-PRM-support.js';
import { GRAPH, graphInput, seedGraph } from './support/job-graph.js';

const testDb = useTestDb();
const SOURCES = [
  MODULE_OBJECTS.jobGrade,
  MODULE_OBJECTS.jobLevelType,
  MODULE_OBJECTS.jobLevel,
  MODULE_OBJECTS.jobSequence,
  MODULE_OBJECTS.jobPost,
];

/** 真实授权器：成员 + 身份 + 五个源对象 / 图谱对象的权限，每个测试自选缺哪一项（AC-F474-JG-06）。 */
async function caller(options: { skip?: string; hideField?: [string, string]; button?: boolean; seeAll?: boolean }) {
  const { db } = testDb();
  const w: PermissionWorld = await seedPermissionWorld(db);
  await seedGraph(db, w.tenant.id, graphInput());
  const profile: ProfileBody = await createProfile(w, `graph-${randomUUID()}`);
  const define = async (definition: (typeof SOURCES)[number] | typeof MODULE_OBJECTS.jobGraph, buttons: string[]) => {
    const hidden = options.hideField?.[0] === definition.code ? options.hideField[1] : undefined;
    const result = await setObjectPermission(
      w,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: definition.fields.map((f) => ({ fieldCode: f.code, view: f.code !== hidden, edit: false })),
        buttons: buttons.map((buttonCode) => ({ buttonCode, level: 'list' })),
      },
      definition.code,
    );
    expect(result.status, await result.clone().text()).toBe(200);
  };
  for (const source of SOURCES) if (source.code !== options.skip) await define(source, []);
  if (options.skip !== MODULE_OBJECTS.jobGraph.code)
    await define(MODULE_OBJECTS.jobGraph, options.button === false ? [] : ['rebuild']);
  if (options.seeAll !== false) {
    const scope = await w.api.request('PUT', `/api/tenant/permission/profiles/${profile.id}/data-scopes/TenantBase`, {
      ...w.asAdmin,
      ifMatch: 0,
      body: { targetKind: 'app', targetCode: '', seeAll: true },
    });
    expect(scope.status, await scope.clone().text()).toBe(200);
  }
  await makeGrantable(w, [profile.id]);
  const user = await addMember(w, '图谱调用者');
  expect((await grant(w, user.id, profile.id)).status).toBe(201);
  const as = { user: user.id, tenant: w.tenant.id };
  return {
    w,
    as,
    profile,
    get: (path = '') => w.api.request('GET', `${GRAPH}${path}`, as),
    rebuild: (ifMatch = 0, key = randomUUID()) =>
      w.api.request('POST', `${GRAPH}/rebuild`, { ...as, ifMatch, idempotencyKey: key, body: {} }),
  };
}

const code = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;

describe('AC-F474-JG-06 五个源对象整体授权', () => {
  it('对象、范围、字段、按钮都齐全才放行（GET / 原因 / 生成）', async () => {
    const c = await caller({});
    expect((await c.get()).status).toBe(200);
    expect((await c.get('/issues')).status).toBe(200);
    expect((await c.rebuild()).status).toBe(200);
  });
  it('缺任何一个源对象的查看权、图谱对象查看权、生成按钮或看全部范围，统一 403', async () => {
    const cases = [
      ...SOURCES.map((source) => ({ name: source.code, options: { skip: source.code } })),
      { name: 'graph', options: { skip: MODULE_OBJECTS.jobGraph.code } },
      { name: 'scope', options: { seeAll: false } },
    ];
    const messages = new Set<string>();
    for (const { name, options } of cases) {
      const c = await caller(options);
      for (const res of [await c.get(), await c.get('/issues'), await c.rebuild()]) {
        expect(res.status, `${name} ${res.url}`).toBe(403);
        messages.add(JSON.stringify(await res.json()));
      }
    }
    expect(messages.size, '不披露缺哪一项').toBe(1);
  });
  it('缺生成按钮：能看图，不能生成', async () => {
    const c = await caller({ button: false });
    expect((await c.get()).status).toBe(200);
    expect(await code(await c.rebuild())).toBe('FORBIDDEN');
  });
  it('源对象的任一字段不可见都 403（逐字段）', async () => {
    const fields: [string, string][] = [
      [MODULE_OBJECTS.jobGrade.code, 'grade'],
      [MODULE_OBJECTS.jobLevel.code, 'maxGradeId'],
      [MODULE_OBJECTS.jobSequence.code, 'parentId'],
      [MODULE_OBJECTS.jobPost.code, 'displayOrder'],
      [MODULE_OBJECTS.jobPost.code, 'code'],
    ];
    for (const hideField of fields) {
      const c = await caller({ hideField });
      expect((await c.get()).status, hideField.join()).toBe(403);
      expect((await c.rebuild()).status, hideField.join()).toBe(403);
    }
  });
  it('撤权后命令重放同样 403，不返回台账里的旧快照', async () => {
    const c = await caller({});
    const key = randomUUID();
    expect((await c.rebuild(0, key)).status).toBe(200);
    const revoke = await setObjectPermission(
      c.w,
      c.profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: MODULE_OBJECTS.jobPost.fields.map((f) => ({ fieldCode: f.code, view: f.code !== 'code', edit: false })),
        buttons: [],
      },
      MODULE_OBJECTS.jobPost.code,
    );
    expect(revoke.status, await revoke.clone().text()).toBe(200);
    expect((await c.rebuild(0, key)).status).toBe(403);
    expect((await c.get()).status).toBe(403);
  });
});
