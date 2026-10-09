/**
 * AC-TR-calc-rule-round2 · PR #184 第 1 轮审查的 P2 回归（每项先失败）：
 * P2-01 隐藏的默认排序字段（sortNo / name）不能影响列表顺序与分页；
 * P2-02 命令重放按当前字段目录范围复核目标字段，撤范围后重放 404；
 * P2-03 目标 / 公式引用字段须查看人对字段目录的 name / kind / enabled / systemWritten 列都有查看权，
 *       没有列权限时与不存在不可区分（不暴露隐藏字段的名称、类型、停用与系统写入属性）；
 * P2-04 字段绑定统一一次：公式里的字段只认完整路径，类型检查、依赖分析、uses_ranking 同一结果；
 * P2-05 公式不能新增引用已停用的字段（保留已有引用不受影响）；
 * P2-06（部分）仅被公式引用的字段不能删除；
 * P2-08 只提交 { enabled: true } 也分析已存项目并返回不阻断的 hints。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { talentReviewFields, withTenant } from '@italent/db';
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
import { errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const clock = () => TR_NOW;
interface Failure {
  error: { code: string; details: { reason: string; item?: number; issues?: { code: string }[] } };
}
const failure = async (response: Response) => ((await response.json()) as Failure).error;

/** 受控授权：功能权限与范围全开，只隐藏指定的字段目录 / 计算规则列。 */
function hiding(...hidden: string[]) {
  const authorize: Authorizer = () => true;
  const visible = new Set(
    [...TALENT_REVIEW_OBJECTS.calcRule.fields, ...TALENT_REVIEW_OBJECTS.field.fields]
      .map((field) => field.code)
      .filter((code) => !hidden.includes(code)),
  );
  registerScopeProvider(authorize, {
    scope: async () => ({ ...EMPTY_SCOPE, all: true, hasDataPermission: true, source: 'identity' }),
    authorize: async () => true,
    fields: async () => visible,
  });
  return tenantApi(testDb().db, { authorize, clock });
}

describe('P2-01 隐藏的默认排序字段不影响列表顺序与分页', () => {
  const ids = async (api: ReturnType<typeof tenantApi>, w: { as: { user: string; tenant: string } }, query = '') =>
    (
      (await (await api.request('GET', `${TR_BASE}${CALC_RULES}${query}`, w.as)).json()) as {
        items: { id: string }[];
      }
    ).items.map((item) => item.id);

  it('看不到 sortNo：按可见的 name 排序，管理员改隐藏的 sortNo 不改变第一页', async () => {
    const w = await calcWorld(testDb().db, 'trk-r2-sort-primary');
    const [a, b] = [await w.numberField(), await w.numberField()];
    const first = await w.create(calcBody([calcItem(a, '1')], { name: '甲规则', sortNo: 9 }));
    const second = await w.create(calcBody([calcItem(b, '1')], { name: '乙规则', sortNo: 1 }));
    const api = hiding('sortNo');
    expect([await ids(api, w, '?pageSize=1&page=1'), await ids(api, w, '?pageSize=1&page=2')]).toEqual([
      [first.id],
      [second.id],
    ]);
    const edit = await w.request('PATCH', `${CALC_RULES}/${second.id}`, { ifMatch: 1, body: { sortNo: 0 } });
    expect(edit.status).toBe(200);
    expect([await ids(api, w, '?pageSize=1&page=1'), await ids(api, w, '?pageSize=1&page=2')]).toEqual([
      [first.id],
      [second.id],
    ]);
  });

  it('看不到 name：同 sortNo 时用稳定标识；sortNo 与 name 都看不到：只按稳定标识', async () => {
    const w = await calcWorld(testDb().db, 'trk-r2-sort-secondary');
    const made: CalcRuleView[] = [];
    for (let i = 0; i < 6; i += 1) {
      made.push(
        await w.create(calcBody([calcItem(await w.numberField(), '1')], { name: `规则${'zyxwvu'[i]}`, sortNo: 5 })),
      );
    }
    expect(await ids(hiding('name'), w)).toEqual(made.map((item) => item.id).sort());
    expect(await ids(hiding('name', 'sortNo'), w)).toEqual(made.map((item) => item.id).sort());
  });
});

describe('权限与重放（真实授权器）', () => {
  let world: PermissionWorld;
  let setup: ReturnType<typeof tenantApi>;
  const adminField = async (extra: Record<string, unknown> = {}) => {
    const response = await setup.request('POST', `${TR_BASE}/fields`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: configBody('field', { kind: 'number', group: 'result', ...extra }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; name: string; revision: number };
  };

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    setup = tenantApi(world.db, { clock });
  });

  it('P2-02 创建：撤销字段目录范围后，原命令重放 404（新命令 ID 同样 404）；带 items 的修改同理', async () => {
    const operator = await calcRuleOperator(world, { seeAll: true, fields: 'seeAll' });
    const [a, b] = [await adminField(), await adminField()];
    const options = {
      ifMatch: 0,
      idempotencyKey: `trk-r2-create-${randomUUID()}`,
      body: calcBody([calcItem(a, '1')]),
    };
    const created = await operator.request('POST', CALC_RULES, options);
    expect(created.status, await created.clone().text()).toBe(201);
    const mine = (await created.json()) as CalcRuleView;
    const patch = {
      ifMatch: 1,
      idempotencyKey: `trk-r2-patch-${randomUUID()}`,
      body: { items: [calcItem(a, '2'), calcItem(b, '3')] },
    };
    expect((await operator.request('PATCH', `${CALC_RULES}/${mine.id}`, patch)).status).toBe(200);
    await operator.setSeeAll('field', false);
    for (const replay of [
      await operator.request('POST', CALC_RULES, options),
      await operator.request('PATCH', `${CALC_RULES}/${mine.id}`, patch),
    ]) {
      expect([replay.status, await errorCode(replay)]).toEqual([404, 'NOT_FOUND']);
    }
    const fresh = await operator.request('POST', CALC_RULES, {
      ...options,
      idempotencyKey: `trk-r2-create-${randomUUID()}`,
      body: calcBody([calcItem(await adminField(), '1')]),
    });
    expect(fresh.status).toBe(404);
  });

  it.each([
    ['kind', { kind: 'multi_option', group: 'basic', options: [{ value: 'a', label: '甲' }] }],
    ['systemWritten', {}],
    ['enabled', {}],
    ['name', {}],
  ])(
    'P2-03 没有字段目录「%s」列查看权：引用该字段与不存在不可区分（同一个 404），不暴露隐藏属性',
    async (column, extra) => {
      const operator = await calcRuleOperator(world, { seeAll: true, fields: 'seeAll', fieldHidden: [column] });
      const target = await adminField(extra);
      if (column === 'enabled') {
        await setup.request('PATCH', `${TR_BASE}/fields/${target.id}`, {
          ...world.asAdmin,
          ifMatch: target.revision,
          body: { enabled: false },
        });
      }
      const body = calcBody([calcItem(target, '1')]);
      const hidden = await operator.request('POST', CALC_RULES, { ifMatch: 0, body });
      const unknown = await operator.request('POST', CALC_RULES, {
        ifMatch: 0,
        body: calcBody([{ ...body.items[0]!, targetFieldId: '00000000-0000-4000-8000-000000000000' }]),
      });
      expect([hidden.status, await hidden.json()]).toEqual([404, await unknown.json()]);
      const all = await setup.request('GET', `${TR_BASE}${CALC_RULES}?pageSize=100`, world.asAdmin);
      expect(((await all.json()) as { items: { name: string }[] }).items.map((i) => i.name)).not.toContain(body.name);
    },
  );

  it('P2-03 公式里引用没有 name 列查看权的字段：与不存在的字段名同为未知字段；hints 不带隐藏字段名', async () => {
    const own = await adminField();
    const other = await adminField();
    const full = await calcRuleOperator(world, { seeAll: true, fields: 'seeAll' });
    const rule = await full.request('POST', CALC_RULES, { ifMatch: 0, body: calcBody([calcItem(own, '1')]) });
    const mine = (await rule.json()) as CalcRuleView;
    const hiddenName = await calcRuleOperator(world, { seeAll: true, fields: 'seeAll', fieldHidden: ['name'] });
    const guess = await hiddenName.request('PATCH', `${CALC_RULES}/${mine.id}`, {
      ifMatch: 1,
      body: { items: [calcItem(own, `${pathOf(other)} + 1`)] },
    });
    expect([guess.status, await errorCode(guess)]).toEqual([404, 'NOT_FOUND']);
  });
});

describe('P2-04 字段绑定统一一次（只认完整路径）', () => {
  it('目标短名不是合法引用：含排名函数的项目不会因短名漏掉 uses_ranking，类型错误不放行', async () => {
    const w = await calcWorld(testDb().db, 'trk-r2-binding');
    const [score, rank, year] = [await w.numberField(), await w.numberField(), await w.numberField()];
    const shortName = await w.post(
      calcBody([calcItem(score, '80'), calcItem(rank, `Ranking("百分位", ${score.name})`, { priority: 2 })]),
    );
    const error = await failure(shortName);
    expect([shortName.status, error.details.reason, error.details.item, error.details.issues?.[0]?.code]).toEqual([
      400,
      'FORMULA_INVALID',
      1,
      'UNKNOWN_FIELD',
    ]);
    const full = await w.create(
      calcBody([calcItem(score, '80'), calcItem(rank, `Ranking("百分位", ${pathOf(score)})`, { priority: 2 })]),
    );
    expect(full.items.map((item) => item.usesRanking)).toEqual([false, true]);
    const typed = await w.post(calcBody([calcItem(score, '80'), calcItem(year, `Year(${pathOf(score)})`)]));
    const typedError = await failure(typed);
    expect([typed.status, typedError.details.reason, typedError.details.issues?.[0]?.code]).toEqual([
      400,
      'FORMULA_INVALID',
      'ARGUMENT_TYPE',
    ]);
  });

  it('字段目录里重名的字段：作目标 400 CALC_FIELD_NAME_AMBIGUOUS，公式引用该名称为未知字段', async () => {
    const w = await calcWorld(testDb().db, 'trk-r2-ambiguous');
    const [a, b, c] = [await w.numberField(), await w.numberField(), await w.numberField()];
    await withTenant(testDb().db, w.as.tenant, async (tx) => {
      const { eq } = await import('@italent/db');
      await tx.update(talentReviewFields).set({ name: a.name }).where(eq(talentReviewFields.id, b.id));
    });
    const asTarget = await w.post(calcBody([calcItem(a, '1')]));
    expect([asTarget.status, (await failure(asTarget)).details.reason]).toEqual([400, 'CALC_FIELD_NAME_AMBIGUOUS']);
    const inFormula = await w.post(calcBody([calcItem(c, `${pathOf(a)} + 1`)]));
    expect([inFormula.status, (await failure(inFormula)).details.issues?.[0]?.code]).toEqual([400, 'UNKNOWN_FIELD']);
  });
});

describe('P2-05 公式不能新增引用已停用字段', () => {
  it('新增引用 400 CALC_FORMULA_FIELD_DISABLED；保留已有引用（含改优先级 / 说明）不受影响', async () => {
    const w = await calcWorld(testDb().db, 'trk-r2-disabled');
    const [target, source, fresh] = [await w.numberField(), await w.numberField(), await w.numberField()];
    const created = await w.create(calcBody([calcItem(target, `${pathOf(source)} + 1`)]));
    for (const field of [source, fresh]) {
      const off = await w.request('PATCH', `/fields/${field.id}`, { ifMatch: 1, body: { enabled: false } });
      expect(off.status).toBe(200);
    }
    const keep = await w.request('PATCH', `${CALC_RULES}/${created.id}`, {
      ifMatch: 1,
      body: { items: [calcItem(target, `${pathOf(source)} + 1`, { priority: 7, description: '改说明' })] },
    });
    expect(keep.status, await keep.clone().text()).toBe(200);
    const added = await w.request('PATCH', `${CALC_RULES}/${created.id}`, {
      ifMatch: 2,
      body: { items: [calcItem(target, `${pathOf(source)} + ${pathOf(fresh)}`)] },
    });
    const error = await failure(added);
    expect([added.status, error.details.reason, error.details.item]).toEqual([400, 'CALC_FORMULA_FIELD_DISABLED', 0]);
    const brandNew = await w.post(calcBody([calcItem(await w.numberField(), `${pathOf(fresh)} + 1`)]));
    expect([brandNew.status, (await failure(brandNew)).details.reason]).toEqual([400, 'CALC_FORMULA_FIELD_DISABLED']);
    expect((await w.read(created.id)).body.revision).toBe(2);
  });
});

describe('P2-06（部分）仅被公式引用的字段不能删除', () => {
  it('删除只在公式里被引用（不是目标）的字段 409 FIELD_IN_USE，referrer = CALC_RULE；规则删除后可删', async () => {
    const w = await calcWorld(testDb().db, 'trk-r2-field-guard');
    const [target, source] = [await w.numberField(), await w.numberField()];
    const created = await w.create(calcBody([calcItem(target, `${pathOf(source)} + 1`)]));
    const blocked = await w.request('DELETE', `/fields/${source.id}`, { ifMatch: 1 });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: { details: { reason: 'FIELD_IN_USE', referrer: 'CALC_RULE' } },
    });
    expect((await w.request('DELETE', `${CALC_RULES}/${created.id}`, { ifMatch: 1 })).status).toBe(200);
    expect((await w.request('DELETE', `/fields/${source.id}`, { ifMatch: 1 })).status).toBe(200);
  });
});

describe('P2-08 启用也返回不阻断的保存提示（DEC-274）', () => {
  it('只提交 { enabled: true }：循环依赖仍允许启用，响应带 hints.cycles；不带 items 的其他修改不带 hints', async () => {
    const w = await calcWorld(testDb().db, 'trk-r2-enable');
    const [a, b] = [await w.numberField(), await w.numberField()];
    const created = await w.create(
      calcBody([calcItem(a, `${pathOf(b)} + 1`), calcItem(b, `${pathOf(a)} + 1`)], { enabled: false }),
    );
    const rename = await w.request('PATCH', `${CALC_RULES}/${created.id}`, { ifMatch: 1, body: { sortNo: 3 } });
    expect(((await rename.json()) as CalcRuleView).hints).toBeUndefined();
    const enable = await w.request('PATCH', `${CALC_RULES}/${created.id}`, { ifMatch: 2, body: { enabled: true } });
    expect(enable.status, await enable.clone().text()).toBe(200);
    const view = (await enable.json()) as CalcRuleView;
    expect(view.enabled).toBe(true);
    expect(view.hints?.cycles).toHaveLength(1);
    expect(view.hints?.blocked).toHaveLength(2);
    expect(withoutHints(view)).toEqual((await w.read(created.id)).body);
  });
});
