/**
 * F-082 AC-06（删除守卫，F082-2 部分；契约 §3.2、DEC-376⑥）：
 * 目标字段、引用表（bound / candidate 都算）、非 bound 公式的文本兜底（长期保留，解析失败宁可多保护）任一命中 → 409
 * FIELD_IN_USE（referrer CALC_RULE）；库外键 restrict 兜底。保护类改动不挂开关，合入即生效。
 */
import { sql, withTenant } from '@italent/db';
import { pgErrorCode, useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { pathOf } from './AC-TR-calc-rule-support.js';
import {
  calcBody,
  calcItem,
  deleteField,
  errorOf,
  f082World,
  fieldHandle,
  itemIdOf,
  makeBound,
  setBinding,
} from './AC-TR-F082-support.js';

const testDb = useTestDb();

describe('AC-06 删除守卫：文本兜底（非 bound 公式，B5 数据）', () => {
  it('被公式引用（含空白 / 换行写法）的字段删除 → 409 FIELD_IN_USE；移除引用后可删', async () => {
    const w = await f082World(testDb().db, 'f082-g1');
    const [target, source] = [await w.numberField(), await w.numberField()];
    const rule = await w.create(calcBody([calcItem(target, `盘点对象 .\n ${source.name} + 1`)]));
    const blocked = await deleteField(w, source);
    const error = await errorOf(blocked);
    expect([blocked.status, error.code, error.details['reason'], error.details['referrer']]).toEqual([
      409,
      'CONFLICT',
      'FIELD_IN_USE',
      'CALC_RULE',
    ]);
    const edit = await w.request('PATCH', `/calc-rules/${rule.id}`, {
      ifMatch: 1,
      body: { items: [calcItem(target, '1')] },
    });
    expect(edit.status).toBe(200);
    expect((await deleteField(w, source)).status).toBe(200);
  });

  it('字段名是其他字段名的前缀 / 子串时不误判；字符串里的名称不算引用', async () => {
    const w = await f082World(testDb().db, 'f082-g2');
    const [target, longer] = [await w.numberField(), await w.field('number', { name: '绩效得分扩展' })];
    const shorter = await w.field('number', { name: '绩效得分' });
    await w.create(calcBody([calcItem(target, `${pathOf(longer)} + Len("${pathOf(shorter)}")`)]));
    expect((await deleteField(w, shorter)).status).toBe(200);
    expect((await deleteField(w, longer)).status).toBe(409);
  });

  it('解析失败的非 bound 公式：文本粗筛命中字段名就算引用（宁可多保护）', async () => {
    const w = await f082World(testDb().db, 'f082-g3');
    const [target, source] = [await w.numberField(), await w.numberField()];
    const rule = await w.create(calcBody([calcItem(target, '1')]));
    const itemId = await itemIdOf(testDb().db, w, rule.id, target.id);
    const broken = `${pathOf(source)} +`;
    await withTenant(testDb().db, w.as.tenant, (tx) =>
      tx.execute(sql`UPDATE talent_review_calc_rule_items
        SET formula = ${broken}, formula_binding = 'unresolved', binding_issue = 'INVALID' WHERE id = ${itemId}`),
    );
    const blocked = await deleteField(w, source);
    expect([blocked.status, (await errorOf(blocked)).details['reason']]).toEqual([409, 'FIELD_IN_USE']);
  });

  it('作为计算项目的目标字段仍不能删', async () => {
    const w = await f082World(testDb().db, 'f082-g4');
    const target = await w.numberField();
    await w.create(calcBody([calcItem(target, '1')]));
    expect((await deleteField(w, target)).status).toBe(409);
  });
});

describe('AC-06 删除守卫：引用表（bound / candidate）与库外键', () => {
  it('bound 引用命中 → 409；文本兜底不作用于 bound 行（句柄文本不含名称）', async () => {
    const w = await f082World(testDb().db, 'f082-g5');
    const [target, source, other] = [await w.numberField(), await w.numberField(), await w.numberField()];
    const rule = await w.create(calcBody([calcItem(target, '1')]));
    const itemId = await itemIdOf(testDb().db, w, rule.id, target.id);
    await makeBound(testDb().db, w, itemId, `${fieldHandle(source.id)} + 1`, [source.id]);
    const blocked = await deleteField(w, source);
    expect([blocked.status, (await errorOf(blocked)).details['reason']]).toEqual([409, 'FIELD_IN_USE']);
    // 无关字段不受影响
    expect((await deleteField(w, other)).status).toBe(200);
    // 直接对库删除被外键拒绝（restrict）
    const direct = await withTenant(testDb().db, w.as.tenant, (tx) =>
      tx.execute(sql`DELETE FROM talent_review_fields WHERE id = ${source.id}`),
    ).catch((e: unknown) => e);
    expect(['23001', '23503']).toContain(pgErrorCode(direct));
  });

  it('candidate 引用命中 → 409，legacy = 0（没有任何非 bound 公式）后保护依旧', async () => {
    const w = await f082World(testDb().db, 'f082-g6');
    const [target, ghost] = [await w.numberField(), await w.numberField()];
    const rule = await w.create(calcBody([calcItem(target, '1')]));
    const itemId = await itemIdOf(testDb().db, w, rule.id, target.id);
    // 改绑认定的候选：公式文本里已经没有 ghost 的名称，也没有 legacy 行了
    await makeBound(testDb().db, w, itemId, '1', []);
    await setBinding(testDb().db, w, itemId, 'unresolved', 'AMBIGUOUS_FIELD');
    await withTenant(testDb().db, w.as.tenant, (tx) =>
      tx.execute(sql`INSERT INTO talent_review_calc_item_refs (tenant_id, item_id, field_id, kind)
        VALUES (${w.as.tenant}, ${itemId}, ${ghost.id}, 'candidate')`),
    );
    const blocked = await deleteField(w, ghost);
    expect([blocked.status, (await errorOf(blocked)).details['reason']]).toEqual([409, 'FIELD_IN_USE']);
  });

  it('删除整条规则（项目与引用级联清除）后原被引用字段可以删除', async () => {
    const w = await f082World(testDb().db, 'f082-g7');
    const [target, source] = [await w.numberField(), await w.numberField()];
    const rule = await w.create(calcBody([calcItem(target, '1')]));
    const itemId = await itemIdOf(testDb().db, w, rule.id, target.id);
    await makeBound(testDb().db, w, itemId, fieldHandle(source.id), [source.id]);
    expect((await deleteField(w, source)).status).toBe(409);
    const removed = await w.request('DELETE', `/calc-rules/${rule.id}`, { ifMatch: 1 });
    expect(removed.status).toBe(200);
    expect((await deleteField(w, source)).status).toBe(200);
  });
});
