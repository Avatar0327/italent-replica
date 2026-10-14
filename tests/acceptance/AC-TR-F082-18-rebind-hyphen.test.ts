/**
 * #327 第 3 轮（DEC-485）：存量 legacy 名称文本的历史解释走冻结的旧词法（AC-EXP-21 是它与 5aa1d1ad 的差分）：
 * - P2-1：字段 a、a-1.5 并存，存量公式 `盘点对象.a-1.5` 旧词法读成整段字段 a-1.5，不能被改绑成 a 减 1.5（原字段保护保留）；
 * - P2-2：字段 `a-b.c-d`，存量公式 `盘点对象.a-b.c-d` 的删除保护不能漏。
 * 存量文本用 setFormulaText 写库，模拟升级前 B5 存下的公式（新规则下的保存接口不一定写得进去）。
 *
 * #327 第 2 轮（#89-4 × F-082 AC-18 改绑 / AC-06 删除守卫）：带连字符的字段名。
 * - P2-1：存量改绑保留历史解释（DEC-228：成员位置连字符并入字段名），与当前字段目录的解释不一致时进入 unresolved，
 *   原字段的候选引用保留，删除仍 409；
 * - P2-2：删除守卫的文本兜底只认实际解释（已存在字段优先），没被引用的字段可以删。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { deleteField, errorOf, renameField } from './AC-TR-F082-support.js';
import {
  legacyRule,
  rawItemOf,
  rebindWorld,
  refsFor,
  setFormulaText,
  type RebindWorld,
} from './AC-TR-F082-rebind-support.js';

const testDb = useTestDb();

async function world(label: string): Promise<RebindWorld> {
  return rebindWorld(testDb().db, label);
}

describe('#89-4 存量改绑保留历史解释（第 2 轮 P2-1）', () => {
  it('a=10、a-b 引用的公式；a-b 改名为 z 后改绑 → unresolved、原文不动、不改绑到 a；删除原字段仍 409', async () => {
    const w = await world('r3e-rebind-hyphen');
    const target = await w.numberField();
    const a = await w.field('number', { name: 'a' });
    const ab = await w.field('number', { name: 'a-b' });
    const formula = 'Def(a,10); Def(b,3); 盘点对象.a-b';
    const { itemOf } = await legacyRule(w, [{ target, formula }]);

    expect((await renameField(w, ab, 'z')).status).toBe(200);
    const report = await w.runRebind();
    expect(report.bound).toBe(0);
    expect(report.unresolved).toEqual([expect.objectContaining({ targetFieldId: target.id })]);

    expect(await rawItemOf(w, itemOf(target))).toMatchObject({ formula, formula_binding: 'unresolved' });
    const refs = await refsFor(w, itemOf(target));
    expect(refs.filter((ref) => ref.kind === 'bound')).toEqual([]);
    expect(refs.map((ref) => ref.field_id)).toContain(ab.id);

    const removal = await deleteField(w, ab);
    expect(removal.status).toBe(409);
    expect((await errorOf(removal)).details['reason']).toBe('FIELD_IN_USE');
    expect(a.id).not.toBe(ab.id);
  });
});

describe('#89-4 删除守卫只认实际解释（第 2 轮 P2-2）', () => {
  it('字段 a、a-b 同时存在，legacy 公式 `Def(b,3); 盘点对象.a-b` 只引用 a-b：删除 a → 200，删除 a-b → 409', async () => {
    const w = await world('r3e-guard-hyphen');
    const target = await w.numberField();
    const a = await w.field('number', { name: 'a' });
    const ab = await w.field('number', { name: 'a-b' });
    await legacyRule(w, [{ target, formula: 'Def(b,3); 盘点对象.a-b' }]);

    const blocked = await deleteField(w, ab);
    expect(blocked.status).toBe(409);
    expect((await deleteField(w, a)).status).toBe(200);
  });
});

describe('#89-4 历史解释走旧词法（第 3 轮 P2-1）：小数写法 a-1.5', () => {
  it('a=10、a-1.5=99，存量公式 `盘点对象.a-1.5`：改绑不绑定到 a（unresolved、原文不动），删除 a-1.5 → 409，删除 a → 200', async () => {
    const w = await world('r3-decimal-kept');
    const target = await w.numberField();
    const a = await w.field('number', { name: 'a' });
    const decimal = await w.field('number', { name: 'a-1.5' });
    const formula = '盘点对象.a-1.5';
    const { itemOf } = await legacyRule(w, [{ target, formula: '盘点对象.a' }]);
    await setFormulaText(w, itemOf(target), formula);

    const report = await w.runRebind();
    expect(report.bound).toBe(0);
    expect(report.unresolved).toEqual([expect.objectContaining({ targetFieldId: target.id })]);
    expect(await rawItemOf(w, itemOf(target))).toMatchObject({ formula, formula_binding: 'unresolved' });
    const refs = await refsFor(w, itemOf(target));
    expect(refs.filter((ref) => ref.kind === 'bound')).toEqual([]);
    expect(refs.map((ref) => ref.field_id)).toEqual([decimal.id.toLowerCase()]);

    const blocked = await deleteField(w, decimal);
    expect(blocked.status).toBe(409);
    expect((await errorOf(blocked)).details['reason']).toBe('FIELD_IN_USE');
    expect((await deleteField(w, a)).status).toBe(200);
  });

  it('a-1.5 改名为 z 后改绑：旧词法的整段 a-1.5 与当前的 a 减 1.5 不一致 → unresolved、原文不动；删除 z → 409', async () => {
    const w = await world('r3-decimal-renamed');
    const target = await w.numberField();
    await w.field('number', { name: 'a' });
    const decimal = await w.field('number', { name: 'a-1.5' });
    const formula = '盘点对象.a-1.5';
    const { itemOf } = await legacyRule(w, [{ target, formula: '盘点对象.a' }]);
    await setFormulaText(w, itemOf(target), formula);

    expect((await renameField(w, decimal, 'z')).status).toBe(200);
    const report = await w.runRebind();
    expect(report.bound).toBe(0);
    expect(report.unresolved).toEqual([expect.objectContaining({ targetFieldId: target.id })]);
    expect(await rawItemOf(w, itemOf(target))).toMatchObject({ formula, formula_binding: 'unresolved' });
    const refs = await refsFor(w, itemOf(target));
    expect(refs.filter((ref) => ref.kind === 'bound')).toEqual([]);
    expect(refs.map((ref) => ref.field_id)).toContain(decimal.id.toLowerCase());

    const removal = await deleteField(w, decimal);
    expect(removal.status).toBe(409);
    expect((await errorOf(removal)).details['reason']).toBe('FIELD_IN_USE');
  });
});

describe('#89-4 删除守卫对 legacy 文本以旧词法的引用集合为准（第 3 轮 P2-2）：深路径里的多段连字符', () => {
  async function deepWorld(label: string) {
    const w = await world(label);
    const target = await w.numberField();
    const deep = await w.field('number', { name: 'a-b.c-d' });
    const { itemOf } = await legacyRule(w, [{ target, formula: '1' }]);
    await setFormulaText(w, itemOf(target), '盘点对象.a-b.c-d');
    return { w, target, deep, itemOf };
  }

  it('字段 a-b.c-d，存量公式 `盘点对象.a-b.c-d`：删除源字段 → 409 FIELD_IN_USE（开关关闭的写入路径）', async () => {
    const { w, deep } = await deepWorld('r3-deep-guard');
    const blocked = await deleteField(w, deep);
    expect(blocked.status).toBe(409);
    expect((await errorOf(blocked)).details['reason']).toBe('FIELD_IN_USE');
  });

  it('同一个存量公式，开关打开的实例上删除源字段也是 409，改名后改名固化仍认得它', async () => {
    const { w, deep, itemOf, target } = await deepWorld('r3-deep-guard-on');
    const revision = (await (await w.request('GET', `/fields/${deep.id}`)).json()) as { revision: number };
    const removal = await w.requestOn('DELETE', `/fields/${deep.id}`, { ifMatch: revision.revision });
    expect(removal.status).toBe(409);

    expect((await renameField(w, deep, 'z')).status).toBe(200);
    const report = await w.runRebind();
    expect(report.bound).toBe(0);
    expect(report.unresolved).toEqual([expect.objectContaining({ targetFieldId: target.id })]);
    const refs = await refsFor(w, itemOf(target));
    expect(refs.map((ref) => ref.field_id)).toContain(deep.id.toLowerCase());
    expect((await deleteField(w, deep)).status).toBe(409);
  });
});
