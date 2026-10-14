/**
 * #327 第 2 轮（#89-4 × F-082 AC-18 改绑 / AC-06 删除守卫）：带连字符的字段名。
 * - P2-1：存量改绑保留历史解释（DEC-228：成员位置连字符并入字段名），与当前字段目录的解释不一致时进入 unresolved，
 *   原字段的候选引用保留，删除仍 409；
 * - P2-2：删除守卫的文本兜底只认实际解释（已存在字段优先），没被引用的字段可以删。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { deleteField, errorOf, renameField } from './AC-TR-F082-support.js';
import { legacyRule, rawItemOf, rebindWorld, refsFor, type RebindWorld } from './AC-TR-F082-rebind-support.js';

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
