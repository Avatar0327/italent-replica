/**
 * F-082 AC-18 / AC-17 改绑审计（F082-5 第 1 轮 P2-2）：改绑写的审计快照要包含候选引用集合——
 * `refFieldIds` / `fieldNames` 的前后值完整，候选变化不能出现 before = after、`changes: []` 的空记录。
 * 覆盖：首次失败写候选、失败重试追加候选、成功改绑清除旧候选的前值；租户审计与平台逐规则副本两处都对。
 * P3：无业务变化的重跑不写平台变更汇总审计（命令台账照常记录）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { renameField } from './AC-TR-F082-support.js';
import {
  type AuditRow,
  legacyRule,
  platformRuleAudits,
  platformSummaryCount,
  type RebindWorld,
  rebindAudits,
  rebindWorld,
  setFormulaText,
} from './AC-TR-F082-rebind-support.js';

const testDb = useTestDb();
const world = (label: string): Promise<RebindWorld> => rebindWorld(testDb().db, label);

const itemOf = (audit: AuditRow, side: 'before' | 'after') => audit[side]!.items[0]!;
const ids = (item: Record<string, unknown>) => ((item['refFieldIds'] as string[] | undefined) ?? []).slice().sort();
const names = (item: Record<string, unknown>) => (item['fieldNames'] as Record<string, string> | undefined) ?? {};

/** 租户审计与平台副本两处都要满足同一组断言。 */
async function bothCopies(w: RebindWorld, ruleId: string, check: (audits: AuditRow[], where: string) => void) {
  check(await rebindAudits(w, ruleId), '租户审计');
  check(await platformRuleAudits(w, ruleId), '平台副本');
}

describe('改绑审计包含候选引用集合', () => {
  it('首次失败写候选：legacy → unresolved 的审计 after 带候选 ID 与名称，changes 非空', async () => {
    const w = await world('f082-aud1');
    const [target, a] = [await w.numberField(), await w.field('number', { name: '审计甲' })];
    const { rule, itemOf: itemId } = await legacyRule(w, [{ target, formula: '盘点对象.审计甲 + 1' }]);
    await setFormulaText(w, itemId(target), '盘点对象.审计甲 + 盘点对象.不存在');
    await w.runRebind();
    await bothCopies(w, rule.id, (audits, where) => {
      expect(audits, where).toHaveLength(1);
      const [audit] = audits as [AuditRow];
      expect(itemOf(audit, 'before')['formulaBinding'], where).toBe('legacy');
      expect(ids(itemOf(audit, 'before')), where).toEqual([]);
      expect(itemOf(audit, 'after')).toMatchObject({ formulaBinding: 'unresolved', bindingIssue: 'UNKNOWN_FIELD' });
      expect(ids(itemOf(audit, 'after')), where).toEqual([a.id]);
      expect(names(itemOf(audit, 'after')), where).toEqual({ [a.id]: '审计甲' });
    });
    expect((await rebindAudits(w, rule.id))[0]!.changes?.length).toBeGreaterThan(0);
  });

  it('失败重试追加候选：新增的候选引用在 after 里，before 保持原集合；不再出现 before = after 的空记录', async () => {
    const w = await world('f082-aud2');
    const [target, b, c] = [
      await w.numberField(),
      await w.field('number', { name: '重试乙' }),
      await w.field('number', { name: '重试丙' }),
    ];
    const { rule, itemOf: itemId } = await legacyRule(w, [{ target, formula: '盘点对象.重试乙 + 盘点对象.重试丙' }]);
    // 乙、丙改名：改名守卫把文本兜底命中的关系固化为候选；改绑 → unresolved/UNKNOWN_FIELD
    expect((await renameField(w, b, '重试乙新名')).status).toBe(200);
    expect((await renameField(w, c, '重试丙新名')).status).toBe(200);
    expect(await w.runRebind()).toMatchObject({ unresolved: [{ reason: 'UNKNOWN_FIELD' }] });
    // 新建同名“重试乙”：重试仍缺“重试丙”（unresolved），但新增“重试乙”的候选
    const fresh = await w.field('number', { name: '重试乙' });
    const retry = await w.runRebind({ retryUnresolved: true });
    expect(retry.rules).toBe(1);
    await bothCopies(w, rule.id, (audits, where) => {
      expect(audits, where).toHaveLength(2);
      const [first, second] = audits as [AuditRow, AuditRow];
      expect(ids(itemOf(first, 'after')), where).toEqual([b.id, c.id].sort());
      expect(ids(itemOf(second, 'before')), where).toEqual([b.id, c.id].sort());
      expect(ids(itemOf(second, 'after')), where).toEqual([b.id, c.id, fresh.id].sort());
      expect(JSON.stringify(second.before), where).not.toBe(JSON.stringify(second.after));
    });
    expect((await rebindAudits(w, rule.id))[1]!.changes?.length).toBeGreaterThan(0);
    expect(itemId(target)).toBeDefined();
  });

  it('成功改绑清除旧候选：before 保留候选集合，after 是 bound 引用', async () => {
    const w = await world('f082-aud3');
    const [target, a] = [await w.numberField(), await w.field('number', { name: '清除甲' })];
    const { rule, itemOf: itemId } = await legacyRule(w, [{ target, formula: '盘点对象.清除甲 + 1' }]);
    await setFormulaText(w, itemId(target), '盘点对象.清除甲 +'); // 整段解析失败：粗筛候选
    await w.runRebind();
    await setFormulaText(w, itemId(target), '盘点对象.清除甲 + 1'); // 修复后重试 → bound
    expect(await w.runRebind({ retryUnresolved: true })).toMatchObject({ bound: 1 });
    await bothCopies(w, rule.id, (audits, where) => {
      expect(audits, where).toHaveLength(2);
      const last = audits[1]!;
      expect(itemOf(last, 'before')['formulaBinding'], where).toBe('unresolved');
      expect(ids(itemOf(last, 'before')), where).toEqual([a.id]); // 旧候选
      expect(itemOf(last, 'after')['formulaBinding'], where).toBe('bound');
      expect(ids(itemOf(last, 'after')), where).toEqual([a.id]);
      expect(JSON.stringify(last.before), where).not.toBe(JSON.stringify(last.after));
    });
  });
});

describe('无业务变化的重跑不写平台变更汇总审计（P3）', () => {
  it('第二次改绑 rules = 0：平台汇总审计条数不变；命令台账照常记录（同键重放仍返回首次结果）', async () => {
    const w = await world('f082-aud4');
    const [target] = [await w.numberField(), await w.field('number', { name: '汇总源' })];
    await legacyRule(w, [{ target, formula: '盘点对象.汇总源 + 1' }]);
    await w.runRebind();
    const afterFirst = await platformSummaryCount(w);
    const again = await w.runRebind();
    expect(again).toEqual({ rules: 0, bound: 0, unresolved: [] });
    expect(await platformSummaryCount(w)).toBe(afterFirst);
  });
});
