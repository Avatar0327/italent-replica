/**
 * 排名（`26` §3.5 TR-R28、§8.6、§8.10；手册 246809263）：
 * Ranking(模式, 排序字段, 数据范围?, 排名范围条件?, 排名范围条件?)。原站 5 参中第 3、4 参必填，复刻兼容 2～4 参旧写法，
 * 缺省的范围参数 = 不限定（映射见 F-045 PR 描述）。
 * 口径照原站实测（DEC-302，坐实 DEC-262①）：
 * - 排序字段降序；并列为竞争排名（1、1、3）；
 * - 百分位 = 名次 ÷ 参与人数 × 100，保留两位小数（四舍五入），名次越前越小；
 * - 排序字段为空（含空字符串）的对象不参与、不计数，自身结果为空（不是计算失败）；
 * - 第 3～5 参数统一为范围：字段引用 = 与本人取值相同的人员（本租户第 4 参 盘点对象.盘点方案 的用法），
 *   其他表达式 = 条件，须为真（如 盘点活动.项目名称 = "…" 把范围限定到单个项目）。
 * 人员总体由调用方经 RankingPort 传入（批量求值默认本次计算对象），函数内不做权限裁剪、不决定取数身份；
 * 排名在全体总体上一次性求值（DEC-301②）：同一计算项目内排名表只算一次，所有对象共用。
 * 面板原文“在待办中触发计算时，包含这个函数的计算项目不会计算”（DEC-260）：以 skipInTodoTrigger 标记，调度由 R3-T04 落实。
 */
import { walk, type CallNode, type ExprNode } from '../ast.js';
import { CONVERSION_MESSAGE } from '../failures.js';
import { valuesEqual } from '../operators.js';
import type { SubjectReader } from '../ports.js';
import type { ArgumentIssue, FunctionCall, FunctionSpec } from '../registry.js';
import { isDefinitely, verdictFor, type InferredType } from '../typing.js';
import { EMPTY, type ExprValue } from '../values.js';
import { isTypeConversion, unwrapPort } from './shared.js';

const MODES: Readonly<Record<string, 'rank' | 'percentile'>> = {
  排序号: 'rank',
  排名: 'rank',
  rank: 'rank',
  百分位: 'percentile',
  percentile: 'percentile',
};

const modeOf = (text: string) => MODES[text.trim().toLowerCase()];

/** 第 3 个参数起为范围参数（数据范围、排名范围条件 ×2）。 */
const FIRST_RANGE = 2;

/** 字段引用（含裸词）：作“与本人同值”的范围；其余表达式作条件。 */
const isReference = (node: ExprNode) => node.type === 'field' || node.type === 'identifier';

interface Entry {
  /** 参与排名的分数；不参与（不满足条件、排序字段为空或不是数值）时为 undefined。 */
  readonly score?: number;
  /** 各“同值”范围参数的取值，与 RankingTable.peerArgs 一一对应。 */
  readonly peers: readonly ExprValue[];
}

interface Bucket {
  readonly peers: readonly ExprValue[];
  readonly scores: number[];
}

/** 一个排名调用在一个总体上的排名表：一次求出全体成员的分数与同值范围，各对象查表得名次。 */
export interface RankingTable {
  readonly population: readonly SubjectReader[];
  readonly entries: ReadonlyMap<string, Entry>;
  /** 参与者按同值范围取值分桶（键见 peerKey）：查组时只比较各桶的代表取值，不逐人比较。 */
  readonly buckets: ReadonlyMap<string, Bucket>;
  /** 按本人的同值范围取值缓存同组分数（降序）。 */
  readonly groups: Map<string, readonly number[]>;
}

/**
 * 排名表缓存（按调用节点）：只在“同一总体、同一计算上下文”内共用。evaluateBatch 为每个计算项目新建一份；
 * 总体换了（数组不是同一个）时重建。
 */
export type RankingTables = Map<CallNode, RankingTable>;

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

function rangeArgs(call: FunctionCall) {
  const ranges = call.rawArgs.slice(FIRST_RANGE);
  return { conditions: ranges.filter((node) => !isReference(node)), peers: ranges.filter(isReference) };
}

/** 成员表项：条件求值出错（含 DEC-270 的文本年度比较）视为不满足；同值范围取不到按空值。 */
function entryOf(call: FunctionCall, subject: SubjectReader): Entry {
  const { conditions, peers } = rangeArgs(call);
  const peerValues = peers.map((node) => tryEvaluate(call, node, subject) ?? EMPTY);
  const inRange = conditions.every((node) => {
    const value = tryEvaluate(call, node, subject);
    return value?.kind === 'boolean' && value.value;
  });
  if (!inRange) return { peers: peerValues };
  const sortValue = tryEvaluate(call, call.rawArgs[1]!, subject);
  return { score: sortValue ? scoreOf(sortValue) : undefined, peers: peerValues };
}

function buildTable(call: FunctionCall, population: readonly SubjectReader[]): RankingTable {
  const entries = new Map(population.map((subject) => [subject.id, entryOf(call, subject)]));
  const buckets = new Map<string, Bucket>();
  for (const entry of entries.values()) {
    if (entry.score === undefined) continue;
    const key = peerKey(entry.peers);
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = { peers: entry.peers, scores: [] }));
    bucket.scores.push(entry.score);
  }
  return { population, entries, buckets, groups: new Map() };
}

/** 范围参数里有裸词（可能是 Def 变量，按本人作用域取值）时各对象的排名表不同，不共用。 */
function dependsOnSelf(call: FunctionCall): boolean {
  let found = false;
  for (const arg of call.rawArgs) {
    walk(arg, (node) => {
      if (node.type === 'identifier') found = true;
    });
  }
  return found;
}

function tableFor(call: FunctionCall, population: readonly SubjectReader[]): RankingTable {
  const tables = call.env.rankingTables;
  if (!tables || dependsOnSelf(call)) return buildTable(call, population);
  const cached = tables.get(call.node);
  if (cached?.population === population) return cached;
  const table = buildTable(call, population);
  tables.set(call.node, table);
  return table;
}

/** 同值范围的取值键：键相同则取值相同、同组成员相同（单选只看选项值，与 = 比较一致）。 */
function peerKey(values: readonly ExprValue[]): string {
  return JSON.stringify(
    values.map((value) => (value.kind === 'empty' ? ['empty'] : ([value.kind, value.value] as const))),
  );
}

/** 与本人同组（同值范围逐个相等）的参与者分数，降序。 */
function groupScores(call: FunctionCall, table: RankingTable, me: Entry): readonly number[] {
  const key = peerKey(me.peers);
  let scores = table.groups.get(key);
  if (!scores) {
    const semantics = call.env.semantics;
    // 逐桶按 = 的口径比较（"2026" 与 2026 相等等宽松比较不一定与键一致）
    scores = [...table.buckets.values()]
      .filter((bucket) => bucket.peers.every((value, i) => valuesEqual(value, me.peers[i]!, semantics)))
      .flatMap((bucket) => bucket.scores)
      .sort((a, b) => b - a);
    table.groups.set(key, scores);
  }
  return scores;
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
  for (const node of rangeArgs(call).conditions) {
    let value: ExprValue;
    try {
      value = call.evaluateForSubject(node, self);
    } catch (error) {
      if (isTypeConversion(error)) return EMPTY;
      return call.fail('OUT_OF_SCOPE', '本人不满足人员范围条件');
    }
    if (value.kind !== 'boolean' || !value.value) return call.fail('OUT_OF_SCOPE', '本人不满足人员范围条件');
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
  const scores = groupScores(call, table, me);
  const rank = countGreater(scores, me.score) + 1;
  return { kind: 'number', value: mode === 'rank' ? rank : percentile(rank, scores.length) };
}

/** 保存检查（DEC-287：只认统一类型推导；确定不符报错，不确定提示）。 */
function checkRankingArgs(args: readonly ExprNode[], infer: (node: ExprNode) => InferredType): ArgumentIssue[] {
  const issues: ArgumentIssue[] = [];
  const [modeArg, sortArg] = args;
  if (modeArg?.type === 'string') {
    if (!modeOf(modeArg.value)) issues.push({ severity: 'error', message: '排名模式须是 "百分位" 或 "排序号"' });
  } else if (modeArg) {
    const verdict = verdictFor(infer(modeArg), 'text');
    if (verdict !== 'ok') {
      const severity = verdict === 'mismatch' ? 'error' : 'warning';
      issues.push({ severity, message: '第1个参数应为 "百分位" 或 "排序号"' });
    }
  }
  if (sortArg && !isReference(sortArg)) {
    issues.push({ severity: 'error', message: '第2个参数（排序字段）须是字段引用' });
  } else if (sortArg) {
    const type = infer(sortArg);
    if (isDefinitely(type, 'date') || isDefinitely(type, 'boolean')) {
      issues.push({ severity: 'error', message: '第2个参数（排序字段）应为数值字段' });
    } else if (!isDefinitely(type, 'number')) {
      issues.push({
        severity: 'warning',
        message: '第2个参数（排序字段）类型不确定（应为数值），非数值的对象不参与排名',
      });
    }
  }
  args.slice(FIRST_RANGE).forEach((node, offset) => {
    if (isReference(node)) return;
    const verdict = verdictFor(infer(node), 'boolean');
    if (verdict === 'ok') return;
    const position = `第${FIRST_RANGE + offset + 1}个参数`;
    issues.push(
      verdict === 'mismatch'
        ? { severity: 'error', message: `${position}应为条件表达式或字段引用` }
        : { severity: 'warning', message: `${position}类型不确定（应为条件表达式），计算时不为真的对象不在范围内` },
    );
  });
  return issues;
}

export const RANKING_FUNCTIONS: readonly FunctionSpec[] = [
  {
    name: 'Ranking',
    aliases: ['获取某个结果在指定人员范围内的排名', '排名'],
    params: [
      { name: '模式', required: true, description: '"百分位" 或 "排序号"' },
      { name: '排序字段', required: true },
      { name: '数据范围', required: false, description: '条件，或字段引用（与本人同值）' },
      { name: '排名范围条件', required: false, description: '条件，或字段引用（与本人同值）' },
      { name: '排名范围条件', required: false, description: '条件，或字段引用（与本人同值）' },
    ],
    lazy: true,
    skipInTodoTrigger: true,
    returns: 'number',
    checkArgs: checkRankingArgs,
    implement: ranking,
  },
];
