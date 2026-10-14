/**
 * F-082 AC-18 改绑（F082-5，契约 §6.1、§6.3、§6.4）：平台命令
 * POST /api/platform/tenants/:tenantId/talent-review/calc-formulas/rebind，
 * 对该租户全部 legacy 项目（retryUnresolved 时含 unresolved）按迁移时 B5 的解析规则固定绑定：
 * - 成功 → bound：规范文本 + bound 引用，不改规则 revision；
 * - 失败 → unresolved + 原因码，原文不动，写候选引用；
 * - 幂等：第二次无写入、无新审计；bound 行不读不写；报告只有 ID 与原因码，不含公式和字段名称。
 */
import { randomUUID } from 'node:crypto';
import { fieldHandle } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { calcBody, calcItem, catalogVersion, deleteField, type FieldRef, renameField } from './AC-TR-F082-support.js';
import {
  auditCount,
  legacyRule,
  type RebindWorld,
  rebindWorld,
  rawItemOf,
  refsFor,
  REBIND_ACTION,
  setFormulaText,
} from './AC-TR-F082-rebind-support.js';
import { errorOf } from './AC-TR-F082-support.js';

const testDb = useTestDb();

async function world(label: string): Promise<RebindWorld> {
  return rebindWorld(testDb().db, label);
}

describe('AC-18 改绑：legacy → bound', () => {
  it('唯一同名字段 → 规范文本 + bound 引用；revision 不变；读回显示当前名称；改名后跟随', async () => {
    const w = await world('f082-r18a');
    const [t1, t2, a, b] = [
      await w.numberField(),
      await w.numberField(),
      await w.field('number', { name: '甲' }),
      await w.field('number', { name: '乙' }),
    ];
    const one = await legacyRule(w, [{ target: t1, formula: '盘点对象 . 甲 + 盘点对象.乙 * 2' }]);
    const two = await legacyRule(w, [{ target: t2, formula: 'IF(盘点对象.甲 > 1, 1, 0)' }]);

    const report = await w.runRebind();
    expect(report).toEqual({ rules: 2, bound: 2, unresolved: [] });

    const first = await rawItemOf(w, one.itemOf(t1));
    expect(first).toEqual({
      formula: `${fieldHandle(a.id)} + ${fieldHandle(b.id)} * 2`,
      formula_binding: 'bound',
      binding_issue: null,
    });
    expect((await refsFor(w, one.itemOf(t1))).map((ref) => ref.field_id).sort()).toEqual([a.id, b.id].sort());
    expect((await refsFor(w, one.itemOf(t1))).every((ref) => ref.kind === 'bound')).toBe(true);

    // 规则 revision 不变（渲染后的公式与改绑前逐字相同，客户端手里的 revision 继续有效）
    for (const created of [one.rule, two.rule]) {
      const read = await w.readOn(created.id);
      expect(read.body.revision).toBe(created.revision);
    }
    const view = (await w.readOn(one.rule.id)).body;
    expect(view.items[0]).toMatchObject({
      formula: '盘点对象.甲 + 盘点对象.乙 * 2',
      formulaBindings: [a.id, b.id],
    });

    expect((await renameField(w, a, '甲新名')).status).toBe(200);
    expect((await w.readOn(one.rule.id)).body.items[0]!.formula).toBe('盘点对象.甲新名 + 盘点对象.乙 * 2');
  });

  it('每条有变化的规则写一条 rebind 审计（同事务）；平台审计另留汇总；重复执行无写入、无新审计', async () => {
    const w = await world('f082-r18b');
    const [target, source] = [await w.numberField(), await w.field('number', { name: '审计源' })];
    const { rule } = await legacyRule(w, [{ target, formula: '盘点对象.审计源 + 1' }]);

    expect(await w.runRebind()).toMatchObject({ rules: 1, bound: 1 });
    expect(await auditCount(w, REBIND_ACTION, rule.id)).toBe(1);

    const again = await w.runRebind();
    expect(again).toEqual({ rules: 0, bound: 0, unresolved: [] });
    expect(await auditCount(w, REBIND_ACTION, rule.id)).toBe(1);
    expect((await w.readOn(rule.id)).body.revision).toBe(rule.revision);
    expect((await w.readOn(rule.id)).body.items[0]!.formulaBindings).toEqual([source.id]);
  });

  it('同一命令 ID 重放：返回首次结果，不再执行；同命令 ID 异内容 → 409', async () => {
    const w = await world('f082-r18c');
    const [target] = [await w.numberField(), await w.field('number', { name: '重放源' })];
    await legacyRule(w, [{ target, formula: '盘点对象.重放源 + 1' }]);
    const key = randomUUID();
    const first = await w.rebind({}, key);
    expect(first.status).toBe(200);
    const body = await first.json();
    const replay = await w.rebind({}, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(body);
    expect((await w.rebind({ retryUnresolved: true }, key)).status).toBe(409);
  });

  it('bound 行不读不写：已经是 bound 的项目（含新保存的）原样不动', async () => {
    const w = await world('f082-r18d');
    const [bt, lt, source] = [
      await w.numberField(),
      await w.numberField(),
      await w.field('number', { name: '混合源' }),
    ];
    const created = await w.requestOn('POST', '/calc-rules', {
      ifMatch: 0,
      body: calcBody([calcItem(bt, '盘点对象.混合源 + 1')], { fieldCatalogVersion: await catalogVersion(w.db, w) }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const boundRule = (await created.json()) as { id: string };
    await legacyRule(w, [{ target: lt, formula: '盘点对象.混合源 + 2' }]);

    const report = await w.runRebind();
    expect(report).toEqual({ rules: 1, bound: 1, unresolved: [] });
    expect(await auditCount(w, REBIND_ACTION, boundRule.id)).toBe(0);
    expect((await w.readOn(boundRule.id)).body.items[0]!.formulaBindings).toEqual([source.id]);
  });
});

describe('AC-18 改绑：盘点方案（DEC-376③，P2-5）', () => {
  it('存量 盘点对象.盘点方案 有唯一同名自定义字段 → 绑定该字段，不改指项目上下文', async () => {
    const w = await world('f082-r18p1');
    const [target, custom] = [await w.numberField(), await w.field('text', { name: '盘点方案', group: 'evaluation' })];
    const { rule, itemOf } = await legacyRule(w, [{ target, formula: 'IF(盘点对象.盘点方案 = "x", 1, 0)' }]);
    expect(await w.runRebind()).toMatchObject({ bound: 1, unresolved: [] });
    expect((await rawItemOf(w, itemOf(target))).formula).toBe(`IF(${fieldHandle(custom.id)} = "x", 1, 0)`);
    expect((await w.readOn(rule.id)).body.items[0]!.formulaBindings).toEqual([custom.id]);
  });

  it('没有同名自定义字段 → 项目上下文（规范文本保留固定路径，绑定为 "context"）', async () => {
    const w = await world('f082-r18p2');
    const target = await w.numberField();
    const { rule, itemOf } = await legacyRule(w, [{ target, formula: 'IF(盘点对象.盘点方案 = "x", 1, 0)' }]);
    expect(await w.runRebind()).toMatchObject({ bound: 1 });
    expect((await rawItemOf(w, itemOf(target))).formula).toBe('IF(盘点对象.盘点方案 = "x", 1, 0)');
    expect((await refsFor(w, itemOf(target))).length).toBe(0);
    expect((await w.readOn(rule.id)).body.items[0]!.formulaBindings).toEqual(['context']);
  });
});

describe('AC-18 改绑：解析不了 → unresolved（原文不动，写候选，P2-5/P2-6）', () => {
  it('六种原因码；原文不动；候选按“全部同名字段”或“名称粗筛”；报告不含公式和名称', async () => {
    const w = await world('f082-r18u');
    const t: FieldRef[] = [];
    for (let index = 0; index < 7; index += 1) t.push(await w.numberField());
    const [a, dupA, dupB] = [
      await w.field('number', { name: '甲' }),
      await w.field('number', { name: '重名' }),
      await w.field('number', { name: '重名' }),
    ];
    const resA = await w.field('text', { name: '盘点方案', group: 'evaluation' });
    const resB = await w.field('text', { name: '盘点方案', group: 'evaluation' });
    const multi = await w.multiField();
    // 先用合法公式建项目，再把库里的文本改成升级前存量（B5 接口写不进去的那些）
    const { itemOf } = await legacyRule(
      w,
      t.map((target) => ({ target, formula: '1' })),
    );
    const texts = [
      '盘点对象.不存在 + 盘点对象.甲', // UNKNOWN_FIELD，候选：甲（能解析的其余引用）
      '盘点对象.重名 + 1', // AMBIGUOUS_FIELD，候选：两个重名字段
      'IF(盘点对象.盘点方案 = "x", 1, 0)', // RESERVED_PATH_CONFLICT，候选：两个盘点方案字段
      '盘点对象.甲 +', // INVALID，候选：名称粗筛命中的字段
      'IF(盘点对象.甲 = Z, 1, 0)', // BARE_WORD，候选：甲
      `Len(盘点对象.${multi.name})`, // MULTI_OPTION，候选：该多选字段
      '盘点对象.甲 + 盘点对象.甲', // 对照：能绑定
    ];
    for (const [index, text] of texts.entries()) await setFormulaText(w, itemOf(t[index]!), text);

    const report = await w.runRebind();
    const reasons = Object.fromEntries(report.unresolved.map((entry) => [entry.targetFieldId, entry.reason]));
    expect(reasons).toEqual({
      [t[0]!.id]: 'UNKNOWN_FIELD',
      [t[1]!.id]: 'AMBIGUOUS_FIELD',
      [t[2]!.id]: 'RESERVED_PATH_CONFLICT',
      [t[3]!.id]: 'INVALID',
      [t[4]!.id]: 'BARE_WORD',
      [t[5]!.id]: 'MULTI_OPTION',
    });
    expect(report).toMatchObject({ bound: 1 });
    // 报告只有 ID 与原因码：没有公式原文和字段名称
    const text = JSON.stringify(report);
    for (const secret of ['盘点对象', '重名', '甲', multi.name]) expect(text, secret).not.toContain(secret);

    for (const [index, expected] of texts.entries()) {
      if (index === 6) continue;
      const raw = await rawItemOf(w, itemOf(t[index]!));
      expect(raw.formula_binding).toBe('unresolved');
      expect(raw.formula).toBe(expected); // 原文不动
      expect(raw.binding_issue).toBe(reasons[t[index]!.id]);
    }
    const candidates = async (index: number) =>
      (await refsFor(w, itemOf(t[index]!))).map((ref) => `${ref.kind}:${ref.field_id}`).sort();
    expect(await candidates(0)).toEqual([`candidate:${a.id}`]);
    expect(await candidates(1)).toEqual([`candidate:${dupA.id}`, `candidate:${dupB.id}`].sort());
    expect(await candidates(2)).toEqual([`candidate:${resA.id}`, `candidate:${resB.id}`].sort());
    expect(await candidates(3)).toEqual([`candidate:${a.id}`]);
    expect(await candidates(4)).toEqual([`candidate:${a.id}`]);
    expect(await candidates(5)).toEqual([`candidate:${multi.id}`]);
    expect((await rawItemOf(w, itemOf(t[6]!))).formula_binding).toBe('bound');
  });

  it('读取时 unresolved 项目带“无法完整校验”提示；GET 不泄露不可见字段名', async () => {
    const w = await world('f082-r18r');
    const [target, source] = [await w.numberField(), await w.field('number', { name: '提示源' })];
    const { rule, itemOf } = await legacyRule(w, [{ target, formula: '盘点对象.提示源 + 1' }]);
    await setFormulaText(w, itemOf(target), '盘点对象.提示源 + 盘点对象.不存在');
    await w.runRebind();
    const view = (await w.readOn(rule.id)).body;
    expect(view.items[0]!.formulaBindings).toEqual([null, null]);
    expect(JSON.stringify(view.hints?.warnings)).toContain('无法完整校验');
    expect(source.id).toBeDefined();
  });
});

describe('AC-18 retryUnresolved：重试只追加候选，不删旧候选', () => {
  it('默认不处理 unresolved；retryUnresolved 重试，仍失败时旧候选全部保留；修好后变为 bound、候选换成 bound 引用', async () => {
    const w = await world('f082-r18t');
    const [target, a] = [await w.numberField(), await w.field('number', { name: '甲' })];
    const { itemOf } = await legacyRule(w, [{ target, formula: '盘点对象.甲 + 1' }]);
    await setFormulaText(w, itemOf(target), '盘点对象.甲 + 盘点对象.乙');
    expect((await w.runRebind()).unresolved).toHaveLength(1);
    expect((await refsFor(w, itemOf(target))).map((ref) => ref.field_id)).toEqual([a.id]);

    // 默认不重试
    expect(await w.runRebind()).toEqual({ rules: 0, bound: 0, unresolved: [] });

    // 甲改名后重试：公式里的 盘点对象.甲 找不到了，仍失败；旧候选（甲）保留
    expect((await renameField(w, a, '甲改')).status).toBe(200);
    const still = await w.runRebind({ retryUnresolved: true });
    expect(still.unresolved).toHaveLength(1);
    expect((await refsFor(w, itemOf(target))).map((ref) => `${ref.kind}:${ref.field_id}`)).toEqual([
      `candidate:${a.id}`,
    ]);

    // 补上字段“乙”并把甲改回去：重试成功，变为 bound，候选换成 bound 引用
    const b = await w.field('number', { name: '乙' });
    expect((await renameField(w, a, '甲')).status).toBe(200);
    const fixed = await w.runRebind({ retryUnresolved: true });
    expect(fixed).toMatchObject({ bound: 1, unresolved: [] });
    const raw = await rawItemOf(w, itemOf(target));
    expect(raw).toMatchObject({ formula_binding: 'bound', binding_issue: null });
    expect((await refsFor(w, itemOf(target))).map((ref) => `${ref.kind}:${ref.field_id}`).sort()).toEqual(
      [`bound:${a.id}`, `bound:${b.id}`].sort(),
    );
  });
});

describe('AC-18 身份与路由', () => {
  it('只认平台运营身份：租户成员调用 → 403；未登录 → 401', async () => {
    const w = await world('f082-r18i');
    const path = `/api/platform/tenants/${w.tenantId}/talent-review/calc-formulas/rebind`;
    const asMember = await w.on.request('POST', path, { user: w.as.user, body: {}, idempotencyKey: randomUUID() });
    expect(asMember.status).toBe(403);
    expect((await errorOf(asMember)).code).toBe('FORBIDDEN');
    const anonymous = await w.on.request('POST', path, { body: {}, idempotencyKey: randomUUID() });
    expect(anonymous.status).toBe(401);
  });

  it('租户 ID 不合法 → 404；缺 Idempotency-Key → 400；请求体多余字段 → 400', async () => {
    const w = await world('f082-r18v');
    const base = '/api/platform/tenants';
    const call = (tenant: string, options: Parameters<typeof w.on.request>[2]) =>
      w.on.request('POST', `${base}/${tenant}/talent-review/calc-formulas/rebind`, { user: w.operator.id, ...options });
    expect((await call('not-a-uuid', { body: {}, idempotencyKey: randomUUID() })).status).toBe(404);
    expect((await call(w.tenantId, { body: {}, idempotencyKey: '' })).status).toBe(400);
    expect((await call(w.tenantId, { body: { extra: 1 }, idempotencyKey: randomUUID() })).status).toBe(400);
  });

  it('被引用的字段由候选 / bound 引用保护，改绑后删除仍 409（对照 AC-06）', async () => {
    const w = await world('f082-r18g');
    const [target, source] = [await w.numberField(), await w.field('number', { name: '守卫源' })];
    await legacyRule(w, [{ target, formula: '盘点对象.守卫源 + 1' }]);
    await w.runRebind();
    const removal = await deleteField(w, source);
    expect(removal.status).toBe(409);
    expect((await errorOf(removal)).details['reason']).toBe('FIELD_IN_USE');
  });
});
