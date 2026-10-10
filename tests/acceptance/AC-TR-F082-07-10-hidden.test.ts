/**
 * F-082 AC-07（停用按 ID 判断）、AC-10（不可见引用）、AC-10a（原样保留超长）——F082-3，开关打开，真实授权器：
 * 查看人只看得到自己创建的字段（字段目录范围 = 创建人），看不到的引用渲染为 `盘点对象.〔不可见字段〕`，
 * formulaBindings 对应处为 null；原样保留提交不改引用；整段重写移除不可见引用；改动后仍含占位符 → 400 HIDDEN_FIELD。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import {
  CALC_RULES,
  calcBody,
  calcItem,
  calcRuleOperator,
  type CalcRuleView,
  type FieldRef,
} from './AC-TR-calc-rule-support.js';
import { configBody, TR_BASE, TR_NOW } from './AC-TR-config-support.js';
import {
  catalogVersion,
  errorOf,
  itemIdOf,
  rawItem,
  refsOf,
  renameField,
  type F082World,
} from './AC-TR-F082-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const clock = () => TR_NOW;
const PLACEHOLDER = '〔不可见字段〕';

let world: PermissionWorld;
let setup: ReturnType<typeof tenantApi>;
const asWorld = () => ({ as: { tenant: world.tenant.id }, request: setupRequest }) as unknown as F082World;
const setupRequest = (method: string, path: string, options: Record<string, unknown> = {}) =>
  setup.request(method, `${TR_BASE}${path}`, { ...world.asAdmin, ...options });

beforeAll(async () => {
  world = await seedPermissionWorld(testDb().db);
  world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock, formulaIdBinding: true }) };
  setup = tenantApi(world.db, { clock, formulaIdBinding: true });
});

async function create<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await setupRequest('POST', path, { ifMatch: 0, body });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as T;
}
const field = (name: string, extra: Record<string, unknown> = {}) =>
  create<FieldRef & { enabled: boolean; revision: number }>(
    '/fields',
    configBody('field', { kind: 'number', group: 'result', name, ...extra }),
  );
/** 把字段的创建人改成查看人：字段目录范围是“创建人”的查看人只看得到这些字段。 */
async function ownedBy(userId: string, ...ids: string[]) {
  for (const id of ids) {
    await withTenant(testDb().db, world.tenant.id, (tx) =>
      tx.execute(sql`UPDATE talent_review_fields SET created_by = ${userId} WHERE id = ${id}`),
    );
  }
}
async function version() {
  return catalogVersion(testDb().db, asWorld());
}
async function adminRule(items: Record<string, unknown>[], name?: string) {
  const body = calcBody(items, { fieldCatalogVersion: await version(), ...(name ? { name } : {}) });
  return create<CalcRuleView>(CALC_RULES, body);
}

describe('AC-10 不可见引用（DEC-376①）', () => {
  it('看不到的引用渲染成占位符、绑定为 null，名称与 ID 不出现在 GET / 写响应 / 错误里；原样保留 / 整段重写 / 改动后含占位符各自的结果', async () => {
    const viewer = await calcRuleOperator(world, { seeAll: true, fields: 'creator' });
    const [target, open, secret] = [await field('目标项'), await field('公开项'), await field('机密项')];
    await ownedBy(viewer.user.id, target.id, open.id);
    const rule = await adminRule([calcItem(target, '盘点对象.公开项 + 盘点对象.机密项')]);
    const itemId = await itemIdOf(testDb().db, asWorld(), rule.id, target.id);
    const original = (await rawItem(testDb().db, asWorld(), itemId)).formula;

    const got = await viewer.request('GET', `${CALC_RULES}/${rule.id}`);
    const text = await got.clone().text();
    const view = (await got.json()) as CalcRuleView;
    const shown = `盘点对象.公开项 + 盘点对象.${PLACEHOLDER}`;
    expect(view.items[0]).toMatchObject({ formula: shown, formulaBindings: [open.id, null] });
    for (const secretText of ['机密项', secret.id]) expect(text, secretText).not.toContain(secretText);

    // 原样保留：公式与绑定逐字相同 → 200，规范文本与引用（含不可见字段）不变
    const keep = await viewer.request('PATCH', `${CALC_RULES}/${rule.id}`, {
      ifMatch: view.revision,
      body: { items: [calcItem(target, shown, { formulaBindings: [open.id, null] })] },
    });
    expect(keep.status, await keep.clone().text()).toBe(200);
    expect((await rawItem(testDb().db, asWorld(), itemId)).formula).toBe(original);
    expect((await refsOf(testDb().db, asWorld(), itemId)).map((row) => row.field_id).sort()).toEqual(
      [open.id, secret.id].sort(),
    );

    // 改动后仍含占位符 → 400 HIDDEN_FIELD，错误里没有机密名称 / ID
    const kept = (await keep.json()) as CalcRuleView;
    const changed = await viewer.request('PATCH', `${CALC_RULES}/${rule.id}`, {
      ifMatch: kept.revision,
      body: { items: [calcItem(target, `${shown} + 1`, { formulaBindings: [open.id, null] })] },
    });
    const error = await errorOf(changed);
    expect([changed.status, JSON.stringify(error.details)]).toEqual([400, expect.stringContaining('HIDDEN_FIELD')]);
    for (const secretText of ['机密项', secret.id]) expect(JSON.stringify(error)).not.toContain(secretText);

    // 字符串里的“〔不可见字段〕”不算占位符
    const literal = await viewer.request('PATCH', `${CALC_RULES}/${rule.id}`, {
      ifMatch: kept.revision,
      body: {
        items: [calcItem(target, `盘点对象.公开项 + Len("${PLACEHOLDER}")`, { formulaBindings: [open.id] })],
        fieldCatalogVersion: await version(),
      },
    });
    expect(literal.status, await literal.clone().text()).toBe(200);
    // 整段重写（不含占位符）→ 引用移除，机密字段不再被引用
    expect((await refsOf(testDb().db, asWorld(), itemId)).map((row) => row.field_id)).toEqual([open.id]);
  });
});

describe('AC-10a 原样保留超长（P3）', () => {
  it('合法的 4000 字公式隐藏一个单字字段，回显更长：原样保留 → 200 规范文本不变；同一回显改动一处 → 400', async () => {
    const viewer = await calcRuleOperator(world, { seeAll: true, fields: 'creator' });
    const [target, tiny] = [await field('长目标'), await field('秘')];
    await ownedBy(viewer.user.id, target.id);
    const prefix = '盘点对象.秘 + Len("';
    const suffix = '")';
    const formula = `${prefix}${'x'.repeat(4000 - prefix.length - suffix.length)}${suffix}`;
    expect(formula).toHaveLength(4000);
    const rule = await adminRule([calcItem(target, formula)]);
    const itemId = await itemIdOf(testDb().db, asWorld(), rule.id, target.id);
    const original = (await rawItem(testDb().db, asWorld(), itemId)).formula;

    const view = (await (await viewer.request('GET', `${CALC_RULES}/${rule.id}`)).json()) as CalcRuleView;
    const echo = view.items[0]!.formula;
    expect(echo.length).toBeGreaterThan(4000);
    expect(echo.length).toBeLessThanOrEqual(8000);
    expect(view.items[0]!.formulaBindings).toEqual([null]);

    const keep = await viewer.request('PATCH', `${CALC_RULES}/${rule.id}`, {
      ifMatch: view.revision,
      body: { items: [calcItem(target, echo, { formulaBindings: [null] })] },
    });
    expect(keep.status, await keep.clone().text()).toBe(200);
    expect((await rawItem(testDb().db, asWorld(), itemId)).formula).toBe(original);

    const kept = (await keep.json()) as CalcRuleView;
    const edited = await viewer.request('PATCH', `${CALC_RULES}/${rule.id}`, {
      ifMatch: kept.revision,
      body: { items: [calcItem(target, echo.replace('x', 'y'), { formulaBindings: [null] })] },
    });
    expect(edited.status).toBe(400);
    expect(JSON.stringify((await errorOf(edited)).details)).toMatch(/HIDDEN_FIELD|TOO_LONG/);
    expect(tiny.name).toBe('秘');
  });
});

describe('AC-07 停用按 ID 判断', () => {
  it('新引用停用字段 → 400 CALC_FORMULA_FIELD_DISABLED；字段先改名再停用，原有引用重提仍算“保留”', async () => {
    const w = asWorld();
    const [target, source, later] = [await field('停用目标'), await field('停用源'), await field('后停用')];
    const rule = await adminRule([calcItem(target, '盘点对象.停用源 + 1')]);
    // 停用 later 后新引用它 → 400
    const disable = async (f: FieldRef & { revision: number }) =>
      setupRequest('PATCH', `/fields/${f.id}`, { ifMatch: f.revision, body: { enabled: false } });
    expect((await disable(later)).status).toBe(200);
    const fresh = await setupRequest('PATCH', `${CALC_RULES}/${rule.id}`, {
      ifMatch: rule.revision,
      body: {
        items: [calcItem(target, '盘点对象.停用源 + 盘点对象.后停用')],
        fieldCatalogVersion: await version(),
      },
    });
    const error = await errorOf(fresh);
    expect([fresh.status, error.details['reason']]).toEqual([400, 'CALC_FORMULA_FIELD_DISABLED']);
    // source：先改名再停用；原有引用以新名称 + 绑定重提 → 保留，不算新增引用
    expect((await renameField(w, source, '停用源新名')).status).toBe(200);
    const current = (await (await setupRequest('GET', `/fields/${source.id}`)).json()) as { revision: number };
    expect((await disable({ ...source, revision: current.revision })).status).toBe(200);
    const keep = await setupRequest('PATCH', `${CALC_RULES}/${rule.id}`, {
      ifMatch: rule.revision,
      body: { items: [calcItem(target, '盘点对象.停用源新名 + 1', { formulaBindings: [source.id] })] },
    });
    expect(keep.status, await keep.clone().text()).toBe(200);
  });
});
