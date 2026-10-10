/**
 * AC-TR-calc-rule-permissions · R3-T04 PR-B5 计算规则权限（真实授权器；设计 §6.1、§6.5；DEC-080 / 121 / 082 / 043）：
 * 计算规则没有组织字段，数据范围只认看全部或创建人（缺省为空），新建只有看全部可建，范围外与不存在同一个 404；
 * 写入口 = 数据操作权 + 按钮，载荷逐字段校验编辑权（含显式清空 items: []）；公式与目标字段引用盘点字段目录：另需字段目录的
 * 查看权，目标字段看不到与不存在同为 404，公式里引用看不到的字段名与不存在的字段名同为未知字段（不暴露隐藏字段）；
 * 撤按钮 / 撤范围后原命令重放同样被拒；响应按字段权限裁剪（键缺席）；列表筛选字段同受字段查看权约束；
 * 只有创建人范围的人改名一律 403（唯一约束不暴露隐藏规则）。
 */
import { randomUUID } from 'node:crypto';
import { createUser, grantMembership } from '@italent/db';
import type { Authorizer } from '@italent/api';
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import {
  CALC_RULES,
  calcBody,
  calcItem,
  calcRuleOperator,
  calcWorld,
  type CalcRuleView,
  pathOf,
  withoutHints,
} from './AC-TR-calc-rule-support.js';
import { configBody, TR_BASE, TR_NOW } from './AC-TR-config-support.js';
import { cmd, errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const clock = () => TR_NOW;

describe('计算规则权限（DEC-121 / 082 / 043 / 080）', () => {
  let world: PermissionWorld;
  let setup: ReturnType<typeof tenantApi>;
  let existing: CalcRuleView;
  let target: { id: string; name: string };
  const adminCreate = async (path: string, body: Record<string, unknown>) => {
    const response = await setup.request('POST', `${TR_BASE}${path}`, { ...world.asAdmin, ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as CalcRuleView;
  };
  const numberField = () => adminCreate('/fields', configBody('field', { kind: 'number', group: 'result' }));
  const adminRead = async (id: string) =>
    (await (await setup.request('GET', `${TR_BASE}${CALC_RULES}/${id}`, world.asAdmin)).json()) as CalcRuleView;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    setup = tenantApi(world.db, { clock });
    target = await numberField();
    existing = withoutHints(await adminCreate(CALC_RULES, calcBody([calcItem(target, '1')], { name: '管理员建的' })));
  });

  it('没有对象查看权：列表与详情 403', async () => {
    const operator = await calcRuleOperator(world, { view: false });
    expect((await operator.request('GET', CALC_RULES)).status).toBe(403);
    expect((await operator.request('GET', `${CALC_RULES}/${existing.id}`)).status).toBe(403);
  });

  it('有查看权、范围缺省为空：列表为空，他人建的详情 404，新建 / 修改 404 且不落库', async () => {
    const operator = await calcRuleOperator(world, { fields: 'seeAll' });
    expect(await (await operator.request('GET', CALC_RULES)).json()).toMatchObject({
      items: [],
      hasDataPermission: false,
    });
    const detail = await operator.request('GET', `${CALC_RULES}/${existing.id}`);
    expect([detail.status, await errorCode(detail)]).toEqual([404, 'NOT_FOUND']);
    const body = calcBody([calcItem(await numberField(), '1')]);
    expect((await operator.request('POST', CALC_RULES, { ifMatch: 0, body })).status).toBe(404);
    const patch = await operator.request('PATCH', `${CALC_RULES}/${existing.id}`, {
      ifMatch: 1,
      body: { enabled: false },
    });
    expect(patch.status).toBe(404);
    const all = await setup.request('GET', `${TR_BASE}${CALC_RULES}?pageSize=100`, world.asAdmin);
    expect(((await all.json()) as { items: { name: string }[] }).items.map((item) => item.name)).not.toContain(
      body.name,
    );
    expect(await adminRead(existing.id)).toEqual(existing);
  });

  it('引用字段需要字段目录查看权：没有 403；有查看权但目标字段在其范围外 404（与不存在相同）；看全部字段目录后可建', async () => {
    const body = calcBody([calcItem(await numberField(), '1')]);
    const denied = await calcRuleOperator(world, { seeAll: true, fields: 'none' });
    const forbidden = await denied.request('POST', CALC_RULES, { ifMatch: 0, body });
    expect([forbidden.status, await errorCode(forbidden)]).toEqual([403, 'FORBIDDEN']);
    const hidden = await calcRuleOperator(world, { seeAll: true, fields: 'creator' });
    const missing = await hidden.request('POST', CALC_RULES, { ifMatch: 0, body });
    const unknown = await hidden.request('POST', CALC_RULES, {
      ifMatch: 0,
      body: calcBody([{ ...body.items[0]!, targetFieldId: '00000000-0000-4000-8000-000000000000' }]),
    });
    expect([missing.status, (await missing.json()) as unknown]).toEqual([unknown.status, await unknown.json()]);
    expect(missing.status).toBe(404);
    const allowed = await calcRuleOperator(world, { seeAll: true, fields: 'seeAll' });
    const created = await allowed.request('POST', CALC_RULES, { ifMatch: 0, body });
    expect(created.status, await created.clone().text()).toBe(201);
  });

  it('看全部：可见他人建的；撤掉看全部后自己建的也不可见', async () => {
    const operator = await calcRuleOperator(world, { seeAll: true, fields: 'seeAll' });
    const list = (await (await operator.request('GET', `${CALC_RULES}?pageSize=100`)).json()) as {
      items: { id: string }[];
    };
    expect(list.items.map((item) => item.id)).toContain(existing.id);
    const created = await operator.request('POST', CALC_RULES, {
      ifMatch: 0,
      body: calcBody([calcItem(await numberField(), '1')]),
    });
    const mine = (await created.json()) as CalcRuleView;
    await operator.setSeeAll('calcRule', false);
    expect((await operator.request('GET', `${CALC_RULES}/${mine.id}`)).status).toBe(404);
  });

  it('隐藏字段：响应键缺席；写隐藏 / 只读字段（含显式清空 items）403，数据不变', async () => {
    const operator = await calcRuleOperator(world, {
      seeAll: true,
      fields: 'seeAll',
      hidden: ['description'],
      readonly: ['items', 'assessmentLatestWindow'],
    });
    const detail = (await (await operator.request('GET', `${CALC_RULES}/${existing.id}`)).json()) as object;
    expect(detail).toMatchObject({ id: existing.id, name: existing.name });
    expect(detail).not.toHaveProperty('description');
    for (const body of [{ description: '改' }, { items: [] }, { assessmentLatestWindow: 'before_project_start' }]) {
      const response = await operator.request('PATCH', `${CALC_RULES}/${existing.id}`, { ifMatch: 1, body });
      expect(response.status, JSON.stringify(body)).toBe(403);
    }
    expect(await adminRead(existing.id)).toEqual(existing);
    const ok = await operator.request('PATCH', `${CALC_RULES}/${existing.id}`, { ifMatch: 1, body: { sortNo: 9 } });
    expect(ok.status, await ok.clone().text()).toBe(200);
    existing = await adminRead(existing.id);
  });

  it('看不到 enabled 字段的人不能用 enabled 筛选（403），其他筛选不受影响', async () => {
    const operator = await calcRuleOperator(world, { seeAll: true, hidden: ['enabled'] });
    const filtered = await operator.request('GET', `${CALC_RULES}?enabled=true`);
    expect([filtered.status, await errorCode(filtered)]).toEqual([403, 'FORBIDDEN']);
    expect((await operator.request('GET', CALC_RULES)).status).toBe(200);
  });

  it('撤掉按钮后，新请求与原命令重放都 403；撤掉看全部后重放 404', async () => {
    const operator = await calcRuleOperator(world, { seeAll: true, fields: 'seeAll' });
    const options = {
      ifMatch: 0,
      idempotencyKey: `trk-replay-${Date.now()}`,
      body: calcBody([calcItem(await numberField(), '1')]),
    };
    expect((await operator.request('POST', CALC_RULES, options)).status).toBe(201);
    await operator.setButtons(false);
    expect((await operator.request('POST', CALC_RULES, options)).status).toBe(403);
    expect(
      (
        await operator.request('PATCH', `${CALC_RULES}/${existing.id}`, {
          ifMatch: existing.revision,
          body: { sortNo: 1 },
        })
      ).status,
    ).toBe(403);
    await operator.setButtons(true);
    await operator.setSeeAll('calcRule', false);
    expect((await operator.request('POST', CALC_RULES, options)).status).toBe(404);
    expect(await adminRead(existing.id)).toEqual(existing);
  });
});

const visible = new Set(
  [...TALENT_REVIEW_OBJECTS.calcRule.fields, ...TALENT_REVIEW_OBJECTS.field.fields].map((f) => f.code),
);

/** 受控授权：功能权限全开；范围由参数决定（DEC-043 范围按用户 × 应用，这里直接给定）。 */
function creatorOnlyApi() {
  const authorize: Authorizer = (request) => request.action !== 'data.scope.all';
  registerScopeProvider(authorize, {
    scope: async (query) => ({
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      terms: [{ dimension: 'using_user', creatorId: query.userId, orgIds: [], personIds: [] }],
    }),
    authorize: async (request) => Boolean(await authorize(request)),
    fields: async () => visible,
  });
  return tenantApi(testDb().db, { authorize, clock });
}

describe('计算规则旁路泄露（DEC-121 / DEC-082）', () => {
  it('只有创建人范围：改成他人隐藏规则的名称与全新名称同为 403，数据不变；其他字段可改', async () => {
    const db = testDb().db;
    const w = await calcWorld(db, 'trk-probe');
    const other = await createUser(db, { email: `trk-other-${randomUUID()}@example.com`, displayName: '他人' }, cmd());
    await grantMembership(db, { tenantId: w.as.tenant, userId: other.id, expectedRevision: 0 }, cmd());
    const [a, b] = [await w.numberField(), await w.numberField()];
    const mine = await w.create(calcBody([calcItem(a, '1')]));
    const made = await w.request(
      'POST',
      CALC_RULES,
      { ifMatch: 0, body: calcBody([calcItem(b, '1')]) },
      { user: other.id, tenant: w.as.tenant },
    );
    const theirs = (await made.json()) as CalcRuleView;
    const api = creatorOnlyApi();
    const patch = (body: object) =>
      api.request('PATCH', `${TR_BASE}${CALC_RULES}/${mine.id}`, { ...w.as, ifMatch: 1, body });
    const responses = [];
    for (const body of [{ name: theirs.name }, { name: '从未用过的名称' }]) {
      const response = await patch(body);
      responses.push([response.status, (await response.json()) as unknown]);
    }
    expect(responses[0]).toEqual(responses[1]);
    expect(responses[0]![0]).toBe(403);
    expect((await w.read(mine.id)).body).toEqual(withoutHints(mine));
    const ok = await patch({ name: mine.name, sortNo: 7 });
    expect(ok.status, await ok.clone().text()).toBe(200);
  });

  it('公式引用他人建的字段名与不存在的字段名同为未知字段（不暴露隐藏字段的存在）；目标字段他人建的 404', async () => {
    const db = testDb().db;
    const w = await calcWorld(db, 'trk-name-probe');
    const other = await createUser(db, { email: `trk-name-${randomUUID()}@example.com`, displayName: '他人' }, cmd());
    await grantMembership(db, { tenantId: w.as.tenant, userId: other.id, expectedRevision: 0 }, cmd());
    const own = await w.numberField();
    const foreignResponse = await w.request(
      'POST',
      '/fields',
      { ifMatch: 0, body: configBody('field', { kind: 'number', group: 'result' }) },
      { user: other.id, tenant: w.as.tenant },
    );
    const foreign = (await foreignResponse.json()) as { id: string; name: string };
    const mine = await w.create(calcBody([calcItem(own, '1')]));
    const api = creatorOnlyApi();
    const patch = (items: object[]) =>
      api.request('PATCH', `${TR_BASE}${CALC_RULES}/${mine.id}`, { ...w.as, ifMatch: 1, body: { items } });
    const hidden = await patch([calcItem(own, `${pathOf(foreign)} + 1`)]);
    const unknown = await patch([calcItem(own, `${pathOf({ id: '', name: '根本没有这个字段' })} + 1`)]);
    type Body = { error: { details: { issues: { code: string }[] } } };
    const codes = async (response: Response) =>
      ((await response.json()) as Body).error.details.issues.map((issue) => issue.code);
    expect([hidden.status, await codes(hidden)]).toEqual([unknown.status, await codes(unknown)]);
    expect(hidden.status).toBe(400);
    const target = await patch([calcItem(foreign, '1')]);
    expect([target.status, await errorCode(target)]).toEqual([404, 'NOT_FOUND']);
    expect((await w.read(mine.id)).body).toEqual(withoutHints(mine));
  });
});
