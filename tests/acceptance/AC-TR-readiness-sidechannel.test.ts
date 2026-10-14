/**
 * R3-T04 PR-A 第 2 轮 P2-01：准备度不经旁路泄露隐藏信息（DEC-121 / 082；AGENTS §10「权限」）。
 * - 只有创建人范围（使用用户规则）的人不能改名：名称租户唯一，改成他人隐藏记录的名称会撞唯一约束，409 与成功的差异
 *   会暴露隐藏记录的存在。所以改名要求看全部，创建人范围下无论目标名称是否被占用都同一个 403，判定在任何查重之前；
 *   看全部的人能看到全部记录，重名 409 不泄露。其他字段照常可改。
 * - 列表筛选字段同样受字段查看权约束：看不到 enabled 的人带 ?enabled= 筛选 403，不能用筛选还原隐藏值。
 * 负向用例断言具体响应码，并前后各读一次比对。
 */
import { randomUUID } from 'node:crypto';
import { createUser, grantMembership } from '@italent/db';
import type { Authorizer } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { cmd, tenantApi } from './support/tenant-api.js';
import { READINESS, readinessBody, readinessWorld, TR_BASE, TR_NOW } from './AC-TR-support.js';

const testDb = useTestDb();
const clock = () => TR_NOW;
const ALL_FIELDS = new Set(READINESS.fields.map((field) => field.code));

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
  return tenantApi(testDb().db, { authorize, clock });
}

describe('R3-T04 准备度旁路泄露（第 2 轮 P2-01；DEC-121 / 082）', () => {
  it('只有创建人范围：改成他人隐藏名称与改成全新名称同为 403，数据不变；其他字段可改', async () => {
    const db = testDb().db;
    const w = await readinessWorld(db, 'tr-probe');
    const otherUser = await createUser(
      db,
      { email: `tr-other-${randomUUID()}@example.com`, displayName: '他人' },
      cmd(),
    );
    await grantMembership(db, { tenantId: w.as.tenant, userId: otherUser.id, expectedRevision: 0 }, cmd());
    const mine = await w.create(readinessBody({ name: '我的准备度' }));
    const theirs = await w.create(readinessBody({ name: '他人的隐藏准备度' }), {
      user: otherUser.id,
      tenant: w.as.tenant,
    });
    const api = controlled({ creatorOnly: true, fields: ALL_FIELDS });
    const call = (method: string, path: string, extra: Parameters<typeof api.request>[2] = {}) =>
      api.request(method, `${TR_BASE}${path}`, { ...w.as, ...extra });
    expect((await call('GET', `/readiness-levels/${theirs.id}`)).status).toBe(404);
    const responses = [];
    for (const name of [theirs.name, '从未用过的名称']) {
      const response = await call('PATCH', `/readiness-levels/${mine.id}`, { ifMatch: 1, body: { name } });
      responses.push([response.status, (await response.json()) as unknown]);
    }
    expect(responses[0]).toEqual(responses[1]);
    expect(responses[0]).toEqual([
      403,
      expect.objectContaining({
        error: expect.objectContaining({ code: 'FORBIDDEN', details: { reason: 'READINESS_NAME_REQUIRES_SEE_ALL' } }),
      }),
    ]);
    expect((await w.read(mine.id)).body).toEqual(mine);
    expect((await w.read(theirs.id)).body).toEqual(theirs);
    const unchanged = await call('PATCH', `/readiness-levels/${mine.id}`, {
      ifMatch: 1,
      body: { name: mine.name, sortNo: 7 },
    });
    expect(unchanged.status, await unchanged.clone().text()).toBe(200);
    expect(await unchanged.json()).toMatchObject({ name: mine.name, sortNo: 7, revision: 2 });
  });

  it('看不到 enabled：带 ?enabled= 筛选 403，不能还原启用状态；不带筛选正常列出且键缺席', async () => {
    const w = await readinessWorld(testDb().db, 'tr-filter');
    await w.create(readinessBody({ enabled: true }));
    await w.create(readinessBody({ enabled: false }));
    const hidden = new Set([...ALL_FIELDS].filter((field) => field !== 'enabled'));
    const api = controlled({ creatorOnly: false, fields: hidden });
    for (const value of ['true', 'false']) {
      const response = await api.request('GET', `${TR_BASE}/readiness-levels?enabled=${value}`, w.as);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: 'FORBIDDEN', details: { reason: 'FILTER_FIELD_HIDDEN' } },
      });
    }
    const list = await api.request('GET', `${TR_BASE}/readiness-levels`, w.as);
    const items = ((await list.json()) as { items: object[] }).items;
    expect(items).toHaveLength(2);
    for (const entry of items) expect(entry).not.toHaveProperty('enabled');
  });
});
