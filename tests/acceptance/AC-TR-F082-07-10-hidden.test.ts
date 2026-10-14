/**
 * F-082 AC-07（停用按 ID 判断）、AC-10（不可见引用）、AC-10a（原样保留超长）——F082-3，开关打开：
 * 查看人只有“创建人”数据范围（只看得到自己创建的字段与规则），看不到的引用渲染为 `盘点对象.〔不可见字段〕`，
 * formulaBindings 对应处为 null；原样保留提交不改引用；整段重写移除不可见引用；改动后仍含占位符 → 400 HIDDEN_FIELD。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { createUser, grantMembership, sql, withTenant } from '@italent/db';
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { CALC_RULES, calcItem, type CalcRuleView, type FieldRef } from './AC-TR-calc-rule-support.js';
import { TR_BASE, TR_NOW } from './AC-TR-config-support.js';
import {
  boundWorld,
  calcBody,
  catalogVersion,
  errorOf,
  fieldRevision,
  itemIdOf,
  rawItem,
  refsOf,
  renameField,
  type F082World,
} from './AC-TR-F082-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const clock = () => TR_NOW;
const PLACEHOLDER = '〔不可见字段〕';
const visibleCodes = new Set(
  [...TALENT_REVIEW_OBJECTS.calcRule.fields, ...TALENT_REVIEW_OBJECTS.field.fields].map((f) => f.code),
);

/** 受控授权：功能权限全开；数据范围只有“创建人”（DEC-121，只看得到自己创建的字段与规则）。 */
function creatorOnlyApi() {
  const authorize: Authorizer = (request) => request.action !== 'data.scope.all';
  registerScopeProvider(authorize, {
    scope: async (query) => ({
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      terms: [{ dimension: 'using_user', creatorId: query.userId, orgIds: [], personIds: [] }],
    }),
    authorize: async (request) => Boolean(await authorize(request)),
    fields: async () => visibleCodes,
  });
  return tenantApi(testDb().db, { authorize, clock, formulaIdBinding: true });
}

/** 管理员（全部允许）+ 一名只有创建人范围的查看人；字段 / 规则的创建人可以改成查看人，用来控制他看得到什么。 */
async function arena(label: string) {
  const db = testDb().db;
  const w = await boundWorld(db, label);
  const viewerUser = await createUser(db, { email: `f082-${randomUUID()}@example.com`, displayName: '查看人' }, cmd());
  await grantMembership(db, { tenantId: w.as.tenant, userId: viewerUser.id, expectedRevision: 0 }, cmd());
  const api = creatorOnlyApi();
  const viewer = (method: string, path: string, options: Record<string, unknown> = {}) =>
    api.request(method, `${TR_BASE}${path}`, { user: viewerUser.id, tenant: w.as.tenant, ...options });
  const owned = async (table: 'talent_review_fields' | 'talent_review_calc_rules', ...ids: string[]) => {
    for (const id of ids) {
      await withTenant(db, w.as.tenant, (tx) =>
        tx.execute(sql`UPDATE ${sql.identifier(table)} SET created_by = ${viewerUser.id} WHERE id = ${id}`),
      );
    }
  };
  return { db, w, viewer, owned };
}
const version = (w: F082World) => catalogVersion(testDb().db, w);

describe('AC-10 不可见引用（DEC-376①）', () => {
  it('看不到的引用渲染成占位符、绑定为 null，名称与 ID 不出现在 GET / 写响应 / 错误里；原样保留 / 整段重写 / 改动后含占位符各自的结果', async () => {
    const { db, w, viewer, owned } = await arena('f082-h10');
    const [target, open, secret] = [
      await w.field('number', { name: '目标项' }),
      await w.field('number', { name: '公开项' }),
      await w.field('number', { name: '机密项' }),
    ];
    const rule = await w.create(
      calcBody([calcItem(target, '盘点对象.公开项 + 盘点对象.机密项')], { fieldCatalogVersion: await version(w) }),
    );
    await owned('talent_review_fields', target.id, open.id);
    await owned('talent_review_calc_rules', rule.id);
    const itemId = await itemIdOf(db, w, rule.id, target.id);
    const original = (await rawItem(db, w, itemId)).formula;

    const got = await viewer('GET', `${CALC_RULES}/${rule.id}`);
    const text = await got.clone().text();
    const view = (await got.json()) as CalcRuleView;
    const shown = `盘点对象.公开项 + 盘点对象.${PLACEHOLDER}`;
    expect(view.items[0]).toMatchObject({ formula: shown, formulaBindings: [open.id, null] });
    for (const hiddenText of ['机密项', secret.id]) expect(text, hiddenText).not.toContain(hiddenText);

    // 原样保留：公式与绑定逐字相同 → 200，规范文本与引用（含不可见字段）不变
    const keep = await viewer('PATCH', `${CALC_RULES}/${rule.id}`, {
      ifMatch: view.revision,
      body: { items: [calcItem(target, shown, { formulaBindings: [open.id, null] })] },
    });
    expect(keep.status, await keep.clone().text()).toBe(200);
    expect((await rawItem(db, w, itemId)).formula).toBe(original);
    expect((await refsOf(db, w, itemId)).map((row) => row.field_id).sort()).toEqual([open.id, secret.id].sort());

    // 改动后仍含占位符 → 400 HIDDEN_FIELD，错误里没有机密名称 / ID
    const kept = (await keep.json()) as CalcRuleView;
    const changed = await viewer('PATCH', `${CALC_RULES}/${rule.id}`, {
      ifMatch: kept.revision,
      body: { items: [calcItem(target, `${shown} + 1`, { formulaBindings: [open.id, null, null] })] },
    });
    const error = await errorOf(changed);
    expect(changed.status).toBe(400);
    expect(JSON.stringify(error.details)).toContain('HIDDEN_FIELD');
    for (const hiddenText of ['机密项', secret.id]) expect(JSON.stringify(error)).not.toContain(hiddenText);

    // 字符串里的“〔不可见字段〕”不算占位符；整段重写（不含占位符）→ 引用移除，机密字段不再被引用
    const literal = await viewer('PATCH', `${CALC_RULES}/${rule.id}`, {
      ifMatch: kept.revision,
      body: {
        items: [calcItem(target, `盘点对象.公开项 + Len("${PLACEHOLDER}")`, { formulaBindings: [open.id] })],
        fieldCatalogVersion: await version(w),
      },
    });
    expect(literal.status, await literal.clone().text()).toBe(200);
    expect((await refsOf(db, w, itemId)).map((row) => row.field_id)).toEqual([open.id]);
  });
});

describe('AC-10a 原样保留超长（P3）', () => {
  it('合法的 4000 字公式隐藏一个单字字段，回显更长：原样保留 → 200 规范文本不变；同一回显改动一处 → 400', async () => {
    const { db, w, viewer, owned } = await arena('f082-h10a');
    const [target] = [await w.field('number', { name: '长目标' }), await w.field('number', { name: '秘' })];
    const prefix = '盘点对象.秘 + Len("';
    const suffix = '")';
    const formula = `${prefix}${'x'.repeat(4000 - prefix.length - suffix.length)}${suffix}`;
    expect(formula).toHaveLength(4000);
    const rule = await w.create(calcBody([calcItem(target, formula)], { fieldCatalogVersion: await version(w) }));
    await owned('talent_review_fields', target.id);
    await owned('talent_review_calc_rules', rule.id);
    const itemId = await itemIdOf(db, w, rule.id, target.id);
    const original = (await rawItem(db, w, itemId)).formula;

    const view = (await (await viewer('GET', `${CALC_RULES}/${rule.id}`)).json()) as CalcRuleView;
    const echo = view.items[0]!.formula;
    expect(echo.length).toBeGreaterThan(4000);
    expect(echo.length).toBeLessThanOrEqual(8000);
    expect(view.items[0]!.formulaBindings).toEqual([null]);

    const keep = await viewer('PATCH', `${CALC_RULES}/${rule.id}`, {
      ifMatch: view.revision,
      body: { items: [calcItem(target, echo, { formulaBindings: [null] })] },
    });
    expect(keep.status, await keep.clone().text()).toBe(200);
    expect((await rawItem(db, w, itemId)).formula).toBe(original);

    const kept = (await keep.json()) as CalcRuleView;
    const edited = await viewer('PATCH', `${CALC_RULES}/${rule.id}`, {
      ifMatch: kept.revision,
      body: { items: [calcItem(target, echo.replace('x', 'y'), { formulaBindings: [null] })] },
    });
    expect(edited.status).toBe(400);
  });
});

describe('AC-07 停用按 ID 判断', () => {
  it('新引用停用字段 → 400 CALC_FORMULA_FIELD_DISABLED；字段先改名再停用，原有引用重提仍算“保留”', async () => {
    const { w } = await arena('f082-h07');
    const field = (name: string) => w.field('number', { name });
    const [target, source, later] = [await field('停用目标'), await field('停用源'), await field('后停用')];
    const rule = await w.create(
      calcBody([calcItem(target, '盘点对象.停用源 + 1')], { fieldCatalogVersion: await version(w) }),
    );
    const disable = async (f: FieldRef) =>
      w.request('PATCH', `/fields/${f.id}`, { ifMatch: await fieldRevision(w, f.id), body: { enabled: false } });
    // 停用 later 后新引用它 → 400
    expect((await disable(later)).status).toBe(200);
    const fresh = await w.request('PATCH', `${CALC_RULES}/${rule.id}`, {
      ifMatch: rule.revision,
      body: {
        items: [calcItem(target, '盘点对象.停用源 + 盘点对象.后停用')],
        fieldCatalogVersion: await version(w),
      },
    });
    const error = await errorOf(fresh);
    expect([fresh.status, error.details['reason']]).toEqual([400, 'CALC_FORMULA_FIELD_DISABLED']);
    // source：先改名再停用；原有引用以新名称 + 绑定重提 → 保留，不算新增引用
    expect((await renameField(w, source, '停用源新名')).status).toBe(200);
    expect((await disable(source)).status).toBe(200);
    const keep = await w.request('PATCH', `${CALC_RULES}/${rule.id}`, {
      ifMatch: rule.revision,
      body: { items: [calcItem(target, '盘点对象.停用源新名 + 1', { formulaBindings: [source.id] })] },
    });
    expect(keep.status, await keep.clone().text()).toBe(200);
  });
});
