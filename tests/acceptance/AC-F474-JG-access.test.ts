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

/**
 * 五个源对象的必查字段清单（设计 §4.4 的投影清单，写死、不从产品代码导入：产品侧漏登记时本清单仍会红）。
 * 每项 = [对象编码, 字段编码]，共 35 项：公共 5（id/name/enabled/startDate/stopDate）× 5 对象 + 各对象专有字段 10。
 */
const COMMON_FIELDS = ['id', 'name', 'enabled', 'startDate', 'stopDate'];
const REQUIRED_FIELDS: [string, string][] = [
  [MODULE_OBJECTS.jobGrade.code, [...COMMON_FIELDS, 'grade']],
  [MODULE_OBJECTS.jobLevelType.code, COMMON_FIELDS],
  [MODULE_OBJECTS.jobLevel.code, [...COMMON_FIELDS, 'levelTypeId', 'minGradeId', 'maxGradeId']],
  [MODULE_OBJECTS.jobSequence.code, [...COMMON_FIELDS, 'parentId']],
  [MODULE_OBJECTS.jobPost.code, [...COMMON_FIELDS, 'sequenceId', 'minLevelId', 'maxLevelId', 'displayOrder', 'code']],
].flatMap(([object, list]) => (list as string[]).map((field): [string, string] => [object as string, field]));

/** 真实授权器：成员 + 身份 + 五个源对象 / 图谱对象的权限，每个测试自选缺哪一项（AC-F474-JG-06）。 */
async function caller(options: {
  skip?: string;
  hideField?: [string, string];
  button?: boolean;
  exportButton?: boolean;
  seeAll?: boolean;
}) {
  const { db } = testDb();
  const w: PermissionWorld = await seedPermissionWorld(db);
  await seedGraph(db, w.tenant.id, graphInput());
  const profile: ProfileBody = await createProfile(w, `graph-${randomUUID()}`);
  const define = async (definition: (typeof SOURCES)[number] | typeof MODULE_OBJECTS.jobGraph, buttons: string[]) => {
    const hidden = options.hideField?.[0] === definition.code ? options.hideField[1] : undefined;
    if (hidden)
      expect(
        definition.fields.map((f) => f.code),
        `${definition.code} 无字段 ${hidden}`,
      ).toContain(hidden);
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
    await define(MODULE_OBJECTS.jobGraph, [
      ...(options.button === false ? [] : ['rebuild']),
      ...(options.exportButton === false ? [] : ['export']),
    ]);
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
    /** 两种导出（F-474-7c，AC-F474-JG-08 / 09）：每次请求重新授权。 */
    exports: async () => [
      await w.api.request('GET', `${GRAPH}/export`, as),
      await w.api.request('GET', `${GRAPH}/issues/export?all=true`, as),
    ],
  };
}

/** 拒绝时不给文件：没有下载头、不是 xlsx，正文是统一错误信封。 */
async function noFile(res: Response) {
  expect(res.headers.get('content-disposition'), res.url).toBeNull();
  expect(res.headers.get('content-type'), res.url).toContain('application/json');
  return JSON.stringify(await res.json());
}

const code = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;

describe('AC-F474-JG-06 五个源对象整体授权', () => {
  it('对象、范围、字段、按钮都齐全才放行（GET / 原因 / 生成 / 两种导出）', async () => {
    const c = await caller({});
    expect((await c.get()).status).toBe(200);
    expect((await c.get('/issues')).status).toBe(200);
    expect((await c.rebuild()).status).toBe(200);
    expect((await c.exports()).map((res) => res.status)).toEqual([200, 200]);
  });
  it('缺任何一个源对象的查看权、图谱对象查看权或看全部范围：读、生成、两种导出统一 403', async () => {
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
      for (const res of await c.exports()) {
        expect(res.status, `${name} ${res.url}`).toBe(403);
        messages.add(await noFile(res));
      }
    }
    expect(messages.size, '不披露缺哪一项').toBe(1);
  });
  it('缺生成按钮：能看图，不能生成', async () => {
    const c = await caller({ button: false });
    expect((await c.get()).status).toBe(200);
    expect(await code(await c.rebuild())).toBe('FORBIDDEN');
  });
  it('缺导出按钮：能看图、能生成，两种导出都 403 且不给文件', async () => {
    const c = await caller({ exportButton: false });
    expect((await c.get()).status).toBe(200);
    expect((await c.rebuild()).status).toBe(200);
    for (const res of await c.exports()) {
      expect(res.status, res.url).toBe(403);
      expect(await noFile(res)).toContain('FORBIDDEN');
    }
  });
  it('必查字段清单恰为 35 项（与设计 §4.4 的投影清单一致）', () => {
    expect(REQUIRED_FIELDS).toHaveLength(35);
    expect(new Set(REQUIRED_FIELDS.map(([object, field]) => `${object}.${field}`)).size).toBe(35);
  });
  it.each(REQUIRED_FIELDS)('%s 的 %s 字段不可见：读、生成、两种导出统一 403', async (objectCode, field) => {
    const c = await caller({ hideField: [objectCode, field] });
    for (const res of [await c.get(), await c.get('/issues'), await c.rebuild(), ...(await c.exports())])
      expect(res.status, `${field} ${res.url}`).toBe(403);
  });
  it.each(REQUIRED_FIELDS)(
    '撤掉 %s 的 %s 字段查看权后：命令重放、读入口与两种导出同样 403',
    async (objectCode, field) => {
      const c = await caller({});
      const key = randomUUID();
      expect((await c.rebuild(0, key)).status).toBe(200);
      expect(
        (await c.exports()).map((res) => res.status),
        '撤权前可导出',
      ).toEqual([200, 200]);
      const definition = SOURCES.find((source) => source.code === objectCode)!;
      const revoke = await setObjectPermission(
        c.w,
        c.profile,
        {
          dataOperations: { create: false, update: false, delete: false },
          fields: definition.fields.map((f) => ({ fieldCode: f.code, view: f.code !== field, edit: false })),
          buttons: [],
        },
        objectCode,
      );
      expect(revoke.status, await revoke.clone().text()).toBe(200);
      expect((await c.rebuild(0, key)).status, '重放').toBe(403);
      expect((await c.rebuild(0)).status, '换键新提交').toBe(403);
      expect((await c.get()).status, 'GET').toBe(403);
      expect((await c.get('/issues')).status, 'issues').toBe(403);
      for (const res of await c.exports()) {
        expect(res.status, `导出 ${res.url}`).toBe(403);
        await noFile(res);
      }
    },
  );
});
