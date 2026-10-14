/**
 * AC-TR-08-matrix-sidechannel · R3-T04 PR-B4：九宫格不经旁路泄露隐藏记录（沿用准备度第 2 轮 P2-01；DEC-121 / 082）：
 * - 名称、编码、位置字段占用都是租户唯一，改成他人隐藏记录占用的值会撞唯一约束，409 与成功的差异会暴露隐藏记录的存在。
 *   所以只有创建人范围的人改名、改位置字段一律 403，判定在任何查重之前，目标是否被占用都同一个结果；其他字段可改；
 * - 引用字段按字段目录的范围判定：他人建的字段与不存在同为 404；
 * - 看不到 enabled 的人带筛选 403，不带筛选键缺席。
 */
import { randomUUID } from 'node:crypto';
import { createUser, grantMembership } from '@italent/db';
import type { Authorizer } from '@italent/api';
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { configBody, TR_BASE, TR_NOW } from './AC-TR-config-support.js';
import { LEVEL_OPTIONS, MATRICES, matrixBody, matrixWorld, type MatrixView } from './AC-TR-matrix-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const visibleFields = (hidden?: string) =>
  new Set(
    [...TALENT_REVIEW_OBJECTS.matrix.fields, ...TALENT_REVIEW_OBJECTS.field.fields]
      .map((field) => field.code)
      .filter((code) => code !== hidden),
  );

/** 受控授权：功能权限全开；范围与可见字段由参数决定（DEC-043 范围按用户 × 应用，这里直接给定）。 */
function controlled(options: { creatorOnly: boolean; hidden?: string }) {
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
    fields: async () => visibleFields(options.hidden),
  });
  return tenantApi(testDb().db, { authorize, clock: () => TR_NOW });
}

async function twoUsers(label: string) {
  const db = testDb().db;
  const w = await matrixWorld(db, label);
  const other = await createUser(db, { email: `${label}-${randomUUID()}@example.com`, displayName: '他人' }, cmd());
  await grantMembership(db, { tenantId: w.as.tenant, userId: other.id, expectedRevision: 0 }, cmd());
  return { w, otherAs: { user: other.id, tenant: w.as.tenant } };
}

describe('九宫格旁路泄露（DEC-121 / DEC-082）', () => {
  it('只有创建人范围：改名、改位置字段（占用与未占用）同为 403，数据不变；其他字段可改', async () => {
    const { w, otherAs } = await twoUsers('trm-probe');
    const mine = await w.create();
    const made = await w.request('POST', MATRICES, { ifMatch: 0, body: matrixBody(await w.refs()) }, otherAs);
    expect(made.status, await made.clone().text()).toBe(201);
    const theirs = (await made.json()) as MatrixView;
    const api = controlled({ creatorOnly: true });
    const patch = (body: object) =>
      api.request('PATCH', `${TR_BASE}${MATRICES}/${mine.id}`, { ...w.as, ifMatch: 1, body });
    const after = mine.positionFields.find((row) => row.role === 'after')!.fieldId;
    const taken = [
      { role: 'before', fieldId: theirs.positionFields[0]!.fieldId },
      { role: 'after', fieldId: after },
    ];
    const fresh = [
      { role: 'before', fieldId: (await w.positionField()).id },
      { role: 'after', fieldId: after },
    ];
    const responses = [];
    for (const body of [
      { name: theirs.name },
      { name: '从未用过' },
      { positionFields: taken },
      { positionFields: fresh },
    ]) {
      const response = await patch(body);
      responses.push([response.status, (await response.json()) as unknown]);
    }
    expect(responses[0]).toEqual(responses[1]);
    expect(responses[2]).toEqual(responses[3]);
    expect(responses[0]![0]).toBe(403);
    expect(responses[2]![0]).toBe(403);
    expect((await w.read(mine.id)).body).toEqual(mine);
    const ok = await patch({ name: mine.name, sortNo: 7 });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toMatchObject({ sortNo: 7, revision: 2 });
  });

  it('引用他人建的字段与不存在同为 404；自己建的字段可引用', async () => {
    const { w, otherAs } = await twoUsers('trm-ref-probe');
    const mine = await w.create();
    const made = await w.request(
      'POST',
      '/fields',
      { ifMatch: 0, body: configBody('field', { kind: 'option', group: 'result', options: LEVEL_OPTIONS }) },
      otherAs,
    );
    expect(made.status, await made.clone().text()).toBe(201);
    const foreign = (await made.json()) as { id: string };
    const own = await w.optionField();
    const api = controlled({ creatorOnly: true });
    const patch = (xFieldId: string) =>
      api.request('PATCH', `${TR_BASE}${MATRICES}/${mine.id}`, { ...w.as, ifMatch: 1, body: { xFieldId } });
    const hidden = await patch(foreign.id);
    const unknown = await patch('00000000-0000-4000-8000-000000000000');
    expect([hidden.status, await hidden.json()]).toEqual([unknown.status, await unknown.json()]);
    expect(hidden.status).toBe(404);
    expect((await w.read(mine.id)).body).toEqual(mine);
    const ok = await patch(own.id);
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(((await ok.json()) as MatrixView).xFieldId).toBe(own.id);
  });

  it('看不到 enabled：带 ?enabled= 筛选 403，不能还原启用状态；不带筛选正常列出且键缺席', async () => {
    const w = await matrixWorld(testDb().db, 'trm-filter');
    await w.create();
    const api = controlled({ creatorOnly: false, hidden: 'enabled' });
    for (const value of ['true', 'false']) {
      const response = await api.request('GET', `${TR_BASE}${MATRICES}?enabled=${value}`, w.as);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: 'FORBIDDEN', details: { reason: 'FILTER_FIELD_HIDDEN' } },
      });
    }
    const items = ((await (await api.request('GET', `${TR_BASE}${MATRICES}`, w.as)).json()) as { items: object[] })
      .items;
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('enabled');
  });
});
