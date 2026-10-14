/**
 * F-082 AC-08 / 19a / 26（改名守卫与版本接线，F082-2；契约 §3.1、§1.3、DEC-376②⑤⑥）：
 * - 改名对每个引用它的 bound 公式做完整往返校验，失败 409 FIELD_NAME_BREAKS_FORMULA（TOO_LONG / TOO_MANY_TOKENS / NOT_PARSEABLE），
 *   什么都不写；未被引用的字段随意改名，允许改成与其他字段同名；
 * - 改名不写计算规则数据：规则 revision 不变；
 * - 改名把文本兜底命中的非 bound 公式固化成按 ID 的候选引用（含解析失败的公式），改名不能消除删除保护；
 * - 字段目录版本：新建 / 改名 / 删除推进，停用与其他修改不推进。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { pathOf } from './AC-TR-calc-rule-support.js';
import {
  calcBody,
  calcItem,
  catalogVersion,
  deleteField,
  errorOf,
  f082World,
  fieldHandle,
  fieldRevision,
  fieldView,
  itemIdOf,
  makeBound,
  refsOf,
  renameField,
  setBinding,
} from './AC-TR-F082-support.js';

const testDb = useTestDb();

async function boundRule(
  w: Awaited<ReturnType<typeof f082World>>,
  target: { id: string; name: string },
  stored: string,
  refs: string[],
) {
  const rule = await w.create(calcBody([calcItem(target, '1')]));
  const itemId = await itemIdOf(testDb().db, w, rule.id, target.id);
  await makeBound(testDb().db, w, itemId, stored, refs);
  return { rule, itemId };
}

describe('AC-08 改名往返校验（bound 公式）', () => {
  it('普通改名成功：规则 revision 不变（改名不写计算规则），版本推进', async () => {
    const w = await f082World(testDb().db, 'f082-r1');
    const [target, source] = [await w.numberField(), await w.field('number', { name: '甲' })];
    const { rule } = await boundRule(w, target, `${fieldHandle(source.id)} + 1`, [source.id]);
    const before = await catalogVersion(testDb().db, w);
    const response = await renameField(w, source, '乙乙');
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await w.read(rule.id)).body.revision).toBe(rule.revision);
    expect(await catalogVersion(testDb().db, w)).toBeGreaterThan(before);
  });

  it('渲染后超 4000 字 → 409 TOO_LONG，字段名、revision、版本都不变', async () => {
    const w = await f082World(testDb().db, 'f082-r2');
    const [target, source] = [await w.numberField(), await w.field('number', { name: '甲' })];
    const { rule } = await boundRule(w, target, `${fieldHandle(source.id)} + "${'x'.repeat(3970)}"`, [source.id]);
    const [revision, version] = [await fieldRevision(w, source.id), await catalogVersion(testDb().db, w)];
    const response = await renameField(w, source, '名'.repeat(45));
    const error = await errorOf(response);
    expect([response.status, error.code, error.details['reason']]).toEqual([
      409,
      'CONFLICT',
      'FIELD_NAME_BREAKS_FORMULA',
    ]);
    expect(error.details['affected']).toEqual([{ ruleId: rule.id, targetFieldId: target.id, reason: 'TOO_LONG' }]);
    expect(error.details['others']).toBe(0);
    const after = await fieldView(w, source.id);
    expect([after.name, after.revision, await catalogVersion(testDb().db, w)]).toEqual([
      source.name,
      revision,
      version,
    ]);
  });

  it('200 处引用改成 A.B 使词数超 800 → TOO_MANY_TOKENS；改成关键字 → NOT_PARSEABLE', async () => {
    const w = await f082World(testDb().db, 'f082-r3');
    const [target, source] = [await w.numberField(), await w.field('number', { name: 'X' })];
    const stored = Array.from({ length: 200 }, () => fieldHandle(source.id)).join(' + ');
    await boundRule(w, target, stored, [source.id]);
    for (const [name, reason] of [
      ['A.B', 'TOO_MANY_TOKENS'],
      ['如果', 'NOT_PARSEABLE'],
    ] as const) {
      const response = await renameField(w, source, name);
      const error = await errorOf(response);
      expect([response.status, error.details['reason']]).toEqual([409, 'FIELD_NAME_BREAKS_FORMULA']);
      expect((error.details['affected'] as { reason: string }[])[0]!.reason, name).toBe(reason);
    }
    expect((await fieldView(w, source.id)).name).toBe('X');
  });

  it('未被 bound 公式引用的字段可以随意改名（含关键字、含“.”）；允许改成与其他字段同名', async () => {
    const w = await f082World(testDb().db, 'f082-r4');
    const [free, other] = [await w.numberField(), await w.field('number', { name: '重名目标' })];
    for (const name of ['如果', 'A.B', other.name]) {
      const response = await renameField(w, free, name);
      expect(response.status, name).toBe(200);
    }
  });

  it('改成与被引用字段同名：公式回显 B+B 仍可原样重提，不拒绝', async () => {
    const w = await f082World(testDb().db, 'f082-r5');
    const [target, a, b] = [
      await w.numberField(),
      await w.field('number', { name: 'A' }),
      await w.field('number', { name: 'B' }),
    ];
    await boundRule(w, target, `${fieldHandle(a.id)} + ${fieldHandle(b.id)}`, [a.id, b.id]);
    expect((await renameField(w, a, 'B')).status).toBe(200);
  });
});

describe('AC-19a 改名固化文本兜底（候选引用，只增不减）', () => {
  it('legacy 公式引用 A：A 改名成功并写入 (项目, A, candidate)；改名后删除仍 409', async () => {
    const w = await f082World(testDb().db, 'f082-c1');
    const [target, a] = [await w.numberField(), await w.numberField()];
    const rule = await w.create(calcBody([calcItem(target, `${pathOf(a)} + 1`)]));
    const itemId = await itemIdOf(testDb().db, w, rule.id, target.id);
    expect((await renameField(w, a, '改名后的A')).status).toBe(200);
    expect(await refsOf(testDb().db, w, itemId)).toEqual([{ item_id: itemId, field_id: a.id, kind: 'candidate' }]);
    const blocked = await deleteField(w, a);
    expect([blocked.status, (await errorOf(blocked)).details['reason']]).toEqual([409, 'FIELD_IN_USE']);
    // 重复改名不重复写（已有则跳过）
    expect((await renameField(w, a, '再次改名')).status).toBe(200);
    expect(await refsOf(testDb().db, w, itemId)).toHaveLength(1);
  });

  it('R1-P2-1：含点号的字段名 + 空白写法引用：改名固化为候选引用，随后删除仍 409', async () => {
    const w = await f082World(testDb().db, 'f082-c-dot');
    const [target, a] = [await w.numberField(), await w.field('number', { name: '甲.乙.丙' })];
    const rule = await w.create(calcBody([calcItem(target, '盘点对象 . 甲 .\n乙\t. 丙 + 1')]));
    const itemId = await itemIdOf(testDb().db, w, rule.id, target.id);
    expect((await renameField(w, a, '新名字')).status).toBe(200);
    expect(await refsOf(testDb().db, w, itemId)).toEqual([{ item_id: itemId, field_id: a.id, kind: 'candidate' }]);
    const blocked = await deleteField(w, a);
    expect([blocked.status, (await errorOf(blocked)).details['reason']]).toEqual([409, 'FIELD_IN_USE']);
  });

  it('解析失败的存量公式 `盘点对象.A +`：A 由粗筛认定，改名后同样固化，删除 409', async () => {
    const w = await f082World(testDb().db, 'f082-c2');
    const [target, a] = [await w.numberField(), await w.field('number', { name: '甲A' })];
    const rule = await w.create(calcBody([calcItem(target, '1')]));
    const itemId = await itemIdOf(testDb().db, w, rule.id, target.id);
    await setBinding(testDb().db, w, itemId, 'unresolved', 'INVALID');
    const { withTenant, sql } = await import('@italent/db');
    await withTenant(testDb().db, w.as.tenant, (tx) =>
      tx.execute(
        sql`UPDATE talent_review_calc_rule_items SET formula = ${`盘点对象.${a.name} +`} WHERE id = ${itemId}`,
      ),
    );
    expect((await renameField(w, a, '乙B')).status).toBe(200);
    expect((await refsOf(testDb().db, w, itemId)).map((row) => [row.field_id, row.kind])).toEqual([
      [a.id, 'candidate'],
    ]);
    expect((await deleteField(w, a)).status).toBe(409);
  });

  it('粗筛误中无关字段（名称是解析失败公式文本的子串）也写候选——宁可多保护；未被引用的字段不写', async () => {
    const w = await f082World(testDb().db, 'f082-c3');
    const [target, sub, free] = [
      await w.numberField(),
      await w.field('number', { name: '绩效' }),
      await w.numberField(),
    ];
    const rule = await w.create(calcBody([calcItem(target, '1')]));
    const itemId = await itemIdOf(testDb().db, w, rule.id, target.id);
    const { withTenant, sql } = await import('@italent/db');
    await withTenant(testDb().db, w.as.tenant, (tx) =>
      tx.execute(sql`UPDATE talent_review_calc_rule_items SET formula = '盘点对象.绩效得分 +', formula_binding = 'unresolved'
        WHERE id = ${itemId}`),
    );
    expect((await renameField(w, sub, '别的名字')).status).toBe(200);
    expect((await renameField(w, free, '还是别的')).status).toBe(200);
    expect((await refsOf(testDb().db, w, itemId)).map((row) => row.field_id)).toEqual([sub.id]);
  });
});

describe('AC-26 字段目录版本接线', () => {
  it('新建（含成对伙伴）、改名、删除各推进版本；停用和其他修改不推进', async () => {
    const w = await f082World(testDb().db, 'f082-v1');
    const versions = [await catalogVersion(testDb().db, w)];
    const note = async () => versions.push(await catalogVersion(testDb().db, w));
    const first = await w.numberField();
    await note();
    const before = await w.field('number', { name: '伙伴前', pairRole: 'before' });
    await note();
    const after = await w.field('number', { name: '伙伴后', pairRole: 'after', pairFieldId: before.id });
    await note();
    expect((await renameField(w, first, '新名称')).status).toBe(200);
    await note();
    expect((await deleteField(w, first)).status).toBe(200);
    await note();
    expect(versions.slice(1).every((value, index) => value > versions[index]!)).toBe(true);
    const frozen = versions.at(-1);
    // 停用、改排序 / 改名为同名都不推进
    const off = await w.request('PATCH', `/fields/${after.id}`, {
      ifMatch: await fieldRevision(w, after.id),
      body: { enabled: false },
    });
    expect(off.status).toBe(200);
    const sort = await w.request('PATCH', `/fields/${before.id}`, {
      ifMatch: await fieldRevision(w, before.id),
      body: { sortNo: 7 },
    });
    expect(sort.status).toBe(200);
    expect(await catalogVersion(testDb().db, w)).toBe(frozen);
  });
});
