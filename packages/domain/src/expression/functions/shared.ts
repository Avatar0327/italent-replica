/**
 * 取数函数共用：端口结果 → 失败原因；记录字段按对象前缀展开成完整路径；时间窗划界。
 */
import { walk, type ExprNode, type FieldNode } from '../ast.js';
import type { FunctionCall } from '../registry.js';
import type { PortOutcome } from '../ports.js';
import { EMPTY, type ExprValue, type PlainValue } from '../values.js';

export const PORT_LABELS = {
  performance: '绩效（考核结果）',
  survey360: '360 结果',
  assessment: '测验结果',
  review: '评定结果',
  ranking: '排名范围',
  talentReview: '人才评定',
  personnelSubset: '人事子集',
  parameterRule: '参数规则',
} as const;

/** 调端口并解包：端口是使用方代码，抛出的异常转成不透出内容的失败原因（astra 首审 P2-5）。 */
export function unwrapPort<T>(
  call: FunctionCall,
  name: keyof typeof PORT_LABELS,
  read: () => PortOutcome<T> | undefined,
): T {
  let outcome: PortOutcome<T> | undefined;
  try {
    outcome = read();
  } catch {
    return call.fail('DATA_UNAVAILABLE', `${PORT_LABELS[name]}数据源读取出错`);
  }
  if (!outcome) return call.fail('DATA_UNAVAILABLE', `${PORT_LABELS[name]}数据源未接入`);
  if (outcome.ok) return outcome.data;
  if (outcome.reason === 'forbidden') return call.fail('DATA_FORBIDDEN', `当前查看人无权读取${PORT_LABELS[name]}`);
  return call.fail('DATA_UNAVAILABLE', `${PORT_LABELS[name]}数据源暂不可用`);
}

/** 记录字段 → 带对象前缀的完整路径（可同时登记多个前缀，如 测验信息 / 测验结果）。 */
export function prefixedFields(
  call: FunctionCall,
  prefixes: readonly string[],
  fields: Readonly<Record<string, PlainValue>>,
): Record<string, ExprValue> {
  const record: Record<string, ExprValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    const converted = call.env.fromPlain(value);
    for (const prefix of prefixes) record[`${prefix}.${key}`] = converted;
  }
  return record;
}

/**
 * 记录作用域读取器：参数里引用到、但某一行没有的记录字段按空值处理（子集行的字段是稀疏的），
 * 不回落去读被计算对象的同名字段。
 */
export function recordReader(
  call: FunctionCall,
  prefixes: readonly string[],
  nodes: readonly (ExprNode | undefined)[],
): (fields: Readonly<Record<string, PlainValue>>) => Record<string, ExprValue> {
  const referenced = new Set<string>();
  for (const node of nodes) {
    if (!node) continue;
    walk(node, (child) => {
      if (child.type === 'field' && prefixes.includes(child.path[0]!)) referenced.add(child.text);
    });
  }
  return (fields) => {
    const record = prefixedFields(call, prefixes, fields);
    for (const path of referenced) if (!Object.hasOwn(record, path)) record[path] = EMPTY;
    return record;
  };
}

/** 过滤表达式逐条在记录作用域求值，全部为真才保留。 */
export function matchesAll(
  call: FunctionCall,
  filters: readonly ExprNode[],
  record: Readonly<Record<string, ExprValue>>,
): boolean {
  return filters.every((filter) => call.toBoolean(call.evaluate(filter, record)));
}

/** 必须是指定对象的字段引用（如 360结果.角色得分）。 */
export function requireFieldOf(
  call: FunctionCall,
  node: ExprNode | undefined,
  prefixes: readonly string[],
  label: string,
): FieldNode {
  if (node?.type === 'field' && prefixes.includes(node.path[0]!)) return node;
  return call.fail('ARGUMENT_TYPE', `${label}须是 ${prefixes.join(' / ')} 的字段引用`);
}

/**
 * “最近一次”的时间上界：360 固定为盘点项目结束时间（活动结束时间不晚于它，DEC-262②）；测评按 DEC-031 的口径参数
 * 可选结束 / 开始时间。没有项目时间则不设上界。
 */
export function latestBoundary(call: FunctionCall, source: 'survey360' | 'assessment'): Date | undefined {
  const { project, assessmentLatestWindow } = call.env;
  if (source === 'assessment' && assessmentLatestWindow === 'before_project_start') return project?.startAt;
  return project?.endAt;
}

export function withinBoundary(at: Date, boundary: Date | undefined): boolean {
  return boundary === undefined || at.getTime() <= boundary.getTime();
}

export function average(values: readonly number[]): ExprValue {
  if (values.length === 0) return EMPTY;
  return { kind: 'number', value: values.reduce((sum, value) => sum + value, 0) / values.length };
}
