/**
 * F-082（F082-1）：bindFormula / renderFormula（契约 §1.4～§1.7）。纯函数：名称 ⇄ ID 句柄，绑定证明，不可见引用。
 */
import { describe, expect, it } from 'vitest';
import { FORMULA_OBJECT } from './calc-rule.js';
import { HIDDEN_FIELD_OWNER, HIDDEN_FIELD_PLACEHOLDER, fieldHandle } from '../expression/index.js';
import { bindFormula, CONTEXT_BINDING, renderFormula, type BindFormulaOptions } from './formula-binding.js';

const F1 = '11111111-1111-4111-8111-111111111111';
const F2 = '22222222-2222-4222-8222-222222222222';
const F3 = '33333333-3333-4333-8333-333333333333';
const H1 = fieldHandle(F1);
const H2 = fieldHandle(F2);
const H3 = fieldHandle(F3);

const FIELDS = [
  { id: F1, name: '绩效' },
  { id: F2, name: '潜力' },
];
const CURRENT = 7;
const fresh = (extra: Partial<BindFormulaOptions> = {}): BindFormulaOptions => ({
  visibleFields: FIELDS,
  catalogVersion: { current: CURRENT, submitted: CURRENT },
  ...extra,
});

const expectBound = (result: ReturnType<typeof bindFormula>) => {
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result;
};
const expectFailure = (result: ReturnType<typeof bindFormula>) => {
  if (result.ok) throw new Error(`应当失败：${result.stored}`);
  return result.failure;
};

describe('常量与领域名一致', () => {
  it('占位符所属对象就是公式里盘点字段的前缀', () => {
    expect(HIDDEN_FIELD_OWNER).toBe(FORMULA_OBJECT);
  });
});

describe('bindFormula：新输入按名称绑定', () => {
  it('名称换成句柄，其余字符原样保留；映射与引用集合按出现顺序', () => {
    const bound = expectBound(bindFormula('盘点对象.潜力 * 2 + 盘点对象.绩效 + 盘点对象.潜力', fresh()));
    expect(bound.stored).toBe(`${H2} * 2 + ${H1} + ${H2}`);
    expect(bound.mapping).toEqual([F2, F1, F2]);
    expect(bound.fieldIds).toEqual([F2, F1]);
  });

  it('“盘点对象 . 来源”（含空白、换行）读回规范写法', () => {
    const bound = expectBound(bindFormula('盘点对象 .\n 绩效 + 1', fresh()));
    expect(bound.stored).toBe(`${H1} + 1`);
  });

  it('字符串里的“盘点对象.绩效”、句柄原文不绑定', () => {
    const source = `"盘点对象.绩效" + "${H1}" + 盘点对象.绩效`;
    const bound = expectBound(bindFormula(source, fresh()));
    expect(bound.stored).toBe(`"盘点对象.绩效" + "${H1}" + ${H1}`);
    expect(bound.mapping).toEqual([F1]);
  });

  it('项目 / 活动固定字段与取数记录字段保持文本，不进引用', () => {
    const source = 'Ranking("百分位", 盘点对象.绩效, 盘点活动.项目名称="项目甲", 盘点对象.盘点方案)';
    const bound = expectBound(bindFormula(source, fresh()));
    expect(bound.stored).toBe(`Ranking("百分位", ${H1}, 盘点活动.项目名称="项目甲", 盘点对象.盘点方案)`);
    expect(bound.mapping).toEqual([F1, CONTEXT_BINDING]);
    expect(bound.fieldIds).toEqual([F1]);
  });

  it('没有引用的公式：映射与引用为空，无需字段目录版本', () => {
    const bound = expectBound(bindFormula('1 + 2', { visibleFields: FIELDS }));
    expect(bound).toMatchObject({ stored: '1 + 2', mapping: [], fieldIds: [], hasNewInput: false });
  });

  it('输入模式下用户提交的句柄是非法字符', () => {
    const failure = expectFailure(bindFormula(`${H1} + 1`, fresh()));
    expect(failure).toMatchObject({ code: 'FORMULA_INVALID' });
  });

  it('句柄不可注入：绑定后字符串里的 @{…} 原样保存', () => {
    const bound = expectBound(bindFormula(`Len("@{tr-field:${F3}}") + 1`, fresh()));
    expect(bound.stored).toBe(`Len("@{tr-field:${F3}}") + 1`);
    expect(bound.fieldIds).toEqual([]);
  });
});

describe('bindFormula：字段目录版本', () => {
  it('新输入引用：版本不同或没带 → FIELD_CATALOG_CHANGED', () => {
    for (const submitted of [CURRENT - 1, undefined]) {
      const failure = expectFailure(
        bindFormula('盘点对象.绩效', fresh({ catalogVersion: { current: CURRENT, submitted } })),
      );
      expect(failure.code).toBe('FIELD_CATALOG_CHANGED');
    }
  });

  it('全部引用都带绑定证明时不看版本', () => {
    const bound = expectBound(
      bindFormula('盘点对象.绩效', fresh({ proofs: [F1], catalogVersion: { current: CURRENT, submitted: undefined } })),
    );
    expect(bound.hasNewInput).toBe(false);
    expect(bound.stored).toBe(H1);
  });
});

describe('bindFormula：绑定证明（DEC-376②）', () => {
  it('带 ID 且名称一致 → 绑定该 ID', () => {
    expect(expectBound(bindFormula('盘点对象.绩效', fresh({ proofs: [F1] }))).mapping).toEqual([F1]);
  });

  it('带 ID 但当前名称不一致（已改名 / 换绑）→ CALC_BINDING_STALE，带出现序号', () => {
    const failure = expectFailure(bindFormula('盘点对象.绩效 + 盘点对象.绩效', fresh({ proofs: [F1, F2] })));
    expect(failure).toEqual({ code: 'CALC_BINDING_STALE', occurrence: 1 });
  });

  it('ID 不存在、跨租户或对提交人不可见 → UNKNOWN_FIELD（与不存在同一结果）', () => {
    const failure = expectFailure(bindFormula('盘点对象.绩效', fresh({ proofs: [F3] })));
    expect(failure).toMatchObject({ code: 'FORMULA_INVALID', issues: [{ code: 'UNKNOWN_FIELD' }] });
  });

  it('同名字段：带 ID 的引用不受重名影响；新输入的引用 → CALC_FIELD_NAME_AMBIGUOUS', () => {
    const twins = [...FIELDS, { id: F3, name: '绩效' }];
    const withProof = expectBound(
      bindFormula('盘点对象.绩效 + 盘点对象.绩效', fresh({ visibleFields: twins, proofs: [F1, F3] })),
    );
    expect(withProof.mapping).toEqual([F1, F3]);
    const failure = expectFailure(bindFormula('盘点对象.绩效', fresh({ visibleFields: twins })));
    expect(failure).toEqual({ code: 'CALC_FIELD_NAME_AMBIGUOUS', occurrence: 0 });
  });

  it('不存在的名称 → UNKNOWN_FIELD；对提交人不可见的字段与不存在同一结果', () => {
    const failure = expectFailure(bindFormula('盘点对象.不存在', fresh()));
    expect(failure).toMatchObject({ code: 'FORMULA_INVALID', issues: [{ code: 'UNKNOWN_FIELD' }] });
  });

  it('formulaBindings 长度不等于引用处数 → BINDING_MISMATCH', () => {
    for (const proofs of [[F1], [F1, F1, F1], [] as string[]]) {
      const failure = expectFailure(bindFormula('盘点对象.绩效 + 盘点对象.潜力', fresh({ proofs })));
      expect(failure, JSON.stringify(proofs)).toMatchObject({
        code: 'FORMULA_INVALID',
        issues: [{ code: 'BINDING_MISMATCH' }],
      });
    }
  });

  it('混合：有的处带证明、有的是新输入（null）', () => {
    const bound = expectBound(bindFormula('盘点对象.绩效 + 盘点对象.潜力', fresh({ proofs: [F1, null] })));
    expect(bound.mapping).toEqual([F1, F2]);
    expect(bound.hasNewInput).toBe(true);
    const stale = expectFailure(
      bindFormula(
        '盘点对象.绩效 + 盘点对象.潜力',
        fresh({ proofs: [F1, null], catalogVersion: { current: CURRENT, submitted: CURRENT - 1 } }),
      ),
    );
    expect(stale.code).toBe('FIELD_CATALOG_CHANGED');
  });
});

describe('bindFormula：盘点对象.盘点方案（DEC-376③）', () => {
  const custom = [...FIELDS, { id: F3, name: '盘点方案' }];

  it('没有同名可见字段：新输入指项目上下文，规范文本保持文本', () => {
    const bound = expectBound(bindFormula('盘点对象 . 盘点方案', fresh()));
    expect(bound.stored).toBe('盘点对象.盘点方案');
    expect(bound.mapping).toEqual([CONTEXT_BINDING]);
    expect(bound.fieldIds).toEqual([]);
  });

  it('有可见的同名自定义字段：要求显式选择，400 RESERVED_PATH_AMBIGUOUS 带选项', () => {
    const failure = expectFailure(bindFormula('1 + 盘点对象.盘点方案', fresh({ visibleFields: custom })));
    expect(failure).toMatchObject({
      code: 'FORMULA_INVALID',
      issues: [{ code: 'RESERVED_PATH_AMBIGUOUS', occurrence: 0, choices: [CONTEXT_BINDING, F3] }],
    });
  });

  it('显式选择 context 或字段 ID 后保存成功，绑定与选择一致', () => {
    const toContext = expectBound(
      bindFormula('盘点对象.盘点方案', fresh({ visibleFields: custom, proofs: [CONTEXT_BINDING] })),
    );
    expect([toContext.stored, toContext.mapping]).toEqual(['盘点对象.盘点方案', [CONTEXT_BINDING]]);
    const toField = expectBound(bindFormula('盘点对象.盘点方案', fresh({ visibleFields: custom, proofs: [F3] })));
    expect([toField.stored, toField.mapping]).toEqual([H3, [F3]]);
  });

  it('“context”只对盘点方案有效：用在别的字段上 → BINDING_MISMATCH', () => {
    const failure = expectFailure(bindFormula('盘点对象.绩效', fresh({ proofs: [CONTEXT_BINDING] })));
    expect(failure).toMatchObject({ code: 'FORMULA_INVALID', issues: [{ code: 'BINDING_MISMATCH' }] });
  });
});

describe('bindFormula：不可见引用（DEC-376①）', () => {
  it('提交含占位符的公式 → HIDDEN_FIELD；HIDDEN_FIELD 优先于同一公式里的其他语义问题', () => {
    const failure = expectFailure(bindFormula(`盘点对象.${HIDDEN_FIELD_PLACEHOLDER} + 盘点对象.不存在 + A`, fresh()));
    expect(failure).toMatchObject({ code: 'FORMULA_INVALID' });
    if (failure.code !== 'FORMULA_INVALID') return;
    expect(failure.issues.map((issue) => issue.code)).toEqual(['HIDDEN_FIELD']);
  });

  it('P3-1：语法正确时 HIDDEN_FIELD 优先于类型错误与证明数量不符', () => {
    const typeError = expectFailure(bindFormula(`盘点对象.${HIDDEN_FIELD_PLACEHOLDER} + AddDays(1,1)`, fresh()));
    expect(typeError).toMatchObject({ code: 'FORMULA_INVALID', issues: [{ code: 'HIDDEN_FIELD' }] });
    const mismatch = expectFailure(
      bindFormula(
        `盘点对象.${HIDDEN_FIELD_PLACEHOLDER} + 盘点对象.${HIDDEN_FIELD_PLACEHOLDER}`,
        fresh({ proofs: [null] }),
      ),
    );
    expect(mismatch).toMatchObject({
      code: 'FORMULA_INVALID',
      issues: [{ code: 'HIDDEN_FIELD' }, { code: 'HIDDEN_FIELD' }],
    });
  });

  it('函数不存在、参数个数不对仍先于 HIDDEN_FIELD（§1.5 前置检查）', () => {
    const unknown = expectFailure(bindFormula(`盘点对象.${HIDDEN_FIELD_PLACEHOLDER} + NoSuchFn(1)`, fresh()));
    expect(unknown).toMatchObject({ code: 'FORMULA_INVALID', issues: [{ code: 'UNKNOWN_FUNCTION' }] });
  });

  it('语法错误仍先报语法错误', () => {
    const failure = expectFailure(bindFormula(`盘点对象.${HIDDEN_FIELD_PLACEHOLDER} +`, fresh()));
    expect(failure).toMatchObject({ code: 'FORMULA_INVALID', issues: [{ code: 'SYNTAX_ERROR' }] });
  });

  it('字符串里的占位符是普通文本', () => {
    const bound = expectBound(bindFormula(`"${HIDDEN_FIELD_PLACEHOLDER}" + 盘点对象.绩效`, fresh()));
    expect(bound.stored).toBe(`"${HIDDEN_FIELD_PLACEHOLDER}" + ${H1}`);
  });
});

describe('bindFormula：裸词（DEC-374⑥，契约 §1.7）', () => {
  const bare = 'IF(盘点对象.绩效 = A, 1, 2)';

  it('裸词 → FORMULA_INVALID / BARE_WORD，提示加英文双引号', () => {
    const failure = expectFailure(bindFormula(bare, fresh()));
    if (failure.code !== 'FORMULA_INVALID') throw new Error(JSON.stringify(failure));
    expect(failure.issues).toHaveLength(1);
    expect(failure.issues[0]).toMatchObject({ code: 'BARE_WORD' });
    expect(failure.issues[0]!.message).toBe('“A”不是字段也不是变量；作文本请写成 "A"');
  });

  it('裸词恰是查看人可见字段的名称：追加“引用盘点字段请写 盘点对象.<名>”', () => {
    const failure = expectFailure(bindFormula('IF(盘点对象.绩效 = 潜力, 1, 2)', fresh()));
    if (failure.code !== 'FORMULA_INVALID') throw new Error(JSON.stringify(failure));
    expect(failure.issues[0]!.message).toBe(
      '“潜力”不是字段也不是变量；作文本请写成 "潜力"；引用盘点字段请写 盘点对象.潜力',
    );
  });

  it('与看不到的字段同名时不提示（不泄露不可见字段的存在）', () => {
    const failure = expectFailure(bindFormula('IF(盘点对象.绩效 = 秘密, 1, 2)', fresh()));
    if (failure.code !== 'FORMULA_INVALID') throw new Error(JSON.stringify(failure));
    expect(failure.issues[0]!.message).not.toContain('盘点对象.秘密');
    expect(failure.issues[0]!.message).toBe('“秘密”不是字段也不是变量；作文本请写成 "秘密"');
  });

  it('加了双引号的文本通过；Def 定义的变量与函数调用名不是裸词', () => {
    expect(bindFormula('IF(盘点对象.绩效 = "A", 1, 2)', fresh()).ok).toBe(true);
    expect(bindFormula('Def(x, 盘点对象.绩效); x + 1', fresh()).ok).toBe(true);
  });

  it('Def 变量在定义之前使用仍是裸词', () => {
    expect(bindFormula('Def(x, x + 1); x', fresh()).ok).toBe(false);
  });
});

describe('renderFormula：bound（ID → 名称）', () => {
  const bound = (stored: string, visibleFields: readonly { id: string; name: string }[] = FIELDS) =>
    renderFormula(stored, { binding: 'bound', visibleFields });

  it('句柄渲染成当前名称，绑定按出现顺序；项目上下文为 context', () => {
    const stored = `${H2} * 2 + ${H1} + 盘点对象.盘点方案 + "${H1}"`;
    expect(bound(stored)).toEqual({
      ok: true,
      text: '盘点对象.潜力 * 2 + 盘点对象.绩效 + 盘点对象.盘点方案 + "@{tr-field:11111111-1111-4111-8111-111111111111}"',
      bindings: [F2, F1, CONTEXT_BINDING],
    });
  });

  it('查看人看不到的字段 → 占位符，绑定为 null', () => {
    expect(bound(`${H1} + ${H3}`)).toEqual({
      ok: true,
      text: `盘点对象.绩效 + 盘点对象.${HIDDEN_FIELD_PLACEHOLDER}`,
      bindings: [F1, null],
    });
  });

  it('bound 规范文本里出现名称写法是数据损坏：不原样输出（ok:false）', () => {
    expect(bound('盘点对象.秘密 + 1')).toEqual({ ok: false });
  });

  it('规范文本无法解析时返回 ok:false', () => {
    expect(bound('1 +')).toEqual({ ok: false });
  });

  it('改名后渲染新名称；往返：渲染文本带全部绑定重新绑定，结果逐字等于原规范文本', () => {
    const stored = `${H2} * 2 + ${H1} + 盘点对象.盘点方案`;
    const renamed = [
      { id: F1, name: '新绩效' },
      { id: F2, name: '潜力' },
    ];
    const rendered = bound(stored, renamed);
    if (!rendered.ok) throw new Error('渲染失败');
    expect(rendered.text).toContain('盘点对象.新绩效');
    const again = expectBound(bindFormula(rendered.text, { visibleFields: renamed, proofs: rendered.bindings }));
    expect(again.stored).toBe(stored);
  });

  it('重名回显：A 改名为 B 后回显 B+B，带绑定重提仍绑定原 ID', () => {
    const twins = [
      { id: F1, name: '潜力' },
      { id: F2, name: '潜力' },
    ];
    const rendered = bound(`${H1} + ${H2}`, twins);
    if (!rendered.ok) throw new Error('渲染失败');
    expect(rendered.text).toBe('盘点对象.潜力 + 盘点对象.潜力');
    const again = expectBound(bindFormula(rendered.text, { visibleFields: twins, proofs: rendered.bindings }));
    expect(again.stored).toBe(`${H1} + ${H2}`);
  });
});

describe('renderFormula：legacy / unresolved（契约 §1.4，DEC-376③；审查 P2-1）', () => {
  const custom = [...FIELDS, { id: F3, name: '盘点方案' }];
  const legacy = (text: string, extra: { allFieldsVisible?: boolean; visibleFields?: typeof FIELDS } = {}) =>
    renderFormula(text, {
      binding: 'legacy',
      visibleFields: extra.visibleFields ?? FIELDS,
      allFieldsVisible: extra.allFieldsVisible ?? false,
    });

  it('可见字段里有同名字段才原样显示，否则占位符；逐处绑定一律为 null（没有确定绑定）', () => {
    expect(legacy('盘点对象.绩效 + 盘点对象.秘密 + 1')).toEqual({
      ok: true,
      text: `盘点对象.绩效 + 盘点对象.${HIDDEN_FIELD_PLACEHOLDER} + 1`,
      bindings: [null, null],
    });
  });

  it('同类：不存在的名称、空目录都渲染占位符，不原样输出', () => {
    expect(legacy('盘点对象.秘密', { visibleFields: [] })).toMatchObject({
      text: `盘点对象.${HIDDEN_FIELD_PLACEHOLDER}`,
      bindings: [null],
    });
  });

  it('历史公式 盘点对象.盘点方案：绑定为 null，不生成 "context" 证明；往返不会把自定义字段换成项目上下文', () => {
    const rendered = legacy('盘点对象.盘点方案', { visibleFields: custom });
    expect(rendered).toEqual({ ok: true, text: '盘点对象.盘点方案', bindings: [null] });
    if (!rendered.ok) return;
    // 不带当前目录版本：不会静默成功
    const noVersion = bindFormula(rendered.text, { visibleFields: custom, proofs: rendered.bindings });
    expect(noVersion).toMatchObject({ ok: false, failure: { code: 'FIELD_CATALOG_CHANGED' } });
    // 带当前版本：要求显式选择
    const withVersion = bindFormula(rendered.text, {
      visibleFields: custom,
      proofs: rendered.bindings,
      catalogVersion: { current: CURRENT, submitted: CURRENT },
    });
    expect(withVersion).toMatchObject({
      ok: false,
      failure: {
        code: 'FORMULA_INVALID',
        issues: [{ code: 'RESERVED_PATH_AMBIGUOUS', choices: [CONTEXT_BINDING, F3] }],
      },
    });
  });

  it('整段无法解析：只有“全部字段都可见”的查看人看原文，其他人只看到固定提示', () => {
    expect(legacy('盘点对象.绩效 +', { allFieldsVisible: true })).toEqual({
      ok: true,
      text: '盘点对象.绩效 +',
      bindings: [],
      repairNeeded: true,
    });
    expect(legacy('盘点对象.绩效 +')).toEqual({
      ok: true,
      text: '〔公式待修复，无法显示〕',
      bindings: [],
      repairNeeded: true,
    });
  });

  it('字符串里的“盘点对象.秘密”是普通文本，不替换', () => {
    expect(legacy('"盘点对象.秘密" + 盘点对象.绩效')).toMatchObject({
      text: '"盘点对象.秘密" + 盘点对象.绩效',
      bindings: [null],
    });
  });
});
