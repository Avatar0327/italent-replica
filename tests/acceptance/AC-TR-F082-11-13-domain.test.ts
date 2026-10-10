/**
 * F-082 AC-11（句柄不可注入）与 AC-13（裸词）的领域层部分（F082-1；接口层由 F082-3 补）。
 */
import { bindFormula, fieldHandle } from '@italent/domain';
import { describe, expect, it } from 'vitest';

const SCORE = '11111111-1111-4111-8111-111111111111';
const visibleFields = [{ id: SCORE, name: '绩效结果1' }];
const options = { visibleFields, catalogVersion: { current: 3, submitted: 3 } };

describe('AC-11 句柄不可注入', () => {
  it('提交含 @{tr-field:<id>} 的公式 → 400 FORMULA_INVALID，不绑定', () => {
    const result = bindFormula(`${fieldHandle(SCORE)} + 1`, options);
    expect(result).toMatchObject({ ok: false, failure: { code: 'FORMULA_INVALID' } });
  });

  it('字符串里的 @{…} 原样保存，不进引用集合', () => {
    const text = `Len("@{tr-field:${SCORE}}") + 盘点对象.绩效结果1`;
    const result = bindFormula(text, options);
    if (!result.ok) throw new Error(JSON.stringify(result.failure));
    expect(result.stored).toBe(`Len("@{tr-field:${SCORE}}") + ${fieldHandle(SCORE)}`);
    expect(result.fieldIds).toEqual([SCORE]);
  });
});

describe('AC-13 裸词', () => {
  it('IF(盘点对象.绩效结果1 = A, …) → FORMULA_INVALID/BARE_WORD 并提示 "A"；"A" 通过；Def 变量不算裸词', () => {
    const bare = bindFormula('IF(盘点对象.绩效结果1 = A, 1, 2)', options);
    expect(bare).toMatchObject({ ok: false, failure: { code: 'FORMULA_INVALID', issues: [{ code: 'BARE_WORD' }] } });
    if (bare.ok || bare.failure.code !== 'FORMULA_INVALID') return;
    expect(bare.failure.issues[0]!.message).toContain('"A"');
    expect(bindFormula('IF(盘点对象.绩效结果1 = "A", 1, 2)', options).ok).toBe(true);
    expect(bindFormula('Def(x, 1); IF(盘点对象.绩效结果1 = x, 1, 2)', options).ok).toBe(true);
  });

  it('与可见字段同名时多提示 盘点对象.<名>；与看不到的字段同名时不提示', () => {
    const visible = bindFormula('IF(盘点对象.绩效结果1 = 绩效结果1, 1, 2)', options);
    const hidden = bindFormula('IF(盘点对象.绩效结果1 = 秘密字段, 1, 2)', options);
    const message = (r: typeof visible) =>
      !r.ok && r.failure.code === 'FORMULA_INVALID' ? r.failure.issues[0]!.message : '';
    expect(message(visible)).toContain('盘点对象.绩效结果1');
    expect(message(hidden)).not.toContain('盘点对象.秘密字段');
  });
});
