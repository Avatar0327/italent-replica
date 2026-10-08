/**
 * 排名（`26` §3.5 TR-R28、§8.6、§8.10；手册 246809263）：
 * Ranking(模式, 排序字段, 数据范围?, 排名范围条件?, 排名范围条件?)。原站 5 参中第 3、4 参必填，复刻兼容 2～4 参旧写法，
 * 缺省的范围参数 = 不限定（映射见 F-045 PR 描述）。
 * 口径照原站实测（DEC-302，坐实 DEC-262①）：
 * - 排序字段降序；并列为竞争排名（1、1、3）；
 * - 百分位 = 名次 ÷ 参与人数 × 100，保留两位小数（四舍五入），名次越前越小；
 * - 排序字段为空（含空字符串）的对象不参与、不计数，自身结果为空（不是计算失败）；
 * - 范围参数保留旧位置语义（R3-T04 设计 v3 §4.8、#113 N01）：第 3 参数是过滤条件（含裸是否型字段，
 *   如 盘点活动.项目名称 = "…" 把范围限定到单个项目），第 4 参数按取值分组（本租户 盘点对象.盘点方案）；
 *   新第 5 参数按统一类型推导（DEC-287）：是否型 = 过滤，其余 = 分组，推导不确定时按实际值（见 rangeRoles）。
 * 人员总体由调用方经 RankingPort 传入（批量求值默认本次计算对象），函数内不做权限裁剪、不决定取数身份；
 * 排名在全体总体上一次性求值（DEC-301②）：排名表按语义键缓存，一次计算里只建一次，所有对象查表。
 * 面板原文“在待办中触发计算时，包含这个函数的计算项目不会计算”（DEC-260）：以 skipInTodoTrigger 标记，调度由 R3-T04 落实。
 */
import { walk, type CallNode, type ExprNode } from '../ast.js';
import { CONVERSION_MESSAGE } from '../failures.js';
import { equalityLookupKeys, equalityStoreKeys, valuesEqual } from '../operators.js';
import type { SubjectReader } from '../ports.js';
import type { ArgumentIssue, FunctionCall, FunctionSpec } from '../registry.js';
import { isDefinitely, mayBe, verdictFor, type InferredType } from '../typing.js';
import { EMPTY, type DateParts, type ExprValue } from '../values.js';
import { isTypeConversion, unwrapPort } from './shared.js';

const MODES: Readonly<Record<string, 'rank' | 'percentile'>> = {
  排序号: 'rank',
  排名: 'rank',
  rank: 'rank',
  百分位: 'percentile',
  percentile: 'percentile',
};

const modeOf = (text: string) => MODES[text.trim().toLowerCase()];

/** 参数下标：第 3 参数（数据范围）、第 4 参数（旧分组字段）、第 5 参数（新增）。 */
const DATA_RANGE = 2;
const OLD_GROUP = 3;
const NEW_RANGE = 4;

const isReference = (node: ExprNode) => node.type === 'field' || node.type === 'identifier';

/**
 * 范围参数的角色：filter 须为“是”；group 与本人取值相同（按 = 的口径，即 valuesEqual）；
 * auto（第 5 参数类型推导不确定）按实际值——“否”或空 = 不满足，其余按取值分组。
 */
type RangeRole = 'filter' | 'group' | 'auto';

/** 角色只看参数位置与统一类型推导（DEC-287），保存检查与运行期共用。 */
function rangeRole(index: number, type: InferredType): RangeRole {
  if (index === DATA_RANGE) return 'filter';
  if (index === OLD_GROUP) return 'group';
  if (isDefinitely(type, 'boolean')) return 'filter';
  return type.kind === 'uncertain' && mayBe(type, 'boolean') ? 'auto' : 'group';
}

interface RangeArg {
  readonly node: ExprNode;
  readonly role: RangeRole;
}

function rangeArgs(call: FunctionCall): RangeArg[] {
  return call.rawArgs
    .slice(DATA_RANGE)
    .map((node, offset) => ({ node, role: rangeRole(DATA_RANGE + offset, call.inferType(node)) }));
}

interface Entry {
  /** 参与排名的分数；不参与（不满足条件、排序字段为空或不是数值）时为 undefined。 */
  readonly score?: number;
  /** 各分组参数（第 4 参数；第 5 参数为分组或按实际值时）的取值，顺序与参数一致。 */
  readonly groups: readonly ExprValue[];
}

/** 一个排名调用在一个总体上的排名表：一次求出全体成员的分数与分组取值，各对象查表得名次。 */
export interface RankingTable {
  readonly population: readonly SubjectReader[];
  readonly entries: ReadonlyMap<string, Entry>;
  /** 参与者（分数已定）。 */
  readonly participants: readonly Entry[];
  /** 每个分组参数一张候选索引：入口键 → 参与者下标（见 operators.ts equalityStoreKeys）。 */
  readonly indexes: readonly ReadonlyMap<string, readonly number[]>[];
  /** 参与者里有空的分组取值：emptyInEquality = fail 时改为逐对象、逐列短路比较（见 peerScores）。 */
  readonly hasEmptyGroup: boolean;
  /** 本人分组取值的编码 → 同组分数（降序）。 */
  readonly peers: Map<string, readonly number[]>;
}

/**
 * 排名表缓存：调用节点 → 语义键（参数引用的 Def 变量取值）→ 排名表。只在“同一总体、同一计算上下文”内共用：
 * evaluateBatch 为每个计算项目新建一份；总体换了（数组不是同一个）时重建。
 */
export type RankingTables = Map<CallNode, Map<string, RankingTable>>;

/**
 * 每个调用最多缓存的排名表数：参数引用的本人 Def 取值很分散时（如每人一个值）每个取值各建一张表，
 * 时间仍是人数平方级；限制张数只为不让内存随人数平方增长（超出时丢弃最早的表）。
 */
const MAX_TABLES_PER_CALL = 64;

function tryEvaluate(call: FunctionCall, node: ExprNode, subject: SubjectReader): ExprValue | undefined {
  try {
    return call.evaluateForSubject(node, subject);
  } catch {
    return undefined;
  }
}

const isBlank = (value: ExprValue) => value.kind === 'empty' || (value.kind === 'text' && value.value === '');

/** 排序字段的数值：数值、按选项值的单选；其余（文本、日期、是否）不能排名。 */
function scoreOf(value: ExprValue): number | undefined {
  const score = value.kind === 'number' ? value.value : value.kind === 'option' ? Number(value.value) : Number.NaN;
  return Number.isFinite(score) ? score : undefined;
}

/**
 * 成员在一个范围参数上：undefined 表示不满足，null 表示过滤通过，其余为分组取值。
 * 条件求值出错（含 DEC-270 的文本年度比较）视为不满足；分组取值出错按空值分组（旧实现口径）。
 */
function rangeValue(arg: RangeArg, value: ExprValue | undefined): ExprValue | null | undefined {
  if (arg.role === 'filter') return value?.kind === 'boolean' && value.value ? null : undefined;
  if (arg.role === 'group') return value ?? EMPTY;
  if (!value || value.kind === 'empty' || (value.kind === 'boolean' && !value.value)) return undefined;
  return value;
}

function entryOf(call: FunctionCall, ranges: readonly RangeArg[], subject: SubjectReader): Entry {
  const groups: ExprValue[] = [];
  for (const arg of ranges) {
    const value = rangeValue(arg, tryEvaluate(call, arg.node, subject));
    if (value === undefined) return { groups: [] };
    if (value !== null) groups.push(value);
  }
  const sortValue = tryEvaluate(call, call.rawArgs[1]!, subject);
  return { score: sortValue ? scoreOf(sortValue) : undefined, groups };
}

function buildTable(call: FunctionCall, population: readonly SubjectReader[]): RankingTable {
  const ranges = rangeArgs(call);
  const semantics = call.env.semantics;
  const entries = new Map(population.map((subject) => [subject.id, entryOf(call, ranges, subject)]));
  const participants = [...entries.values()].filter((entry) => entry.score !== undefined);
  const columns = ranges.filter((arg) => arg.role !== 'filter').length;
  const indexes = Array.from({ length: columns }, () => new Map<string, number[]>());
  participants.forEach((entry, i) => {
    entry.groups.forEach((value, column) => {
      for (const key of equalityStoreKeys(value, semantics)) {
        const list = indexes[column]!.get(key);
        if (list) list.push(i);
        else indexes[column]!.set(key, [i]);
      }
    });
  });
  const hasEmptyGroup = participants.some((entry) => entry.groups.some((value) => value.kind === 'empty'));
  return { population, entries, participants, indexes, hasEmptyGroup, peers: new Map() };
}

/** 本人在一个分组参数上的候选参与者：可能与本人取值相等的入口并集（再由 valuesEqual 复核）。 */
function candidates(call: FunctionCall, table: RankingTable, column: number, value: ExprValue): readonly number[] {
  const keys = equalityLookupKeys(value, call.env.semantics);
  const index = table.indexes[column]!;
  if (keys.length === 1) return index.get(keys[0]!) ?? [];
  return [...new Set(keys.flatMap((key) => index.get(key) ?? []))];
}

/**
 * 与本人同组的参与者分数（降序）：各分组参数逐个按 valuesEqual 与本人取值相等，与旧实现逐一比较完全一致
 * （= 不传递时每人按自己的取值找同组）。候选取各参数里最少的一列，再逐个复核全部参数。
 * emptyInEquality = fail 且有空的分组取值时，不用候选索引：对全体参与者逐对象、逐列短路比较（前面的列已不相等
 * 就不再比后面的列），比到空值那一列才由 valuesEqual 报 EMPTY_IN_COMPARISON，与旧实现一致。
 */
function peerScores(call: FunctionCall, table: RankingTable, me: Entry): readonly number[] {
  const semantics = call.env.semantics;
  const key = JSON.stringify(me.groups.map(encodeValue));
  let scores = table.peers.get(key);
  if (scores) return scores;
  const hasEmpty = table.hasEmptyGroup || me.groups.some((value) => value.kind === 'empty');
  let pool: readonly number[] | undefined;
  if (!(semantics.emptyInEquality === 'fail' && hasEmpty)) {
    me.groups.forEach((value, column) => {
      const found = candidates(call, table, column, value);
      if (!pool || found.length < pool.length) pool = found;
    });
  }
  const members = pool ? pool.map((i) => table.participants[i]!) : table.participants;
  scores = members
    .filter((entry) => entry.groups.every((value, column) => valuesEqual(value, me.groups[column]!, semantics)))
    .map((entry) => entry.score!)
    .sort((a, b) => b - a);
  table.peers.set(key, scores);
  return scores;
}

/** 数值的无歧义写法：区分 -0、Infinity、-Infinity、NaN（JSON 会把后三者都写成 null）。 */
function numberText(value: number): string {
  return Object.is(value, -0) ? '-0' : String(value);
}

/** 日期各分量逐个用 numberText（加减年 / 月溢出时分量可能是 ±∞ 或 NaN，JSON 会都写成 null）。 */
function dateText(parts: DateParts): string {
  const numbers = [parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second];
  return `${numbers.map(numberText).join(',')}:${parts.precision}`;
}

/** 取值的无碰撞编码（带类型标记）：编码相同则取值完全相同。 */
function encodeValue(value: ExprValue): string {
  switch (value.kind) {
    case 'empty':
      return `e:${value.of ?? ''}`;
    case 'number':
      return `n:${numberText(value.value)}`;
    case 'text':
      return `t:${JSON.stringify(value.value)}`;
    case 'boolean':
      return `b:${value.value}`;
    case 'date':
      return `d:${dateText(value.value)}`;
    case 'option': {
      const raw = typeof value.value === 'number' ? `n:${numberText(value.value)}` : `t:${JSON.stringify(value.value)}`;
      return `o:${raw}:${JSON.stringify(value.label ?? null)}`;
    }
  }
}

/**
 * 语义键：排序字段与范围参数里引用的 Def 变量取值（这些变量按本人作用域求值，取值相同则排名表相同）。
 * 裸词若不是变量，按成员各自的字段读取，与本人无关；模式参数不影响排名表。取值用无碰撞编码（含非有限数）。
 */
function semanticKey(call: FunctionCall): string {
  const names = new Set<string>();
  for (const arg of call.rawArgs.slice(1)) {
    walk(arg, (node) => {
      if (node.type === 'identifier') names.add(node.name);
    });
  }
  const bound = [...names].sort().flatMap((name) => {
    const value = call.variable(name);
    return value === undefined ? [] : [name, encodeValue(value)];
  });
  return JSON.stringify(bound);
}

function tableFor(call: FunctionCall, population: readonly SubjectReader[]): RankingTable {
  const tables = call.env.rankingTables;
  if (!tables) return buildTable(call, population);
  let byKey = tables.get(call.node);
  if (!byKey) tables.set(call.node, (byKey = new Map()));
  const key = semanticKey(call);
  const cached = byKey.get(key);
  if (cached?.population === population) return cached;
  const table = buildTable(call, population);
  byKey.delete(key);
  if (byKey.size >= MAX_TABLES_PER_CALL) byKey.delete(byKey.keys().next().value!);
  byKey.set(key, table);
  return table;
}

/** 降序数组中严格大于 score 的个数（二分）。 */
function countGreater(descending: readonly number[], score: number): number {
  let low = 0;
  let high = descending.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (descending[mid]! > score) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** 名次 ÷ 人数 × 100，按整数运算四舍五入到两位小数，避免浮点尾差（33.33、66.67、3.125 → 3.13）。 */
function percentile(rank: number, participants: number): number {
  const hundredths = Math.floor((2 * rank * 10000 + participants) / (2 * participants));
  return hundredths / 100;
}

/**
 * 本人不参与排名时的结果：范围条件里出现类型转换失败（DEC-270：盘点活动.盘点年度 > "2025"）→ 空；
 * 不满足范围 → OUT_OF_SCOPE（DEC-299 Q2）；排序字段为空 → 空（DEC-302）；
 * 排序字段取值出错（如无权读取）→ 原失败原因；不是数值 → TYPE_CONVERSION。
 */
function ownResult(call: FunctionCall, self: SubjectReader): ExprValue {
  for (const arg of rangeArgs(call)) {
    if (arg.role === 'group') continue;
    let value: ExprValue | undefined;
    try {
      value = call.evaluateForSubject(arg.node, self);
    } catch (error) {
      if (isTypeConversion(error)) return EMPTY;
    }
    if (rangeValue(arg, value) === undefined) return call.fail('OUT_OF_SCOPE', '本人不满足人员范围条件');
  }
  const sortValue = call.evaluateForSubject(call.rawArgs[1]!, self);
  if (isBlank(sortValue)) return EMPTY;
  return call.fail('TYPE_CONVERSION', `${CONVERSION_MESSAGE}（排序字段不是数值，无法排名）`);
}

function ranking(call: FunctionCall): ExprValue {
  const mode = modeOf(call.textArg([call.evaluate(call.rawArgs[0]!)], 0));
  if (!mode) return call.fail('ARGUMENT_TYPE', '排名模式须是 "百分位" 或 "排序号"');
  if (!isReference(call.rawArgs[1]!)) return call.fail('ARGUMENT_TYPE', '排序字段须是字段引用');
  const population = unwrapPort(call, 'ranking', () => call.env.ports?.ranking?.population());
  const table = tableFor(call, population);
  const me = table.entries.get(call.env.subjectId);
  if (!me) return call.fail('OUT_OF_SCOPE', '本人不在本次计算的人员范围内');
  if (me.score === undefined) {
    return ownResult(
      call,
      population.find((subject) => subject.id === call.env.subjectId)!,
    );
  }
  const scores = peerScores(call, table, me);
  const rank = countGreater(scores, me.score) + 1;
  return { kind: 'number', value: mode === 'rank' ? rank : percentile(rank, scores.length) };
}

function checkMode(node: ExprNode | undefined, infer: (node: ExprNode) => InferredType): ArgumentIssue[] {
  if (!node) return [];
  if (node.type === 'string') {
    return modeOf(node.value) ? [] : [{ severity: 'error', message: '排名模式须是 "百分位" 或 "排序号"' }];
  }
  const verdict = verdictFor(infer(node), 'text');
  if (verdict === 'ok') return [];
  return [{ severity: verdict === 'mismatch' ? 'error' : 'warning', message: '第1个参数应为 "百分位" 或 "排序号"' }];
}

function checkSortField(node: ExprNode | undefined, infer: (node: ExprNode) => InferredType): ArgumentIssue[] {
  if (!node) return [];
  if (!isReference(node)) return [{ severity: 'error', message: '第2个参数（排序字段）须是字段引用' }];
  const type = infer(node);
  if (isDefinitely(type, 'date') || isDefinitely(type, 'boolean')) {
    return [{ severity: 'error', message: '第2个参数（排序字段）应为数值字段' }];
  }
  if (isDefinitely(type, 'number')) return [];
  return [{ severity: 'warning', message: '第2个参数（排序字段）类型不确定（应为数值），非数值的对象不参与排名' }];
}

/** 范围参数：第 3 参数须是条件；第 4 参数任何类型都可分组；第 5 参数是否型 = 条件、字段引用 = 分组；不确定一律提示。 */
function checkRange(index: number, node: ExprNode, type: InferredType): ArgumentIssue[] {
  const position = `第${index + 1}个参数`;
  if (index === DATA_RANGE) {
    const verdict = verdictFor(type, 'boolean');
    if (verdict === 'ok') return [];
    return verdict === 'mismatch'
      ? [{ severity: 'error', message: `${position}（数据范围）应为条件表达式` }]
      : [
          {
            severity: 'warning',
            message: `${position}（数据范围）类型不确定（应为条件），计算时不为“是”的对象不在范围内`,
          },
        ];
  }
  if (type.kind === 'uncertain') {
    const effect = rangeRole(index, type) === 'auto' ? '为“否”或空的对象不在范围内，其余按取值分组' : '按取值分组';
    return [{ severity: 'warning', message: `${position}类型不确定，计算时${effect}` }];
  }
  if (index === NEW_RANGE && !isDefinitely(type, 'boolean') && !isReference(node)) {
    return [{ severity: 'error', message: `${position}应为条件表达式或字段引用` }];
  }
  return [];
}

/** 保存检查（DEC-287：只认统一类型推导；确定不符报错，不确定提示）。 */
function checkRankingArgs(args: readonly ExprNode[], infer: (node: ExprNode) => InferredType): ArgumentIssue[] {
  return [
    ...checkMode(args[0], infer),
    ...checkSortField(args[1], infer),
    ...args.slice(DATA_RANGE).flatMap((node, offset) => checkRange(DATA_RANGE + offset, node, infer(node))),
  ];
}

export const RANKING_FUNCTIONS: readonly FunctionSpec[] = [
  {
    name: 'Ranking',
    aliases: ['获取某个结果在指定人员范围内的排名', '排名'],
    params: [
      { name: '模式', required: true, description: '"百分位" 或 "排序号"' },
      { name: '排序字段', required: true },
      { name: '数据范围', required: false, description: '过滤条件（含是否型字段）' },
      { name: '排名范围条件', required: false, description: '按取值分组（旧第 4 参数语义）' },
      { name: '排名范围条件', required: false, description: '是否型 = 过滤条件，其余 = 按取值分组' },
    ],
    lazy: true,
    skipInTodoTrigger: true,
    returns: 'number',
    checkArgs: checkRankingArgs,
    implement: ranking,
  },
];
