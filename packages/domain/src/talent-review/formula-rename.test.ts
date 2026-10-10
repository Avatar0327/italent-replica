/**
 * F-082（F082-2）：改名守卫用的领域函数（契约 §3.1、§3.2）——
 * checkRenameRoundTrip：改名后用新名称渲染并按输入管道重新绑定，必须逐字等于原规范文本；
 * textMentionsField：非 bound 公式的文本兜底（长期保留），解析失败宁可多保护。
 */
import { describe, expect, it } from 'vitest';
import { fieldHandle } from '../expression/index.js';
import { textMentionsField } from './calc-rule.js';
import { checkRenameRoundTrip } from './formula-rename.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const hA = fieldHandle(A);
const hB = fieldHandle(B);
const fields = (a: string, b = '乙') => [
  { id: A, name: a },
  { id: B, name: b },
];

describe('checkRenameRoundTrip（契约 §3.1 第 4 步）', () => {
  it('普通改名通过；允许改成与其他字段同名', () => {
    expect(checkRenameRoundTrip(`${hA} + ${hB}`, fields('甲'))).toEqual({ ok: true });
    expect(checkRenameRoundTrip(`${hA} + ${hB}`, fields('乙'))).toEqual({ ok: true });
  });

  it('项目上下文路径、字符串、其他前缀的固定字段保持不变', () => {
    const stored = `Ranking("百分位", ${hA}, 盘点活动.项目名称="项目甲", 盘点对象.盘点方案) + Len("盘点对象.甲")`;
    expect(checkRenameRoundTrip(stored, fields('甲'))).toEqual({ ok: true });
  });

  it('渲染后超 4000 字 → TOO_LONG', () => {
    const stored = `${hA} + "${'x'.repeat(3970)}"`;
    expect(checkRenameRoundTrip(stored, fields('甲'))).toEqual({ ok: true });
    expect(checkRenameRoundTrip(stored, fields('名'.repeat(40)))).toEqual({ ok: false, reason: 'TOO_LONG' });
  });

  it('改成带“.”的名称使词数超 800 → TOO_MANY_TOKENS', () => {
    const stored = Array.from({ length: 200 }, () => hA).join(' + ');
    expect(checkRenameRoundTrip(stored, fields('X'))).toEqual({ ok: true });
    expect(checkRenameRoundTrip(stored, fields('A.B'))).toEqual({ ok: false, reason: 'TOO_MANY_TOKENS' });
  });

  it('改成关键字、含“.”导致结构变化 → NOT_PARSEABLE', () => {
    for (const name of ['如果', 'then', 'A.B', '问卷+总分', '含 空格']) {
      expect(checkRenameRoundTrip(`${hA} + 1`, fields(name)), name).toEqual({ ok: false, reason: 'NOT_PARSEABLE' });
    }
  });

  it('规范文本本身损坏 → NOT_PARSEABLE', () => {
    expect(checkRenameRoundTrip('盘点对象.秘密 + 1', fields('甲'))).toEqual({ ok: false, reason: 'NOT_PARSEABLE' });
    expect(checkRenameRoundTrip(`${hA} +`, fields('甲'))).toEqual({ ok: false, reason: 'NOT_PARSEABLE' });
  });
});

describe('textMentionsField（文本兜底，契约 §3.2 第 3 条）', () => {
  it('解析判定：引用了该字段当前名称才算；含空白写法算；字符串里的、名称是其他字段名前缀 / 子串的不算', () => {
    expect(textMentionsField('盘点对象.绩效 + 1', '绩效')).toBe(true);
    expect(textMentionsField('盘点对象 .\n 绩效 + 1', '绩效')).toBe(true);
    expect(textMentionsField('盘点对象.绩效得分 + 1', '绩效')).toBe(false);
    expect(textMentionsField('Len("盘点对象.绩效")', '绩效')).toBe(false);
    expect(textMentionsField('1 + 2', '绩效')).toBe(false);
  });

  it('解析失败的公式只要文本粗筛命中名称就算引用（宁可多保护）', () => {
    expect(textMentionsField('盘点对象.绩效 +', '绩效')).toBe(true);
    expect(textMentionsField('盘点对象.绩效得分 +', '绩效')).toBe(true);
    expect(textMentionsField('盘点对象.其他 +', '绩效')).toBe(false);
  });
});
