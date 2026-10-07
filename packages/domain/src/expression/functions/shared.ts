/**
 * 取数函数共用：端口结果 → 失败原因；记录字段按对象前缀展开成完整路径；时间窗划界。
 */
import type { ExprNode, FieldNode } from '../ast.js';
import type { FunctionCall } from '../registry.js';
import type { PortOutcome } from '../ports.js';
import type { ExprValue, PlainValue } from '../values.js';

export const PORT_LABELS = {
  performance: '绩效（考核结果）',
  survey360: '360 结果',
  assessment: '测验结果',
  review: '评定结果',
  ranking: '排名范围',
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
 * “最近一次”的时间上界：360 固定为盘点项目结束时间（`26` §3.5 TR-R28）；测评按 DEC-031 的口径参数
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
  if (values.length === 0) return { kind: 'empty' };
  return { kind: 'number', value: values.reduce((sum, value) => sum + value, 0) / values.length };
}
