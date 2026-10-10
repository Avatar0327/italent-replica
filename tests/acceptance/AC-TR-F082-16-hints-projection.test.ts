/**
 * F-082 AC-16（F082-4，开关打开；契约 §5.2、P2-3）：hints 的统一投影，GET 详情 / 列表 / 写响应 / 重放共用：
 * - 没有 `items` 查看权：`order`、`blocked`、`cycles` 都为空，`warnings` 只有固定一句，`others` 计数正确，不含任何 ID 或名称
 *   （A→B→A 循环用例）；
 * - 有 `items` 但目标不可见：含不可见目标的环不列出，汇总成不含名称的提示；`order` / `blocked` 只列可见目标，`others` 给被裁掉的个数。
 * 查看人只有“创建人”数据范围（只看得到自己创建的字段与规则）。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { createUser, grantMembership, sql, withTenant } from '@italent/db';
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { CALC_RULES, calcBody, calcItem, type CalcRuleView } from './AC-TR-calc-rule-support.js';
import { TR_BASE, TR_NOW } from './AC-TR-config-support.js';
import { boundWorld, catalogVersion } from './AC-TR-F082-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const clock = () => TR_NOW;
const allCodes = [...TALENT_REVIEW_OBJECTS.calcRule.fields, ...TALENT_REVIEW_OBJECTS.field.fields].map((f) => f.code);

/** 受控授权：功能权限全开；数据范围只有“创建人”；可见字段列由参数决定（去掉 items 即没有 items 查看权）。 */
function creatorOnlyApi(codes: ReadonlySet<string>) {
  const authorize: Authorizer = (request) => request.action !== 'data.scope.all';
  registerScopeProvider(authorize, {
    scope: async (query) => ({
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      terms: [{ dimension: 'using_user', creatorId: query.userId, orgIds: [], personIds: [] }],
    }),
    authorize: async (request) => Boolean(await authorize(request)),
    fields: async () => codes,
  });
  return tenantApi(testDb().db, { authorize, clock, formulaIdBinding: true });
}

/** 管理员建 A↔B 循环规则；查看人拥有规则与 A（B 是否归他由参数决定）。 */
async function arena(label: string, options: { itemsViewable: boolean; ownsB: boolean }) {
  const db = testDb().db;
  const w = await boundWorld(db, label);
  const viewerUser = await createUser(db, { email: `f082-${randomUUID()}@example.com`, displayName: '查看人' }, cmd());
  await grantMembership(db, { tenantId: w.as.tenant, userId: viewerUser.id, expectedRevision: 0 }, cmd());
  const codes = new Set(allCodes.filter((code) => options.itemsViewable || code !== 'items'));
  const api = creatorOnlyApi(codes);
  const viewer = (method: string, path: string, extra: Record<string, unknown> = {}) =>
    api.request(method, `${TR_BASE}${path}`, { user: viewerUser.id, tenant: w.as.tenant, ...extra });
  const [a, b] = [await w.field('number', { name: '甲项' }), await w.field('number', { name: '乙项' })];
  const rule = await w.create(
    calcBody([calcItem(a, '盘点对象.乙项 + 1'), calcItem(b, '盘点对象.甲项 + 1')], {
      fieldCatalogVersion: await catalogVersion(db, w),
    }),
  );
  const own = async (table: 'talent_review_fields' | 'talent_review_calc_rules', id: string) =>
    withTenant(db, w.as.tenant, (tx) =>
      tx.execute(sql`UPDATE ${sql.identifier(table)} SET created_by = ${viewerUser.id} WHERE id = ${id}`),
    );
  await own('talent_review_calc_rules', rule.id);
  await own('talent_review_fields', a.id);
  if (options.ownsB) await own('talent_review_fields', b.id);
  return { w, viewer, a, b, rule };
}

type Hints = {
  order: string[];
  blocked: string[];
  cycles: string[][];
  warnings: string[];
  others?: Record<string, number>;
};

/** 同一个规则在四个出口上的 hints：GET 详情、GET 列表、写响应（启用）、同命令 ID 的重放。 */
async function hintsEverywhere(ctx: Awaited<ReturnType<typeof arena>>) {
  const { viewer, rule } = ctx;
  const detail = await viewer('GET', `${CALC_RULES}/${rule.id}`);
  const list = await viewer('GET', CALC_RULES);
  const key = randomUUID();
  const patch = () =>
    viewer('PATCH', `${CALC_RULES}/${rule.id}`, {
      ifMatch: rule.revision,
      body: { enabled: true },
      idempotencyKey: key,
    });
  const written = await patch();
  const replayed = await patch();
  const texts = [
    await detail.clone().text(),
    await list.clone().text(),
    await written.clone().text(),
    await replayed.clone().text(),
  ];
  const views = [
    (await detail.json()) as CalcRuleView,
    ((await list.json()) as { items: CalcRuleView[] }).items.find((entry) => entry.id === rule.id)!,
    (await written.json()) as CalcRuleView,
    (await replayed.json()) as CalcRuleView,
  ];
  return {
    hints: views.map((view) => view.hints as Hints | undefined),
    texts,
    statuses: [detail, list, written, replayed].map((r) => r.status),
  };
}

describe('AC-16 没有 items 查看权：只有匿名计数', () => {
  it('A→B→A 循环：四个出口的 order / blocked / cycles 为空，warnings 只有固定一句，others 正确，响应里没有任何 ID 或名称', async () => {
    const ctx = await arena('f082-p16a', { itemsViewable: false, ownsB: true });
    const out = await hintsEverywhere(ctx);
    expect(out.statuses).toEqual([200, 200, 200, 200]);
    for (const hints of out.hints) {
      expect(hints, '每个出口都返回 hints').toBeDefined();
      expect(hints).toMatchObject({ order: [], blocked: [], cycles: [] });
      expect(hints!.warnings).toHaveLength(1);
      expect(hints!.warnings[0]).toMatch(/^计算项目对你不可见，\d+ 条提示未显示$/);
      expect(hints!.others).toMatchObject({ order: 2, blocked: 2 });
      expect(hints!.others!['warnings']).toBeGreaterThan(0);
    }
    for (const text of out.texts) {
      for (const secret of [ctx.a.id, ctx.b.id, '甲项', '乙项']) expect(text, secret).not.toContain(secret);
    }
  });
});

describe('AC-16 有 items 查看权但目标不可见：不可见环不列出', () => {
  it('B 不归查看人：含 B 的环不列出，汇总成不含名称的提示；order / blocked 只列 A；others 给被裁掉的个数', async () => {
    const ctx = await arena('f082-p16b', { itemsViewable: true, ownsB: false });
    const out = await hintsEverywhere(ctx);
    expect(out.statuses).toEqual([200, 200, 200, 200]);
    for (const hints of out.hints) {
      expect(hints).toBeDefined();
      expect(hints!.order).toEqual([ctx.a.id]);
      expect(hints!.blocked).toEqual([ctx.a.id]);
      expect(hints!.cycles).toEqual([]);
      expect(hints!.warnings.join('|')).toContain('存在循环依赖，涉及当前不可见的字段');
      expect(hints!.others).toMatchObject({ order: 1, blocked: 1 });
    }
    // 规则的 items 本身对有 items 查看权的人可见（含目标字段 ID）；这里只要求 hints 不泄露不可见目标的 ID 与名称
    for (const hints of out.hints) {
      for (const secret of [ctx.b.id, '乙项']) expect(JSON.stringify(hints), secret).not.toContain(secret);
    }
  });

  it('全部可见：环以目标字段 ID 列出（cycles 不再是字段路径），没有 others', async () => {
    const ctx = await arena('f082-p16c', { itemsViewable: true, ownsB: true });
    const out = await hintsEverywhere(ctx);
    for (const hints of out.hints) {
      expect(hints).toBeDefined();
      expect([...hints!.order].sort()).toEqual([ctx.a.id, ctx.b.id].sort());
      expect([...hints!.blocked].sort()).toEqual([ctx.a.id, ctx.b.id].sort());
      expect(hints!.cycles).toHaveLength(1);
      // 环以闭合形式给出（起点在末尾重复一次）：按成员集合比较
      expect([...new Set(hints!.cycles[0]!)].sort()).toEqual([ctx.a.id, ctx.b.id].sort());
      expect(hints!.others).toBeUndefined();
    }
  });
});
