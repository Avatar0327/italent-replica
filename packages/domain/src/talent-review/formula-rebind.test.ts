/**
 * F-082（F082-5）：存量公式改绑的领域规则（契约 §6.1～§6.3）——按迁移时 B5 的解析规则固定绑定，不按新规则重新解释；
 * 失败时给出原因码与候选字段（宁可多保护）。
 */
import { describe, expect, it } from 'vitest';
import { fieldHandle } from '../expression/index.js';
import { rebindLegacyFormula } from './formula-rebind.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const field = (id: string, name: string, kind = 'number') => ({
  id,
  name,
  kind: kind as 'number',
  systemWritten: false,
  enabled: true,
});

describe('rebindLegacyFormula 成功', () => {
  it('唯一同名字段 → 规范文本（空白写法规范化）与引用集合', () => {
    const result = rebindLegacyFormula('盘点对象 . 甲 + 盘点对象.乙 * 2', [field(A, '甲'), field(B, '乙')]);
    expect(result).toEqual({ ok: true, stored: `${fieldHandle(A)} + ${fieldHandle(B)} * 2`, fieldIds: [A, B] });
  });

  it('盘点方案：恰有一个同名自定义字段 → 绑定该字段（B5 自定义字段优先）；没有 → 项目上下文', () => {
    expect(rebindLegacyFormula('盘点对象.盘点方案 = "x"', [field(A, '盘点方案', 'text')])).toMatchObject({
      ok: true,
      stored: `${fieldHandle(A)} = "x"`,
      fieldIds: [A],
    });
    expect(rebindLegacyFormula('盘点对象.盘点方案 = "x"', [field(A, '甲')])).toEqual({
      ok: true,
      stored: '盘点对象.盘点方案 = "x"',
      fieldIds: [],
    });
  });

  it('字符串里的写法原样保留，不当作引用', () => {
    const result = rebindLegacyFormula('Len("盘点对象.甲") + 盘点对象.甲', [field(A, '甲')]);
    expect(result).toEqual({ ok: true, stored: `Len("盘点对象.甲") + ${fieldHandle(A)}`, fieldIds: [A] });
  });
});

describe('rebindLegacyFormula 失败：原因码与候选', () => {
  it('UNKNOWN_FIELD：找不到字段；候选为空', () => {
    expect(rebindLegacyFormula('盘点对象.丙 + 1', [field(A, '甲')])).toEqual({
      ok: false,
      issue: 'UNKNOWN_FIELD',
      candidates: [],
    });
  });

  it('AMBIGUOUS_FIELD：同名字段不止一个 → 候选是全部同名字段', () => {
    expect(rebindLegacyFormula('盘点对象.甲 + 盘点对象.乙', [field(A, '甲'), field(B, '甲'), field(C, '乙')])).toEqual({
      ok: false,
      issue: 'AMBIGUOUS_FIELD',
      candidates: [A, B, C],
    });
  });

  it('RESERVED_PATH_CONFLICT：多个名为“盘点方案”的字段 → 不猜，候选是这些字段', () => {
    expect(
      rebindLegacyFormula('盘点对象.盘点方案 = "x"', [field(A, '盘点方案', 'text'), field(B, '盘点方案', 'text')]),
    ).toEqual({ ok: false, issue: 'RESERVED_PATH_CONFLICT', candidates: [A, B] });
  });

  it('BARE_WORD：裸词 → 原因码 BARE_WORD，同公式里能解析的引用仍是候选', () => {
    expect(rebindLegacyFormula('IF(盘点对象.甲 = A, 1, 0)', [field(A, '甲')])).toEqual({
      ok: false,
      issue: 'BARE_WORD',
      candidates: [A],
    });
  });

  it('INVALID：整段解析失败 → 候选是名称粗筛命中的全部字段（宁可多保护）', () => {
    const result = rebindLegacyFormula('盘点对象.甲 +', [field(A, '甲'), field(B, '乙'), field(C, '甲乙')]);
    expect(result).toMatchObject({ ok: false, issue: 'INVALID' });
    // 乙 没出现在公式里；甲乙 的每一段（甲乙 整名）不连续出现 → 只有 甲 命中
    expect((result as { candidates: readonly string[] }).candidates).toEqual([A]);
  });

  it('MULTI_OPTION：引用了多选字段', () => {
    expect(rebindLegacyFormula('Len(盘点对象.多)', [field(D, '多', 'multi_option')])).toEqual({
      ok: false,
      issue: 'MULTI_OPTION',
      candidates: [D],
    });
  });
});
