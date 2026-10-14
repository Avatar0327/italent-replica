/**
 * R3-T04 PR-B1：分类 / 角色 / 字段不经旁路泄露隐藏记录（沿用准备度第 2 轮 P2-01；DEC-121 / 082）：
 * 只有创建人范围的人不能改名——名称租户唯一，改成他人隐藏记录的名称会撞唯一约束，409 与成功的差异会暴露隐藏记录的存在。
 * 所以改名要求看全部，创建人范围下无论目标名称是否被占用都同一个 403，判定在任何查重之前；其他字段照常可改。
 * 看不到 enabled 的人带 ?enabled= 筛选 403，不能用筛选还原隐藏值。负向用例断言具体响应码，并前后各读一次比对。
 */
import { randomUUID } from 'node:crypto';
import { createUser, grantMembership } from '@italent/db';
import type { Authorizer } from '@italent/api';
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { cmd, tenantApi } from './support/tenant-api.js';
import { CONFIG_KINDS, type ConfigKind, configBody, configWorld, TR_BASE, TR_NOW } from './AC-TR-config-support.js';

const testDb = useTestDb();

/** 受控授权：功能权限全开；范围与可见字段由参数决定（DEC-043 范围按用户 × 应用，这里直接给定）。 */
function controlled(options: { creatorOnly: boolean; fields: ReadonlySet<string> }) {
  const authorize: Authorizer = (request) => (options.creatorOnly ? request.action !== 'data.scope.all' : true);
  registerScopeProvider(authorize, {
    scope: async (query) =>
      options.creatorOnly
        ? {
            ...EMPTY_SCOPE,
            hasDataPermission: true,
            terms: [{ dimension: 'using_user', creatorId: query.userId, orgIds: [], personIds: [] }],
          }
        : { ...EMPTY_SCOPE, all: true, hasDataPermission: true, source: 'identity' },
    authorize: async (request) => Boolean(await authorize(request)),
    fields: async () => options.fields,
  });
  return tenantApi(testDb().db, { authorize, clock: () => TR_NOW });
}

describe.each(Object.keys(CONFIG_KINDS) as ConfigKind[])('配置对象旁路泄露（DEC-121 / DEC-082）· %s', (kind) => {
  const { path } = CONFIG_KINDS[kind];
  const fields = new Set(TALENT_REVIEW_OBJECTS[kind].fields.map((field) => field.code));

  it('只有创建人范围：改成他人隐藏名称与改成全新名称同为 403，数据不变；其他字段可改', async () => {
    const db = testDb().db;
    const w = await configWorld(db, `trc-probe-${kind}`);
    const other = await createUser(db, { email: `trc-other-${randomUUID()}@example.com`, displayName: '他人' }, cmd());
    await grantMembership(db, { tenantId: w.as.tenant, userId: other.id, expectedRevision: 0 }, cmd());
    const mine = await w.create(kind);
    const theirs = await w.create(kind, configBody(kind), { user: other.id, tenant: w.as.tenant });
    const api = controlled({ creatorOnly: true, fields });
    const call = (method: string, suffix: string, extra: Parameters<typeof api.request>[2] = {}) =>
      api.request(method, `${TR_BASE}${path}${suffix}`, { ...w.as, ...extra });
    expect((await call('GET', `/${theirs.id}`)).status).toBe(404);
    const responses = [];
    for (const name of [theirs.name, '从未用过的名称']) {
      const response = await call('PATCH', `/${mine.id}`, { ifMatch: 1, body: { name } });
      responses.push([response.status, (await response.json()) as unknown]);
    }
    expect(responses[0]).toEqual(responses[1]);
    expect(responses[0]).toEqual([
      403,
      expect.objectContaining({
        error: expect.objectContaining({ code: 'FORBIDDEN', details: { reason: 'NAME_REQUIRES_SEE_ALL' } }),
      }),
    ]);
    expect((await w.read(kind, mine.id)).body).toEqual(mine);
    expect((await w.read(kind, theirs.id)).body).toEqual(theirs);
    const unchanged = await call('PATCH', `/${mine.id}`, { ifMatch: 1, body: { name: mine.name, sortNo: 7 } });
    expect(unchanged.status, await unchanged.clone().text()).toBe(200);
    expect(await unchanged.json()).toMatchObject({ name: mine.name, sortNo: 7, revision: 2 });
  });

  it('看不到 enabled：带 ?enabled= 筛选 403，不能还原启用状态；不带筛选正常列出且键缺席', async () => {
    const w = await configWorld(testDb().db, `trc-filter-${kind}`);
    await w.create(kind, configBody(kind, { enabled: true }));
    await w.create(kind, configBody(kind, { enabled: false }));
    const api = controlled({ creatorOnly: false, fields: new Set([...fields].filter((field) => field !== 'enabled')) });
    for (const value of ['true', 'false']) {
      const response = await api.request('GET', `${TR_BASE}${path}?enabled=${value}`, w.as);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: 'FORBIDDEN', details: { reason: 'FILTER_FIELD_HIDDEN' } },
      });
    }
    const items = ((await (await api.request('GET', `${TR_BASE}${path}`, w.as)).json()) as { items: object[] }).items;
    expect(items).toHaveLength(2);
    for (const entry of items) expect(entry).not.toHaveProperty('enabled');
  });
});
