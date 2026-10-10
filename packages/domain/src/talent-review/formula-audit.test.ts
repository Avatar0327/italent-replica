/**
 * F-082（F082-2）：审计读取裁剪的领域部分（契约 §5.3，DEC-376④、DEC-197）。
 * 审计行按写入时的完整内容保存；查询出口按查看人**当前**的字段目录可见集合裁剪公式里的引用与 ID。
 */
import { describe, expect, it } from 'vitest';
import { HIDDEN_FIELD_PLACEHOLDER, fieldHandle } from '../expression/index.js';
import { redactCalcRuleAuditValue } from './formula-audit.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const T = '33333333-3333-4333-8333-333333333333';
const hA = fieldHandle(A);
const hB = fieldHandle(B);

const directory = (visible: Record<string, string>, allVisible = false) => ({
  visible: new Map(Object.entries(visible)),
  allVisible,
});
const boundItem = (formula: string) => ({
  targetFieldId: T,
  priority: 1,
  description: null,
  formula,
  formulaBinding: 'bound',
  fieldNames: { [A]: '写入时的甲', [B]: '写入时的乙' },
  refFieldIds: [A, B],
});

describe('新格式（bound）：按写入时刻的名称渲染，不可见的换占位符并去掉其 ID', () => {
  it('只看得到甲：甲用历史名称，乙是占位符，refFieldIds / fieldNames 不含乙', () => {
    const value = { items: [boundItem(`${hA} + ${hB}`)] };
    const out = redactCalcRuleAuditValue(value, directory({ [A]: '现在的甲' })) as typeof value;
    const item = out.items[0]! as ReturnType<typeof boundItem>;
    expect(item.formula).toBe(`盘点对象.写入时的甲 + 盘点对象.${HIDDEN_FIELD_PLACEHOLDER}`);
    expect(item.refFieldIds).toEqual([A]);
    expect(item.fieldNames).toEqual({ [A]: '写入时的甲' });
    expect(JSON.stringify(out)).not.toContain(B);
    expect(JSON.stringify(out)).not.toContain('写入时的乙');
  });

  it('全部可见：都用历史名称；全部不可见：全是占位符，没有任何字段 ID（目标字段 ID 是规则自身数据，保留）', () => {
    const all = redactCalcRuleAuditValue(boundItem(`${hA} + ${hB}`), directory({ [A]: 'a', [B]: 'b' }, true));
    expect((all as { formula: string }).formula).toBe('盘点对象.写入时的甲 + 盘点对象.写入时的乙');
    const none = redactCalcRuleAuditValue(boundItem(`${hA} + ${hB}`), directory({})) as ReturnType<typeof boundItem>;
    expect(none.formula).toBe(`盘点对象.${HIDDEN_FIELD_PLACEHOLDER} + 盘点对象.${HIDDEN_FIELD_PLACEHOLDER}`);
    expect([none.refFieldIds, none.fieldNames]).toEqual([[], {}]);
    expect(JSON.stringify(none)).not.toContain(A);
  });

  it('规范文本损坏：只给固定提示，不带出任何 ID', () => {
    const out = redactCalcRuleAuditValue(boundItem(`${hA} +`), directory({ [A]: 'a' })) as ReturnType<typeof boundItem>;
    expect(out.formula).toBe('〔公式待修复，无法显示〕');
    expect(JSON.stringify(out)).not.toContain(B);
  });
});

describe('旧格式（B5，没有 formulaBinding）：按 legacy 规则——可见字段里有同名字段才原样显示', () => {
  const legacy = { targetFieldId: T, priority: 1, formula: '盘点对象.绩效 + 盘点对象.秘密' };

  it('绩效可见、秘密不可见', () => {
    const out = redactCalcRuleAuditValue(legacy, directory({ [A]: '绩效' })) as typeof legacy;
    expect(out.formula).toBe(`盘点对象.绩效 + 盘点对象.${HIDDEN_FIELD_PLACEHOLDER}`);
  });

  it('无法解析：全部字段可见才看原文', () => {
    const broken = { ...legacy, formula: '盘点对象.绩效 +' };
    expect((redactCalcRuleAuditValue(broken, directory({ [A]: '绩效' }, true)) as typeof legacy).formula).toBe(
      '盘点对象.绩效 +',
    );
    expect((redactCalcRuleAuditValue(broken, directory({ [A]: '绩效' })) as typeof legacy).formula).toBe(
      '〔公式待修复，无法显示〕',
    );
  });
});

describe('递归：items 数组、变更差异（from / to）、改绑审计的 refFieldIds / fieldNames', () => {
  it('变更差异里 items 的前后值都裁剪；被改动的差异去掉已存的派生文本 fromText / toText', () => {
    const change = {
      field: 'items',
      from: [boundItem(`${hA}`)],
      to: [boundItem(`${hB}`)],
      fromText: '含乙的旧派生文本',
      toText: '含乙的新派生文本',
    };
    const out = redactCalcRuleAuditValue([change], directory({ [A]: 'a' })) as (typeof change)[];
    expect(out[0]!.from[0]!.formula).toBe('盘点对象.写入时的甲');
    expect(out[0]!.to[0]!.formula).toBe(`盘点对象.${HIDDEN_FIELD_PLACEHOLDER}`);
    expect('fromText' in out[0]!).toBe(false);
    expect('toText' in out[0]!).toBe(false);
  });

  it('没有被改动的差异原样保留（含 fromText / toText）', () => {
    const change = { field: 'name', from: '旧名', to: '新名', fromText: '旧名', toText: '新名' };
    expect(redactCalcRuleAuditValue([change], directory({}))).toEqual([change]);
  });

  it('改绑审计：refFieldIds / fieldNames 只留可见字段', () => {
    const value = {
      formulaBinding: 'bound',
      bindingIssue: null,
      refFieldIds: [A, B],
      fieldNames: { [A]: 'a', [B]: 'b' },
    };
    expect(redactCalcRuleAuditValue(value, directory({ [B]: 'b' }))).toEqual({
      formulaBinding: 'bound',
      bindingIssue: null,
      refFieldIds: [B],
      fieldNames: { [B]: 'b' },
    });
  });

  it('不含公式的值原样返回（同一对象，不拷贝）', () => {
    const value = { id: 'x', name: '规则', enabled: true };
    expect(redactCalcRuleAuditValue(value, directory({}))).toBe(value);
    expect(redactCalcRuleAuditValue(null, directory({}))).toBeNull();
  });
});

describe('R1-P3-2：审计里意外出现的 hints 按查看人可见集合防御裁剪（契约 §5.3 第 3 步）', () => {
  const hints = {
    warnings: ['字段“秘密”与“甲”循环', '另一条'],
    cycles: [
      [T, A],
      [B, A],
    ],
    order: [T, A, B],
    blocked: [T, B],
  };

  it('order / blocked / cycles 只留可见的目标字段 ID；warnings 含名称一律不原样输出，汇总为不含名称的计数提示', () => {
    const out = redactCalcRuleAuditValue({ hints }, directory({ [T]: '目标', [A]: '甲' })) as { hints: typeof hints };
    expect(out.hints.order).toEqual([T, A]);
    expect(out.hints.blocked).toEqual([T]);
    expect(out.hints.cycles).toEqual([[T, A]]);
    expect(JSON.stringify(out)).not.toContain('秘密');
    expect(out.hints.warnings).toEqual(['另有 2 条提示涉及不可见的字段，未显示']);
  });

  it('没有 hints 时原样返回（不产生新对象）', () => {
    const value = { name: '规则' };
    expect(redactCalcRuleAuditValue(value, directory({}))).toBe(value);
  });
});
