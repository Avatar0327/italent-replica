/**
 * 统一静态类型推导的单元测试（DEC-287①）：每种语法节点、IF / 如果 的分支合并、“不确定”的传播，
 * 以及日期参数的判定（确定 / 不匹配 / 不确定）。
 */
import { describe, expect, it } from 'vitest';
import { parseFormula } from './parser.js';
import { createDefaultRegistry } from './registry.js';
import {
  emptySource,
  mergeTypes,
  NO_RECORDS,
  TypeInference,
  verdictFor,
  withRecordObjects,
  type InferredType,
} from './typing.js';
import type { StaticKind } from './values.js';

const registry = createDefaultRegistry();

function typeOf(
  source: string,
  options: { fieldKind?: (path: string) => StaticKind | undefined; records?: ReadonlySet<string> } = {},
): InferredType {
  const parsed = parseFormula(source);
  if (!parsed.ok) throw new Error(`公式无法解析：${source}`);
  const typing = new TypeInference({ registry, fieldKind: options.fieldKind });
  for (const definition of parsed.program.definitions) typing.define(definition.name, definition.value);
  return typing.infer(parsed.program.body, options.records);
}

const definite = (kind: StaticKind): InferredType => ({ kind });
const uncertain = (...kinds: StaticKind[]): InferredType =>
  kinds.length ? { kind: 'uncertain', candidates: new Set(kinds) } : { kind: 'uncertain' };

const KINDS: Readonly<Record<string, StaticKind>> = {
  '盘点对象.得分': 'number',
  '盘点对象.备注': 'text',
  '盘点对象.是否参与': 'boolean',
  '员工信息.入职日期': 'date',
  得分: 'number',
};
const fieldKind = (path: string) => KINDS[path];

describe('字面量', () => {
  it.each([
    ['1', definite('number')],
    ['82%', definite('number')],
    ['"abc"', definite('text')],
    ['""', definite('text')],
    ['"2020/01/01"', definite('date')],
    ['"2020/01/01 08:00:00"', definite('date')],
    ['"2020/01"', definite('date')],
    ['"00:00"', definite('date')],
    ['真', definite('boolean')],
    ['False', definite('boolean')],
  ] as const)('%s', (source, expected) => {
    expect(typeOf(source)).toEqual(expected);
  });
});

describe('运算', () => {
  it.each([
    ['-1', definite('number')],
    ['-盘点对象.x', definite('number')],
    ['+1', definite('number')],
    ['1 + 2', definite('number')],
    ['"5" + 1', definite('number')],
    ['盘点对象.x * 2', definite('number')],
    ['1 > 2', definite('boolean')],
    ['盘点对象.x = "A"', definite('boolean')],
    ['真 且 假', definite('boolean')],
    ['真 或 盘点对象.x', definite('boolean')],
    ['非 盘点对象.x', definite('boolean')],
  ] as const)('%s', (source, expected) => {
    expect(typeOf(source)).toEqual(expected);
  });

  it('一元正号原样返回操作数（求值器不做数值转换），类型同操作数', () => {
    expect(typeOf('+盘点对象.x')).toEqual(uncertain());
    expect(typeOf('+"abc"')).toEqual(definite('text'));
  });

  it('运算结果的类型由运算决定，与操作数是否确定无关', () => {
    expect(typeOf('IF(真, 1, "a") + 1')).toEqual(definite('number'));
    expect(typeOf('IF(真, 1, "a") = 1')).toEqual(definite('boolean'));
  });
});

describe('字段与不带前缀的名字', () => {
  it('没有字段类型目录时不确定（可能的类型未知）', () => {
    expect(typeOf('盘点对象.得分')).toEqual(uncertain());
    expect(typeOf('得分')).toEqual(uncertain());
  });

  it('字段类型目录给出的类型（完整路径与短名）', () => {
    expect(typeOf('盘点对象.得分', { fieldKind })).toEqual(definite('number'));
    expect(typeOf('盘点对象.是否参与', { fieldKind })).toEqual(definite('boolean'));
    expect(typeOf('员工信息.入职日期', { fieldKind })).toEqual(definite('date'));
    expect(typeOf('得分', { fieldKind })).toEqual(definite('number'));
    expect(typeOf('盘点对象.不在目录', { fieldKind })).toEqual(uncertain());
  });

  it('目录读取出错时按不确定处理，不抛异常', () => {
    const broken = () => {
      throw new Error('目录不可用');
    };
    expect(typeOf('盘点对象.得分', { fieldKind: broken })).toEqual(uncertain());
  });

  it('取数函数的记录字段（考核结果.*）不按对象字段目录推导，一律不确定', () => {
    const recordKind = (path: string): StaticKind | undefined => (path === '考核结果.年度' ? 'number' : undefined);
    expect(typeOf('考核结果.年度', { fieldKind: recordKind, records: new Set(['考核结果']) })).toEqual(uncertain());
    expect(typeOf('考核结果.年度', { fieldKind: recordKind })).toEqual(definite('number'));
  });
});

describe('函数返回值', () => {
  it.each([
    ['Today()', definite('date')],
    ['AddDays(Today(), 1)', definite('date')],
    ['ToDate("2020/01/01")', definite('date')],
    ['Year(Today())', definite('number')],
    ['Days(Today(), Today())', definite('number')],
    ['DateFormat(Today(), "yyyy")', definite('text')],
    ['ToNumber("1")', definite('number')],
    ['ToText(1)', definite('text')],
    ['Concatenate("a", 1)', definite('text')],
    ['Round(1.5)', definite('number')],
    ['Count(1, 2)', definite('number')],
    ['Average(1, 2)', definite('number')],
    ['IsEmpty(1)', definite('boolean')],
    ['判断不为空(1)', definite('boolean')],
    ['AND(真, 假)', definite('boolean')],
    ['IN(1, 1, 2)', definite('boolean')],
    ['获取指定年度指定周期的绩效得分(考核结果.年度=2026, 考核结果.周期名称="年度")', definite('number')],
    ['获取指定年度指定周期的绩效等级(考核结果.年度=2026, 考核结果.周期名称="年度")', definite('text')],
    ['获取最近一次360总分(360结果.角色得分)', definite('number')],
    ['获取某个结果在指定人员范围内的排名("排序号", 盘点对象.得分)', definite('number')],
  ] as const)('%s', (source, expected) => {
    expect(typeOf(source)).toEqual(expected);
  });

  it('未声明返回类型的函数（取决于数据）与未知函数：不确定', () => {
    expect(typeOf('获取人事子集的指定字段数据(教育经历.学校)')).toEqual(uncertain());
    expect(typeOf('按照参数规则获取数据()')).toEqual(uncertain());
    expect(typeOf('ModuleResult("模块")')).toEqual(uncertain());
    expect(typeOf('不存在的函数(1)')).toEqual(uncertain());
  });

  it('Sum 遇文本按拼接（DEC-270③），结果可能是数值或文本：不确定', () => {
    expect(typeOf('Sum(1, 2)')).toEqual(uncertain('number', 'text'));
  });
});

describe('Def 变量', () => {
  it('引用取定义值的类型，可以逐层传递', () => {
    expect(typeOf('Def(n, 1); n')).toEqual(definite('number'));
    expect(typeOf('Def(a, Today()); Def(b, a); b')).toEqual(definite('date'));
    expect(typeOf('Def(a, Today()); Def(b, AddDays(a, 1)); Year(b)')).toEqual(definite('number'));
  });

  it('同一实例重新定义后，已推导过的引用改取新类型（推导缓存随登记失效）', () => {
    const parsed = parseFormula('Def(n, 1); Def(n, 真); n');
    if (!parsed.ok) throw new Error('公式无法解析');
    const [first, second] = parsed.program.definitions;
    const typing = new TypeInference({ registry });
    typing.define(first!.name, first!.value);
    expect(typing.infer(parsed.program.body)).toEqual(definite('number'));
    typing.define(second!.name, second!.value);
    expect(typing.infer(parsed.program.body)).toEqual(definite('boolean'));
  });

  it('定义值按登记之前的环境推导：Def(n, IF(真, n, "a")) 中的 n 取旧类型', () => {
    expect(typeOf('Def(n, 1); Def(n, IF(真, n, "a")); n')).toEqual(uncertain('number', 'text'));
    expect(typeOf('Def(n, 1); Def(n, n > 0); Def(m, IF(真, n, 假)); m')).toEqual(definite('boolean'));
  });

  it('重新定义后取最后一次定义的类型', () => {
    expect(typeOf('Def(n, 1); Def(n, "a"); n')).toEqual(definite('text'));
  });

  it('定义值不确定时变量也不确定（保留可能的类型）', () => {
    expect(typeOf('Def(n, IF(真, 1, "a")); n')).toEqual(uncertain('number', 'text'));
    expect(typeOf('Def(n, 盘点对象.x); n')).toEqual(uncertain());
    expect(typeOf('Def(n, 盘点对象.得分); n', { fieldKind })).toEqual(definite('number'));
  });

  it('不是 Def 变量的名字按字段处理', () => {
    expect(typeOf('得分', { fieldKind })).toEqual(definite('number'));
    expect(typeOf('Def(得分, "高"); 得分', { fieldKind })).toEqual(definite('text'));
  });
});

describe('IF / 如果：分支合并', () => {
  it('各分支类型一致：取该类型', () => {
    expect(typeOf('IF(真, 1, 2)')).toEqual(definite('number'));
    expect(typeOf('IF(真, Today(), "2020/01/01")')).toEqual(definite('date'));
    expect(typeOf('如果 真 那么 1 否则 2')).toEqual(definite('number'));
    expect(typeOf('如果 真 那么 1 如果 假 那么 2 否则 3')).toEqual(definite('number'));
  });

  it('分支类型不一致：不确定，并保留各分支可能的类型', () => {
    expect(typeOf('IF(真, 1, "abc")')).toEqual(uncertain('number', 'text'));
    expect(typeOf('IF(真, Today(), 1)')).toEqual(uncertain('date', 'number'));
    expect(typeOf('如果 真 那么 1 如果 假 那么 "a" 否则 Today()')).toEqual(uncertain('number', 'text', 'date'));
  });

  it('有分支不确定且可能的类型未知：整体不确定、可能的类型也未知', () => {
    expect(typeOf('IF(真, Today(), 员工信息.出生日期)')).toEqual(uncertain());
    expect(typeOf('如果 真 那么 1 否则 盘点对象.x')).toEqual(uncertain());
  });

  it('不确定向外传播：嵌套 IF 合并可能的类型', () => {
    expect(typeOf('IF(真, IF(假, 1, "a"), Today())')).toEqual(uncertain('number', 'text', 'date'));
    expect(typeOf('IF(真, IF(假, 1, "a"), 2)')).toEqual(uncertain('number', 'text'));
    expect(typeOf('Def(n, IF(真, 1, "a")); IF(假, n, Today())')).toEqual(uncertain('number', 'text', 'date'));
  });

  it('缺“否则”的分支结果为空值，不参与合并', () => {
    expect(typeOf('IF(真, 1)')).toEqual(definite('number'));
    expect(typeOf('如果 真 那么 Today()')).toEqual(definite('date'));
    expect(typeOf('如果 真 那么 1 如果 假 那么 "a"')).toEqual(uncertain('number', 'text'));
  });

  it('分支是字段时按字段类型目录合并', () => {
    expect(typeOf('IF(真, 盘点对象.得分, 1)', { fieldKind })).toEqual(definite('number'));
    expect(typeOf('IF(真, 员工信息.入职日期, Today())', { fieldKind })).toEqual(definite('date'));
    expect(typeOf('IF(真, 盘点对象.是否参与, 盘点对象.得分)', { fieldKind })).toEqual(uncertain('boolean', 'number'));
  });
});

describe('mergeTypes', () => {
  it.each([
    [[], uncertain()],
    [[definite('number')], definite('number')],
    [[definite('number'), definite('number')], definite('number')],
    [[definite('number'), definite('text')], uncertain('number', 'text')],
    [[definite('number'), uncertain()], uncertain()],
    [[uncertain('number', 'text'), definite('date')], uncertain('number', 'text', 'date')],
    [[uncertain('number', 'text'), uncertain('text', 'boolean')], uncertain('number', 'text', 'boolean')],
  ] as const)('%j → %j', (types, expected) => {
    expect(mergeTypes(types)).toEqual(expected);
  });
});

describe('verdictFor：参数要求某类型时的判定', () => {
  it.each([
    [definite('date'), 'ok'],
    [definite('number'), 'mismatch'],
    [definite('text'), 'mismatch'],
    [uncertain('number', 'text'), 'mismatch'],
    [uncertain('date', 'number'), 'uncertain'],
    [uncertain(), 'uncertain'],
  ] as const)('%j 作日期参数 → %s', (type, expected) => {
    expect(verdictFor(type, 'date')).toBe(expected);
  });
});

describe('emptySource：运行期空值的来源类型（DEC-270②）', () => {
  it.each([
    [definite('number'), 'number'],
    [definite('date'), 'date'],
    [uncertain('number', 'text'), 'number'],
    [uncertain('date', 'number'), undefined],
    [uncertain(), undefined],
  ] as const)('%j → %s', (type, expected) => {
    expect(emptySource(type)).toBe(expected);
  });
});

describe('withRecordObjects：进入函数参数后的记录对象范围', () => {
  it('取数函数加上自己的记录对象；其他函数沿用外层范围（同一个集合）', () => {
    const outer: ReadonlySet<string> = new Set(['考核结果']);
    expect([...withRecordObjects(new Set(), registry.resolve('PerformanceLastCent'))]).toEqual(['考核结果']);
    expect(withRecordObjects(outer, registry.resolve('Year'))).toBe(outer);
    expect(withRecordObjects(outer, undefined)).toBe(outer);
  });

  it('内容相同的范围复用同一个集合（推导缓存不随求值次数分出新桶）', () => {
    const spec = registry.resolve('PerformanceLastCent');
    expect(withRecordObjects(NO_RECORDS, spec)).toBe(withRecordObjects(new Set(), spec));
    expect(withRecordObjects(new Set(['考核结果']), spec)).toBe(withRecordObjects(NO_RECORDS, spec));
  });
});
