/**
 * F-082 AC-19（unresolved 保护，P2-6）、AC-19a（解析失败后改名，R2-P2-2，改绑部分）、AC-20（修复 unresolved）——F082-5：
 * - 候选引用让 unresolved 项目引用的字段在改名前后都删不掉（409 FIELD_IN_USE），legacy 清零后保护依旧；
 * - 整段解析失败的公式由名称粗筛候选保护；误候选在公式修复为 bound / 项目被删除后清除，字段可删；
 * - 用户重新保存修复：变为 bound，候选换成 bound 引用；候选里的停用字段算“保留”，非候选的停用字段 → 400。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { calcItem, catalogVersion, deleteField, errorOf, renameField } from './AC-TR-F082-support.js';
import {
  legacyRule,
  rawItemOf,
  type RebindWorld,
  rebindWorld,
  refsFor,
  setFormulaText,
} from './AC-TR-F082-rebind-support.js';

const testDb = useTestDb();
const world = (label: string): Promise<RebindWorld> => rebindWorld(testDb().db, label);

async function expectInUse(w: RebindWorld, field: { id: string; name: string }) {
  const removal = await deleteField(w, field);
  expect(removal.status, await removal.clone().text()).toBe(409);
  expect((await errorOf(removal)).details['reason']).toBe('FIELD_IN_USE');
}

describe('AC-19 unresolved 保护', () => {
  it('歧义的 unresolved 项目：两个候选字段删除都 409；其中一个改名后再删除仍 409；legacy 清零后保护依旧', async () => {
    const w = await world('f082-r19a');
    const [target, one, two] = [
      await w.numberField(),
      await w.field('number', { name: '歧义' }),
      await w.field('number', { name: '歧义' }),
    ];
    const { itemOf } = await legacyRule(w, [{ target, formula: '1' }]);
    await setFormulaText(w, itemOf(target), '盘点对象.歧义 + 1');
    expect((await w.runRebind()).unresolved).toHaveLength(1);
    expect((await rawItemOf(w, itemOf(target))).formula_binding).toBe('unresolved');

    await expectInUse(w, one);
    await expectInUse(w, two);
    expect((await renameField(w, one, '歧义改名')).status).toBe(200);
    await expectInUse(w, one); // 候选引用按 ID 保护，改名消除不了
    await expectInUse(w, two);
  });
});

describe('AC-19a 解析失败后改名（改绑部分）', () => {
  it('盘点对象.A + 改绑为 unresolved/INVALID：A 由粗筛候选保护；改名成功；删除仍 409；重试仍失败时候选保留', async () => {
    const w = await world('f082-r19b');
    const [target, a] = [await w.numberField(), await w.field('number', { name: '甲' })];
    const { itemOf } = await legacyRule(w, [{ target, formula: '1' }]);
    await setFormulaText(w, itemOf(target), '盘点对象.甲 +');
    const report = await w.runRebind();
    expect(report.unresolved).toEqual([{ ruleId: expect.any(String), targetFieldId: target.id, reason: 'INVALID' }]);
    expect(await refsFor(w, itemOf(target))).toEqual([{ field_id: a.id, kind: 'candidate' }]);

    expect((await renameField(w, a, '乙')).status).toBe(200);
    await expectInUse(w, a);
    // 重试仍失败：原有候选全部保留
    await w.runRebind({ retryUnresolved: true });
    expect((await refsFor(w, itemOf(target))).map((ref) => ref.field_id)).toContain(a.id);
    await expectInUse(w, a);
  });

  it('负向：粗筛误把无关字段记为候选；公式修复为 bound 后该字段可删；删除项目后候选也随之清除', async () => {
    const w = await world('f082-r19c');
    const [target, other] = [await w.numberField(), await w.numberField()];
    const [short, long] = [await w.field('number', { name: 'A' }), await w.field('number', { name: 'AB' })];
    const { rule, itemOf } = await legacyRule(w, [
      { target, formula: '1' },
      { target: other, formula: '2' },
    ]);
    // 整段解析失败：名称“A”是公式文本的子串，粗筛把它也记成了候选（宁可多保护）
    await setFormulaText(w, itemOf(target), '盘点对象.AB +');
    await w.runRebind();
    expect((await refsFor(w, itemOf(target))).map((ref) => ref.field_id).sort()).toEqual([short.id, long.id].sort());
    await expectInUse(w, short);

    // 用户把公式修复为 bound：候选被 bound 引用替换，误候选 A 不再被保护
    const fixed = await w.requestOn('PATCH', `/calc-rules/${rule.id}`, {
      ifMatch: rule.revision,
      body: {
        items: [calcItem(target, '盘点对象.AB + 1'), calcItem(other, '2')],
        fieldCatalogVersion: await catalogVersion(w.db, w),
      },
    });
    expect(fixed.status, await fixed.clone().text()).toBe(200);
    expect(await refsFor(w, itemOf(target))).toEqual([{ field_id: long.id, kind: 'bound' }]);
    expect((await deleteField(w, short)).status).toBe(200);
    await expectInUse(w, long);

    // 删除项目（整条规则）后，其全部候选随之清除：原候选字段可以删除
    const [t2, f2] = [await w.numberField(), await w.field('number', { name: '丙' })];
    const second = await legacyRule(w, [{ target: t2, formula: '1' }]);
    await setFormulaText(w, second.itemOf(t2), '盘点对象.丙 +');
    await w.runRebind();
    await expectInUse(w, f2);
    const removed = await w.request('DELETE', `/calc-rules/${second.rule.id}`, { ifMatch: second.rule.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect((await deleteField(w, f2)).status).toBe(200);
  });
});

describe('AC-20 修复 unresolved', () => {
  it('重新保存成功 → bound，候选换成 bound 引用；候选里的停用字段算“保留”，非候选的停用字段 → 400', async () => {
    const w = await world('f082-r20');
    const [t1, t2] = [await w.numberField(), await w.numberField()];
    const [a, b, c] = [
      await w.field('number', { name: '甲' }),
      await w.field('number', { name: '乙' }),
      await w.field('number', { name: '丙' }),
    ];
    const first = await legacyRule(w, [{ target: t1, formula: '1' }]);
    const second = await legacyRule(w, [{ target: t2, formula: '1' }]);
    await setFormulaText(w, first.itemOf(t1), '盘点对象.甲 + 盘点对象.乙 +');
    await setFormulaText(w, second.itemOf(t2), '盘点对象.乙 +');
    await w.runRebind();
    // 停用 甲（第一条的候选）、丙（谁的候选都不是）
    for (const field of [a, c]) {
      const read = await w.request('GET', `/fields/${field.id}`);
      const { revision } = (await read.json()) as { revision: number };
      const off = await w.request('PATCH', `/fields/${field.id}`, { ifMatch: revision, body: { enabled: false } });
      expect(off.status, await off.clone().text()).toBe(200);
    }

    const patch = async (rule: typeof first.rule, target: typeof t1, formula: string) =>
      w.requestOn('PATCH', `/calc-rules/${rule.id}`, {
        ifMatch: rule.revision,
        body: { items: [calcItem(target, formula)], fieldCatalogVersion: await catalogVersion(w.db, w) },
      });

    // 引用候选里的停用字段（甲）：算保留，保存成功
    const ok = await patch(first.rule, t1, '盘点对象.甲 + 盘点对象.乙');
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await rawItemOf(w, first.itemOf(t1))).toMatchObject({ formula_binding: 'bound', binding_issue: null });
    expect((await refsFor(w, first.itemOf(t1))).map((ref) => `${ref.kind}:${ref.field_id}`).sort()).toEqual(
      [`bound:${a.id}`, `bound:${b.id}`].sort(),
    );

    // 引用非候选的停用字段（丙）：400 CALC_FORMULA_FIELD_DISABLED
    const rejected = await patch(second.rule, t2, '盘点对象.乙 + 盘点对象.丙');
    expect(rejected.status).toBe(400);
    expect((await errorOf(rejected)).details['reason']).toBe('CALC_FORMULA_FIELD_DISABLED');
    expect(c.id).toBeDefined();
  });
});
