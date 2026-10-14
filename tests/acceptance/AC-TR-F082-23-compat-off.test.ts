/**
 * F-082 AC-23（开关关闭，F082-1 第 1 轮审查 P3-2）：开关关闭时 B5 路径逐字不变——
 * 占位符词法只在 F-082 新路径生效，名为〔不可见字段〕的字段不能因此让基线拒绝的公式变成 201。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { calcBody, calcItem, calcWorld } from './AC-TR-calc-rule-support.js';

const testDb = useTestDb();
const PLACEHOLDER = '〔不可见字段〕';

interface Failure {
  error: { code: string; details: { reason: string; issues?: { code: string }[] } };
}

describe('AC-23 开关关闭：占位符词法不改变 B5 校验', () => {
  it('字段恰好叫〔不可见字段〕：引用它的公式仍是 400 语法错误，规则没有创建', async () => {
    const w = await calcWorld(testDb().db, 'f082-compat', { formulaIdBinding: false });
    const [target, odd] = [await w.numberField(), await w.field('number', { name: PLACEHOLDER })];
    expect(odd.name).toBe(PLACEHOLDER);
    const response = await w.post(calcBody([calcItem(target, `盘点对象.${PLACEHOLDER} + 1`)]));
    const error = ((await response.json()) as Failure).error;
    expect([response.status, error.details.reason, error.details.issues?.[0]?.code]).toEqual([
      400,
      'FORMULA_INVALID',
      'SYNTAX_ERROR',
    ]);
    expect((await w.list()).items).toEqual([]);
  });

  it('没有同名字段时 issue 仍是 SYNTAX_ERROR（不是 UNKNOWN_FIELD）', async () => {
    const w = await calcWorld(testDb().db, 'f082-compat-2', { formulaIdBinding: false });
    const target = await w.numberField();
    const response = await w.post(calcBody([calcItem(target, `盘点对象.${PLACEHOLDER} + 1`)]));
    const error = ((await response.json()) as Failure).error;
    expect([response.status, error.details.issues?.[0]?.code]).toEqual([400, 'SYNTAX_ERROR']);
  });
});
