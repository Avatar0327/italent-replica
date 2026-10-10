/**
 * AC-TR-calc-rule-round3 · PR #184 第 2 轮审查的 P2 回归（每项先失败）：
 * - P2-02 残留：重放的引用复核独立遍历全部公式引用，不依赖遇到首个业务错误就返回的分析器（受控授权，字段目录切到创建人范围）；
 * - P2-03 回归：启用命令的 hints 按**当前**授权裁剪（首次与重放同一套），不带当前看不到的字段名；
 * - P2-06（已实现部分）：删除守卫按解析后的引用判断，路径里的空白、换行、制表符不漏；
 * - P2-08 残留：字段目录不可访问（无对象查看权 / 范围外 / 缺四列任一列）时启用循环规则仍给出不含字段名的提示（DEC-274）。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { eq, talentReviewFields, withTenant } from '@italent/db';
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { type PermissionWorld, seedPermissionWorld, setObjectPermission } from './AC-PRM-support.js';
import {
  CALC_RULES,
  calcBody,
  calcItem,
  calcRuleOperator,
  calcWorld,
  type CalcRuleView,
  type FieldRef,
  pathOf,
} from './AC-TR-calc-rule-support.js';
import { configBody, TR_BASE, TR_NOW } from './AC-TR-config-support.js';
import { errorCode, tenantApi } from './support/tenant-api.js';
import './support/b5-path.js';

const testDb = useTestDb();
const clock = () => TR_NOW;
interface Failure {
  error: { code: string; details: { reason: string; item?: number; issues?: { code: string }[] } };
}

const REFERENCE_COLUMNS = ['name', 'kind', 'enabled', 'systemWritten'] as const;

describe('AC-TR-calc-rule 重放与启用提示按当前授权（真实授权器）', () => {
  let world: PermissionWorld;
  let setup: ReturnType<typeof tenantApi>;
  const adminField = async (extra: Record<string, unknown> = {}) => {
    const response = await setup.request('POST', `${TR_BASE}/fields`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: configBody('field', { kind: 'number', group: 'result', ...extra }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as FieldRef & { revision: number };
  };
  /** 字段目录的对象权限：可建（create）+ 指定列不可见。 */
  const fieldPermission = (
    operator: Awaited<ReturnType<typeof calcRuleOperator>>,
    options: { create?: boolean; hidden?: readonly string[] },
  ) =>
    setObjectPermission(
      world,
      operator.profile,
      {
        dataOperations: { create: options.create ?? false, update: false, delete: false },
        fields: TALENT_REVIEW_OBJECTS.field.fields.map((item) => ({
          fieldCode: item.code,
          view: !(options.hidden ?? []).includes(item.code),
          edit: options.create === true && !item.system,
        })),
        buttons: options.create
          ? TALENT_REVIEW_OBJECTS.field.buttons.map((button) => ({ buttonCode: button.code, level: button.level }))
          : [],
      },
      TALENT_REVIEW_OBJECTS.field.code,
    );

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    setup = tenantApi(world.db, { clock });
  });

  /** 启用 Year(IF(真,Today(),1)) 的项目：首次响应的 hints 带目标字段名（前置条件）。 */
  async function enabledWithHint() {
    const operator = await calcRuleOperator(world, { seeAll: true, fields: 'seeAll' });
    const target = await adminField({ name: `目标${randomUUID().slice(0, 6)}` });
    const created = await operator.request('POST', CALC_RULES, {
      ifMatch: 0,
      body: calcBody([calcItem(target, 'Year(IF(真,Today(),1))')], { enabled: false }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const rule = (await created.json()) as CalcRuleView;
    const enable = { ifMatch: 1, idempotencyKey: `trk-r3-enable-${randomUUID()}`, body: { enabled: true } };
    const first = await operator.request('PATCH', `${CALC_RULES}/${rule.id}`, enable);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(JSON.stringify((await first.json()) as CalcRuleView)).toContain(target.name);
    return { operator, target, rule, enable };
  }

  it('P2-03 回归：撤销字段目录范围后重放启用命令，hints 不再带目标字段名', async () => {
    const { operator, target, rule, enable } = await enabledWithHint();
    await operator.setSeeAll('field', false);
    const replay = await operator.request('PATCH', `${CALC_RULES}/${rule.id}`, enable);
    expect(replay.status).toBe(200);
    const view = (await replay.json()) as CalcRuleView;
    expect(view.hints).toBeDefined();
    expect(JSON.stringify(view)).not.toContain(target.name);
  });

  it.each(REFERENCE_COLUMNS)(
    'P2-03 回归：撤销字段目录「%s」列查看权后重放启用命令，hints 不带目标字段名',
    async (column) => {
      const { operator, target, rule, enable } = await enabledWithHint();
      expect((await fieldPermission(operator, { hidden: [column] })).status).toBe(200);
      const replay = await operator.request('PATCH', `${CALC_RULES}/${rule.id}`, enable);
      expect(replay.status).toBe(200);
      const view = (await replay.json()) as CalcRuleView;
      expect(view.hints).toBeDefined();
      expect(JSON.stringify(view)).not.toContain(target.name);
    },
  );

  /** 管理员保存的停用循环规则（两个字段互相引用）。 */
  async function cyclicRule() {
    const [a, b] = [
      await adminField({ name: `甲${randomUUID().slice(0, 6)}` }),
      await adminField({ name: `乙${randomUUID().slice(0, 6)}` }),
    ];
    const created = await setup.request('POST', `${TR_BASE}${CALC_RULES}`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: calcBody([calcItem(a, `${pathOf(b)} + 1`), calcItem(b, `${pathOf(a)} + 1`)], { enabled: false }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    return { a, b, rule: (await created.json()) as CalcRuleView };
  }

  type Lacking = { readonly fields: 'none' | 'creator' | 'seeAll'; readonly column?: string };
  const LACKING: readonly (readonly [string, Lacking])[] = [
    ['没有字段目录对象查看权', { fields: 'none' }],
    ['字段目录范围里没有这些字段', { fields: 'creator' }],
    ...REFERENCE_COLUMNS.map((column) => [`缺字段目录「${column}」列查看权`, { fields: 'seeAll', column }] as const),
  ];
  it.each(LACKING)('P2-08 残留：%s 时启用循环规则：200，仍给出不含字段名的循环提示', async (_label, options) => {
    const { a, b, rule } = await cyclicRule();
    const operator = await calcRuleOperator(world, { seeAll: true, fields: options.fields });
    if (options.column) expect((await fieldPermission(operator, { hidden: [options.column] })).status).toBe(200);
    const enable = await operator.request('PATCH', `${CALC_RULES}/${rule.id}`, { ifMatch: 1, body: { enabled: true } });
    expect(enable.status, await enable.clone().text()).toBe(200);
    const view = (await enable.json()) as CalcRuleView;
    expect(view.enabled).toBe(true);
    expect(view.hints?.warnings.join('；')).toContain('循环依赖');
    expect(view.hints?.blocked).toHaveLength(2);
    const text = JSON.stringify(view.hints);
    expect(text).not.toContain(a.name);
    expect(text).not.toContain(b.name);
  });

  it('P2-08：字段都可见时启用循环规则照常给出带字段路径的代表环', async () => {
    const { a, b, rule } = await cyclicRule();
    const operator = await calcRuleOperator(world, { seeAll: true, fields: 'seeAll' });
    const enable = await operator.request('PATCH', `${CALC_RULES}/${rule.id}`, { ifMatch: 1, body: { enabled: true } });
    const view = (await enable.json()) as CalcRuleView;
    expect(view.hints?.cycles).toHaveLength(1);
    expect(view.hints?.cycles[0]).toEqual(expect.arrayContaining([pathOf(a), pathOf(b)]));
  });
});

describe('AC-TR-calc-rule P2-06（已实现部分）删除守卫按解析后的引用判断', () => {
  it.each([
    ['点号前空白', (p: string) => p.replace('.', ' .')],
    ['点号后空白', (p: string) => p.replace('.', '. ')],
    ['点号两侧空白', (p: string) => p.replace('.', ' . ')],
    ['换行', (p: string) => p.replace('.', '\n.')],
    ['制表符', (p: string) => p.replace('.', '.\t')],
  ])('公式里的路径带%s：可保存，被引用的来源字段删除 409 FIELD_IN_USE', async (_label, spaced) => {
    const w = await calcWorld(testDb().db, `trk-r3-guard-${randomUUID().slice(0, 4)}`);
    const [target, source] = [await w.numberField(), await w.numberField()];
    await w.create(calcBody([calcItem(target, `${spaced(pathOf(source))} + 1`)]));
    const blocked = await w.request('DELETE', `/fields/${source.id}`, { ifMatch: 1 });
    expect(blocked.status, await blocked.clone().text()).toBe(409);
    expect(await errorCode(blocked)).toBe('CONFLICT');
  });
});

describe('AC-TR-calc-rule P2-02 残留：重放的引用复核独立遍历全部公式引用', () => {
  it('首项目目标出现同名字段（业务分析先报重名）时，后续项目里已撤出范围的来源字段仍被复核：POST / items PATCH 重放 400', async () => {
    const w = await calcWorld(testDb().db, `trk-r3-replay-${randomUUID().slice(0, 4)}`);
    // 受控授权：功能权限全开；字段目录的范围可从“看全部”切到“只看自己建的”（创建人范围），其余对象看全部
    let fieldScope: ModuleScope = { ...EMPTY_SCOPE, all: true, hasDataPermission: true, source: 'identity' };
    const authorize: Authorizer = () => true;
    registerScopeProvider(authorize, {
      scope: async (query) =>
        query.objectCode === TALENT_REVIEW_OBJECTS.field.code
          ? fieldScope
          : { ...EMPTY_SCOPE, all: true, hasDataPermission: true, source: 'identity' },
      authorize: async () => true,
      fields: async (_tenant, _user, code) =>
        new Set(
          Object.values(TALENT_REVIEW_OBJECTS)
            .find((item) => item.code === code)!
            .fields.map((f) => f.code),
        ),
    });
    const api = tenantApi(testDb().db, { authorize, clock });
    const as = w.as;
    const request = (method: string, path: string, options: object) =>
      api.request(method, `${TR_BASE}${path}`, { ...as, ...options });
    const [first, second, source] = [await w.numberField(), await w.numberField(), await w.numberField()];
    // 来源字段不是操作人建的：撤成创建人范围后看不到
    await withTenant(testDb().db, as.tenant, (tx) =>
      tx.update(talentReviewFields).set({ createdBy: null }).where(eq(talentReviewFields.id, source.id)),
    );
    const post = {
      ifMatch: 0,
      idempotencyKey: `trk-r3-post-${randomUUID()}`,
      body: calcBody([calcItem(first, '1'), calcItem(second, `${pathOf(source)} + 1`)]),
    };
    const created = await request('POST', CALC_RULES, post);
    expect(created.status, await created.clone().text()).toBe(201);
    const rule = (await created.json()) as CalcRuleView;
    const patch = {
      ifMatch: 1,
      idempotencyKey: `trk-r3-patch-${randomUUID()}`,
      body: { items: [calcItem(first, '2'), calcItem(second, `${pathOf(source)} + 2`)] },
    };
    expect((await request('PATCH', `${CALC_RULES}/${rule.id}`, patch)).status).toBe(200);
    // 首项目目标出现同名字段（操作人自己建的，在其创建人范围内）：业务分析会先报 CALC_FIELD_NAME_AMBIGUOUS
    await w.field('number', { name: first.name });
    fieldScope = {
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      terms: [{ dimension: 'using_user', orgIds: [], personIds: [], creatorId: as.user }],
    };
    for (const replay of [
      await request('POST', CALC_RULES, post),
      await request('PATCH', `${CALC_RULES}/${rule.id}`, patch),
    ]) {
      expect(replay.status, await replay.clone().text()).toBe(400);
      const { details } = ((await replay.json()) as Failure).error;
      expect(details.issues?.map((issue) => issue.code)).toContain('UNKNOWN_FIELD');
    }
  });
});
